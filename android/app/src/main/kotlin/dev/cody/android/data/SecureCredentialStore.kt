package dev.cody.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.cody.shared.backend.CredentialStore
import dev.cody.shared.backend.StoredCredentials
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

private val Context.credentialPreferences: DataStore<Preferences> by preferencesDataStore(
    name = "cody-credentials",
)

/**
 * The token at rest: DataStore for storage, Android Keystore for secrecy.
 *
 * The token is a long-lived credential to a machine that can run shell commands,
 * so it is encrypted with a hardware-backed AES-GCM key that never leaves the
 * Keystore. Plain DataStore would leave it readable on a rooted device or in an
 * `adb backup`; the base URL is stored in the clear because it is not a secret
 * and being able to see it is useful when something is misconfigured.
 *
 * `androidx.security:security-crypto` (EncryptedSharedPreferences) would have
 * been the obvious choice and is deliberately not used: it has been in alpha for
 * years and is now deprecated. This is ~40 lines of platform API with no
 * dependency and no deprecation to inherit.
 */
class SecureCredentialStore(context: Context) : CredentialStore {

    private val preferences = context.credentialPreferences

    override val current: Flow<StoredCredentials?> = preferences.data
        .map { stored ->
            val baseUrl = stored[BASE_URL] ?: return@map null
            val sealed = stored[TOKEN] ?: return@map null
            val token = decrypt(sealed) ?: run {
                // The key is gone — a restore onto a new device, or a factory
                // reset of the Keystore. The ciphertext is now permanently
                // undecryptable, so drop it and let onboarding run rather than
                // failing every request with a token we cannot read.
                Log.w(TAG, "stored token could not be decrypted; clearing it")
                clear()
                return@map null
            }
            StoredCredentials(baseUrl = baseUrl, token = token)
        }
        // KeyStore and Cipher calls are blocking, and this flow is collected from
        // composition.
        .flowOn(Dispatchers.IO)

    override suspend fun save(credentials: StoredCredentials) {
        val sealed = withContext(Dispatchers.IO) { encrypt(credentials.token) }
        preferences.edit { entries ->
            entries[BASE_URL] = credentials.baseUrl
            entries[TOKEN] = sealed
        }
    }

    override suspend fun clear() {
        preferences.edit { it.clear() }
    }

    private fun encrypt(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ciphertext = cipher.doFinal(plaintext.encodeToByteArray())
        // GCM generates a fresh IV per encryption; it is not secret and is
        // prefixed so decryption needs nothing but this one string.
        return Base64.getEncoder().encodeToString(cipher.iv + ciphertext)
    }

    private fun decrypt(sealed: String): String? = runCatching {
        val raw = Base64.getDecoder().decode(sealed)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES),
        )
        cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES).decodeToString()
    }.getOrNull()

    /** The app's Keystore key, generated on first use. */
    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(KEY_BITS)
                // Deliberately NOT setUserAuthenticationRequired: the app must be
                // able to reconnect on launch without a biometric prompt, and the
                // threat model here is offline device access, not a thief holding
                // an unlocked tablet.
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val TAG = "CodyCredentials"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "cody.credential.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_BITS = 256
        const val TAG_BITS = 128
        const val IV_BYTES = 12

        val BASE_URL = stringPreferencesKey("base_url")
        val TOKEN = stringPreferencesKey("token_gcm")
    }
}
