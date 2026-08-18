package dev.cody.shared.presentation

import dev.cody.shared.backend.BackendException
import dev.cody.shared.backend.BackendFailure
import dev.cody.shared.backend.CodyBackend
import dev.cody.shared.model.SessionSummary
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

public data class SessionsState(
    public val sessions: Loadable<List<SessionSummary>> = Loadable.Idle,
    /** Ids with a live engine process; drives the running dot and event watching. */
    public val running: Set<String> = emptySet(),
    public val selectedId: String? = null,
    /** A reload over an already-populated list: shows a bar, not a spinner. */
    public val refreshing: Boolean = false,
)

/** The session list, and which row is open in the detail pane. */
public class SessionsModel(
    private val backend: CodyBackend,
    private val scope: CoroutineScope,
    /** Invoked on a 401 so the app can drop the dead token exactly once. */
    private val onUnauthorized: () -> Unit,
) {
    private val _state = MutableStateFlow(SessionsState())
    public val state: StateFlow<SessionsState> = _state.asStateFlow()

    public fun refresh() {
        val hadRows = _state.value.sessions is Loadable.Ready
        _state.update {
            if (hadRows) it.copy(refreshing = true) else it.copy(sessions = Loadable.Loading)
        }
        scope.launch {
            try {
                val page = backend.listSessions()
                _state.update { current ->
                    current.copy(
                        // Newest first. The server sends ISO-8601 UTC for both
                        // fields, so lexical order IS chronological order and no
                        // date parsing is needed to sort a list this hot.
                        sessions = Loadable.Ready(
                            page.sessions.sortedByDescending { it.modified ?: it.created ?: "" },
                        ),
                        running = page.runningSessionIds.toSet(),
                        refreshing = false,
                    )
                }
            } catch (failure: BackendException) {
                if (failure.failure == BackendFailure.Unauthorized) onUnauthorized()
                _state.update { current ->
                    current.copy(
                        // A failed refresh must not blank a list the user is
                        // reading; only a failed FIRST load becomes an error
                        // state.
                        sessions = if (hadRows) current.sessions else failure.asFailed(),
                        refreshing = false,
                    )
                }
            }
        }
    }

    public fun select(sessionId: String?): Unit = _state.update { it.copy(selectedId = sessionId) }
}
