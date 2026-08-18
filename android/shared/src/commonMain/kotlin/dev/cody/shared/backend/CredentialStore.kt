package dev.cody.shared.backend

import kotlinx.coroutines.flow.Flow

/** A verified server address plus the token that reached it. */
public data class StoredCredentials(
    public val baseUrl: String,
    public val token: String,
)

/**
 * Persistence seam for the credential.
 *
 * An interface in common code with the implementation in `:app` for one reason:
 * keeping a secret at rest is entirely platform business (Android Keystore here,
 * Keychain on iOS, a secret service on desktop) and none of it belongs in code
 * that is meant to port. [current] emits null when there is nothing stored,
 * which is exactly the signal that onboarding is required.
 */
public interface CredentialStore {
    public val current: Flow<StoredCredentials?>

    public suspend fun save(credentials: StoredCredentials)

    /** Called on any 401: the token is dead and must not be retried. */
    public suspend fun clear()
}
