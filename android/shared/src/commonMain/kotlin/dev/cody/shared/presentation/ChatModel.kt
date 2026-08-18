package dev.cody.shared.presentation

import dev.cody.shared.backend.BackendException
import dev.cody.shared.backend.BackendFailure
import dev.cody.shared.backend.CodyBackend
import dev.cody.shared.model.AgentEvent
import dev.cody.shared.model.ChatMessage
import dev.cody.shared.model.SessionSummary
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * One transcript row: a message plus the stable key it is drawn with.
 *
 * The key is the session file's own entry id, so a `LazyColumn` reuses the right
 * node when the transcript is refetched and rows do not lose their scroll
 * position or animate as if they were new (docs/android-ux.md §6.2).
 */
public data class TranscriptRow(
    public val key: String,
    public val message: ChatMessage,
)

public data class ChatState(
    public val session: SessionSummary? = null,
    public val transcript: Loadable<List<TranscriptRow>> = Loadable.Idle,
    /** An event stream is attached, i.e. the engine is running for this session. */
    public val live: Boolean = false,
    public val sending: Boolean = false,
    /** Last error-level notice from the stream; user-visible, dismissible. */
    public val notice: String? = null,
    public val sendFailure: BackendFailure? = null,
)

/**
 * One session's transcript, plus the prompt composer.
 *
 * Live updates are deliberately COARSE in this phase: an event on the stream
 * marks the session live and schedules a debounced refetch of the transcript,
 rather than mutating messages from frame payloads. Two reasons, both about
 * honesty. The server's `message_update` frames carry the full accumulated
 * message and must REPLACE rather than append, and getting that wrong silently
 * duplicates text; and the rest of the frame vocabulary is not something this
 * client has verified. Refetching is the coarse option that cannot be subtly
 * wrong, and the seam for incremental rendering is already here — it is this
 * class, and nothing above it changes.
 */
public class ChatModel(
    private val backend: CodyBackend,
    private val scope: CoroutineScope,
    private val onUnauthorized: () -> Unit,
) {
    private val _state = MutableStateFlow(ChatState())
    public val state: StateFlow<ChatState> = _state.asStateFlow()

    private var watcher: Job? = null
    private val reloadRequests = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    init {
        scope.launch {
            // collectLatest cancels the previous delay, so a burst of frames
            // collapses into ONE refetch after things go quiet. No FlowPreview
            // debounce operator needed.
            reloadRequests.collectLatest {
                delay(REFETCH_DEBOUNCE_MS)
                load(_state.value.session?.id ?: return@collectLatest, showSpinner = false)
            }
        }
    }

    /**
     * @param isRunning whether the server reported a live engine for this
     *   session. Only then is the event stream opened: subscribing to an idle
     *   session would START an engine (see [CodyBackend.events]).
     * @param liveEventsSupported the backend's capability flag.
     */
    public fun open(session: SessionSummary, isRunning: Boolean, liveEventsSupported: Boolean) {
        watcher?.cancel()
        watcher = null
        _state.value = ChatState(session = session, transcript = Loadable.Loading)
        scope.launch { load(session.id, showSpinner = true) }
        if (isRunning && liveEventsSupported) watch(session.id)
    }

    public fun clear() {
        watcher?.cancel()
        watcher = null
        _state.value = ChatState()
    }

    public fun dismissNotice(): Unit = _state.update { it.copy(notice = null) }

    /** Submits a prompt, then attaches the stream: the send spawns the engine anyway. */
    public fun send(text: String, liveEventsSupported: Boolean) {
        val body = text.trim()
        val sessionId = _state.value.session?.id ?: return
        if (body.isEmpty() || _state.value.sending) return

        _state.update { it.copy(sending = true, sendFailure = null) }
        scope.launch {
            try {
                backend.sendPrompt(sessionId, body)
                _state.update { it.copy(sending = false) }
                if (liveEventsSupported) watch(sessionId)
                load(sessionId, showSpinner = false)
            } catch (failure: BackendException) {
                if (failure.failure == BackendFailure.Unauthorized) onUnauthorized()
                _state.update { it.copy(sending = false, sendFailure = failure.failure) }
            }
        }
    }

    private fun watch(sessionId: String) {
        if (watcher?.isActive == true) return
        watcher = scope.launch {
            _state.update { it.copy(live = true) }
            try {
                backend.events(sessionId).collect { event ->
                    when (event) {
                        // "Stream open", NOT "agent ready" -- the engine may still
                        // be starting behind it.
                        is AgentEvent.Connected -> Unit
                        is AgentEvent.Notice ->
                            if (event.isError) _state.update { it.copy(notice = event.message) }
                        is AgentEvent.Other -> reloadRequests.tryEmit(Unit)
                    }
                }
            } catch (failure: BackendException) {
                if (failure.failure == BackendFailure.Unauthorized) onUnauthorized()
            } finally {
                _state.update { it.copy(live = false) }
                // One final refetch: the stream closing means the turn ended, and
                // the last frames may have been coalesced away.
                load(sessionId, showSpinner = false)
            }
        }
    }

    private suspend fun load(sessionId: String, showSpinner: Boolean) {
        if (showSpinner) _state.update { it.copy(transcript = Loadable.Loading) }
        try {
            val transcript = backend.loadTranscript(sessionId)
            // Late arrival for a session the user has already navigated away
            // from: drop it rather than overwrite the current one.
            if (_state.value.session?.id != sessionId) return
            _state.update { current ->
                current.copy(
                    session = current.session?.copy(name = transcript.info.name ?: current.session.name),
                    transcript = Loadable.Ready(rows(transcript.context.messages, transcript.context.entryIds)),
                )
            }
        } catch (failure: BackendException) {
            if (failure.failure == BackendFailure.Unauthorized) onUnauthorized()
            if (_state.value.session?.id != sessionId) return
            _state.update { current ->
                current.copy(
                    transcript = if (current.transcript is Loadable.Ready) current.transcript
                    else failure.asFailed(),
                )
            }
        }
    }

    /**
     * Pairs messages with their entry ids, dropping the ones the server marked
     * as not for display.
     *
     * `entryIds` is documented as parallel to `messages`, but a transcript is
     * user data and the app must not crash if it is ever short: the index-based
     * fallback keeps keys unique either way.
     */
    private fun rows(messages: List<ChatMessage>, entryIds: List<String>): List<TranscriptRow> =
        messages.mapIndexedNotNull { index, message ->
            if (message is ChatMessage.Custom && !message.display) return@mapIndexedNotNull null
            val entryId = entryIds.getOrNull(index)
            TranscriptRow(
                key = if (entryId.isNullOrBlank()) "index-$index" else entryId,
                message = message,
            )
        }

    private companion object {
        /** Long enough to coalesce a token burst, short enough to feel live. */
        const val REFETCH_DEBOUNCE_MS = 350L
    }
}
