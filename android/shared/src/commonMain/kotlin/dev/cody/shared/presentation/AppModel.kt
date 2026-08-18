package dev.cody.shared.presentation

import dev.cody.shared.backend.BackendException
import dev.cody.shared.backend.BackendFailure
import dev.cody.shared.backend.BackendIdentity
import dev.cody.shared.backend.CodyBackend
import dev.cody.shared.backend.CredentialStore
import dev.cody.shared.backend.RemoteBackend
import dev.cody.shared.backend.ServerConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Which shell the app is showing. */
public sealed interface AppState {
    /** Reading the stored credential; the splash state, normally a few ms. */
    public data object Starting : AppState

    /** No usable credential. The only way out is a successful connection check. */
    public data object Onboarding : AppState

    /**
     * A backend exists and screens may use it. [identity] is loaded separately
     * and may still be [Loadable.Loading] or [Loadable.Failed] — an unreachable
     * server does NOT throw the user back to onboarding, because the address and
     * token are probably fine and the tail-net is not. Only a 401 does that.
     */
    public data class Connected(
        public val backend: CodyBackend,
        public val identity: Loadable<BackendIdentity>,
    ) : AppState
}

/**
 * Owns the backend instance and the credential lifecycle.
 *
 * The one place that decides "are we onboarded", so no screen has to. It watches
 * [CredentialStore] rather than being told, which means a token cleared on a 401
 * from any screen re-routes the whole app with no extra plumbing.
 */
public class AppModel(
    private val scope: CoroutineScope,
    private val credentials: CredentialStore,
    private val backendFactory: (ServerConfig) -> CodyBackend = { RemoteBackend(it) },
) {
    private val _state = MutableStateFlow<AppState>(AppState.Starting)
    public val state: StateFlow<AppState> = _state.asStateFlow()

    private var live: CodyBackend? = null

    init {
        scope.launch {
            credentials.current.collect { stored ->
                // Whatever was open is now stale: a changed credential means a
                // different identity, and Ktor clients hold connection pools.
                live?.close()
                live = null

                if (stored == null) {
                    _state.value = AppState.Onboarding
                    return@collect
                }

                val backend = backendFactory(ServerConfig(stored.baseUrl, stored.token))
                live = backend
                _state.value = AppState.Connected(backend, Loadable.Loading)
                identify(backend)
            }
        }
    }

    /** Re-runs the identity/capability probe, e.g. after the network returns. */
    public fun refreshIdentity() {
        val backend = live ?: return
        _state.value = AppState.Connected(backend, Loadable.Loading)
        scope.launch { identify(backend) }
    }

    /** Forgets the credential. Also the 401 path: the token is dead either way. */
    public fun signOut() {
        scope.launch { credentials.clear() }
    }

    private suspend fun identify(backend: CodyBackend) {
        val next = try {
            Loadable.Ready(backend.identify())
        } catch (failure: BackendException) {
            if (failure.failure == BackendFailure.Unauthorized) {
                // Dead token: drop it, and the credential flow above routes to
                // onboarding on the next emission.
                credentials.clear()
                return
            }
            failure.asFailed()
        }
        // Ignore a probe that finished after the credential changed under it.
        if (live === backend) _state.value = AppState.Connected(backend, next)
    }
}
