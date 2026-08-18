package dev.cody.shared.presentation

import dev.cody.shared.backend.BackendException
import dev.cody.shared.backend.BackendFailure
import dev.cody.shared.backend.CodyAuth
import dev.cody.shared.backend.CodyBackend
import dev.cody.shared.backend.CredentialStore
import dev.cody.shared.backend.RemoteBackend
import dev.cody.shared.backend.ServerConfig
import dev.cody.shared.backend.StoredCredentials
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** How the user is supplying the credential. */
public enum class OnboardingMode {
    /** Paste a token minted elsewhere. */
    PasteToken,

    /** Sign in with username + password and let the app mint its own token. */
    SignIn,
}

/** Why a connection attempt did not succeed. */
public sealed interface OnboardingFailure {
    /** The address could not be read as an origin at all. */
    public data object UnusableAddress : OnboardingFailure

    /** The token field was empty. */
    public data object MissingToken : OnboardingFailure

    /** Username or password field was empty. */
    public data object MissingCredentials : OnboardingFailure

    /** The server answered, or failed to. */
    public data class Rejected(
        public val failure: BackendFailure,
        public val code: String? = null,
    ) : OnboardingFailure
}

public data class OnboardingState(
    public val address: String = "",
    public val token: String = "",
    public val username: String = "",
    public val password: String = "",
    public val mode: OnboardingMode = OnboardingMode.SignIn,
    public val checking: Boolean = false,
    public val failure: OnboardingFailure? = null,
)

/**
 * Server address plus credential, verified before it is stored.
 *
 * Nothing is persisted until `GET /api/accounts/me` has actually answered 200
 * with that exact token against that exact address. Storing first and
 * discovering later is how an app ends up permanently stuck on a screen it
 * cannot leave.
 */
public class OnboardingModel(
    private val scope: CoroutineScope,
    private val credentials: CredentialStore,
    /** Name the minted token carries in the account's token list. */
    private val deviceName: String,
    private val backendFactory: (ServerConfig) -> CodyBackend = { RemoteBackend(it) },
    private val authFactory: (String) -> CodyAuth = { CodyAuth(it) },
) {
    private val _state = MutableStateFlow(OnboardingState())
    public val state: StateFlow<OnboardingState> = _state.asStateFlow()

    public fun setAddress(value: String): Unit = _state.update { it.copy(address = value, failure = null) }

    public fun setToken(value: String): Unit = _state.update { it.copy(token = value, failure = null) }

    public fun setUsername(value: String): Unit = _state.update { it.copy(username = value, failure = null) }

    public fun setPassword(value: String): Unit = _state.update { it.copy(password = value, failure = null) }

    public fun setMode(mode: OnboardingMode): Unit = _state.update { it.copy(mode = mode, failure = null) }

    /**
     * Validates the address, obtains a token if needed, proves it works, and
     * only then persists it. A successful run ends with [CredentialStore.save],
     * which is what moves the app off this screen.
     */
    public fun connect() {
        val snapshot = _state.value
        if (snapshot.checking) return

        val baseUrl = ServerConfig.normalizeBaseUrl(snapshot.address)
        if (baseUrl == null) {
            _state.update { it.copy(failure = OnboardingFailure.UnusableAddress) }
            return
        }
        when (snapshot.mode) {
            OnboardingMode.PasteToken -> if (snapshot.token.isBlank()) {
                _state.update { it.copy(failure = OnboardingFailure.MissingToken) }
                return
            }
            OnboardingMode.SignIn -> if (snapshot.username.isBlank() || snapshot.password.isBlank()) {
                _state.update { it.copy(failure = OnboardingFailure.MissingCredentials) }
                return
            }
        }

        _state.update { it.copy(checking = true, failure = null) }
        scope.launch {
            try {
                val token = when (snapshot.mode) {
                    OnboardingMode.PasteToken -> snapshot.token.trim()
                    OnboardingMode.SignIn -> mint(baseUrl, snapshot)
                }
                verify(baseUrl, token)
                // Password never reaches storage, and is dropped from state the
                // moment it is no longer needed.
                _state.update { it.copy(checking = false, password = "", token = token) }
                credentials.save(StoredCredentials(baseUrl = baseUrl, token = token))
            } catch (failure: BackendException) {
                _state.update {
                    it.copy(
                        checking = false,
                        failure = OnboardingFailure.Rejected(failure.failure, failure.code),
                    )
                }
            }
        }
    }

    private suspend fun mint(baseUrl: String, snapshot: OnboardingState): String {
        val auth = authFactory(baseUrl)
        return try {
            auth.mintToken(
                username = snapshot.username.trim(),
                password = snapshot.password,
                deviceName = deviceName,
            )
        } finally {
            // Takes the cookie jar with it.
            auth.close()
        }
    }

    private suspend fun verify(baseUrl: String, token: String) {
        val backend = backendFactory(ServerConfig(baseUrl, token))
        try {
            backend.identify()
        } finally {
            backend.close()
        }
    }
}
