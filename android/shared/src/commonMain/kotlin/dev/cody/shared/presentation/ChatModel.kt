package dev.cody.shared.presentation

import dev.cody.shared.backend.BackendException
import dev.cody.shared.backend.BackendFailure
import dev.cody.shared.backend.CodyBackend
import dev.cody.shared.model.SessionSummary
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.CoroutineContext

public data class ChatState(
    public val session: SessionSummary? = null,
    public val transcript: Loadable<Transcript> = Loadable.Idle,
    /** An event stream is attached for this session. */
    public val live: Boolean = false,
    /**
     * A turn is in flight.
     *
     * Distinct from [live] on purpose: the stream stays open between turns, and
     * this is the flag every stream frame is gated on (see [reduce]).
     */
    public val running: Boolean = false,
    public val phase: TurnPhase = TurnPhase.Idle,
    /** A prompt POST is in flight. */
    public val sending: Boolean = false,
    /** An abort has been accepted and the turn has not ended yet. */
    public val cancelling: Boolean = false,
    /** A create-session POST is in flight. */
    public val creating: Boolean = false,
    /** Last error-level notice from the stream; user-visible, dismissible. */
    public val notice: String? = null,
    public val sendFailure: BackendFailure? = null,
    public val cancelFailure: BackendFailure? = null,
    public val createFailure: BackendFailure? = null,
)

/**
 * One session's transcript, its live stream, and its lifecycle.
 *
 * Frames are applied to the transcript in place: assistant text grows in the live
 * item as it arrives, tool calls and their results land as they happen, and the
 * turn settles on its terminal frame. The application rules live in [reduce],
 * which is pure and therefore the thing the tests drive.
 *
 * ### The spawn policy, which is the load-bearing part of this class
 *
 * `GET /api/agent/{id}/events` is not a passive subscription. When no live engine
 * exists for that id the route COLD-SPAWNS one (`startRpcSession`), so a client
 * that opens the stream to look at a session forks an engine process per tap, on
 * a machine the user is not watching. There are therefore exactly two places the
 * stream may be attached, and both are cases where the engine is running already:
 *
 * - [open], when the server itself reported the session as running;
 * - [send], immediately after a prompt, which spawns the engine anyway.
 *
 * [newSession] deliberately does NOT attach, even though `ensure_session` leaves a
 * runtime alive: keeping the rule to two cases is what makes it possible to state,
 * test and keep.
 *
 * ### Ordering
 *
 * The transcript load and the stream do not overlap. The load is a snapshot of the
 * session file; the stream is a tail from the moment of attach and replays nothing.
 * Running them together is what either duplicates a row (a frame applied, then a
 * snapshot that already contains it) or drops one (a snapshot replacing rows built
 * from frames). So [open] attaches only once the load has resolved, and [send]
 * refuses to run before the transcript is loaded at all.
 */
public class ChatModel(
    private val backend: CodyBackend,
    private val scope: CoroutineScope,
    private val onUnauthorized: () -> Unit,
    /** Called with a session this model created, so the session list can pick it up. */
    private val onSessionCreated: (SessionSummary) -> Unit = {},
    /**
     * Where frame decoding and frame application run.
     *
     * NOT the UI dispatcher, and that is a requirement rather than a preference:
     * docs/android-ux.md §6.9 puts SSE parsing and transcript assembly on
     * `Dispatchers.Default`, because a token stream that decodes JSON on the main
     * thread spends the frame budget before Compose gets any of it. Injectable so
     * tests stay on their own scheduler instead of racing a real thread pool.
     */
    private val streamContext: CoroutineContext = Dispatchers.Default,
) {
    private val _state = MutableStateFlow(ChatState())
    public val state: StateFlow<ChatState> = _state.asStateFlow()

    private var watcher: Job? = null

    /**
     * @param hasLiveEngine whether `GET /api/sessions` listed this session in
     *   `runningSessionIds`. That flag means "a live engine PROCESS exists" — it is
     *   equally true of a warm-but-idle session — so it is used only as the cheap
     *   gate that decides whether asking about the turn is worth a request at all.
     * @param liveEventsSupported the backend's capability flag.
     */
    public fun open(session: SessionSummary, hasLiveEngine: Boolean, liveEventsSupported: Boolean) {
        watcher?.cancel()
        watcher = null
        val mayAttach = hasLiveEngine && liveEventsSupported
        _state.value = ChatState(session = session, transcript = Loadable.Loading)

        scope.launch {
            // In parallel with the transcript, because both are needed before
            // anything can be attached and the transcript is the slow one.
            //
            // Why ask at all when the list already said "running": because it did
            // not. `runningSessionIds` is process liveness, and an engine sits warm
            // and idle between turns. Seeding a running turn from it would put a
            // Stop button on an idle session and refuse to let the user send
            // anything — while NOT seeding it would drop every frame of a turn the
            // client joined late. Only `isStreaming`/`isPromptRunning` answer the
            // actual question, and the web client makes this same call for this
            // same reason.
            val inFlight = if (mayAttach) async { probeTurnInFlight(session.id) } else null
            load(session.id, showSpinner = true, onlyIfIdle = false)

            if (inFlight?.await() != true) return@launch
            val current = _state.value
            if (current.session?.id != session.id) return@launch
            // A transcript that would not load is not a surface to stream into.
            if (current.transcript !is Loadable.Ready) return@launch

            // Seeded BEFORE attaching. Joining a turn already in progress means no
            // `agent_start` will ever arrive for it: the stream is a tail from the
            // attach point and replays nothing. Without this, every frame of that
            // turn is dropped by the superseded-run guard and a busy session renders
            // as a dead one.
            _state.update {
                if (it.session?.id == session.id) it.copy(running = true, phase = TurnPhase.Waiting) else it
            }
            watch(session.id)
        }
    }

    private suspend fun probeTurnInFlight(sessionId: String): Boolean =
        try {
            backend.sessionActivity(sessionId).turnInFlight
        } catch (failure: BackendException) {
            if (failure.failure == BackendFailure.Unauthorized) onUnauthorized()
            // Could not establish that a turn is running, so do not claim one. The
            // cost is that a turn joined late on a backend that cannot answer stays
            // invisible until it ends; the alternative is a composer that refuses
            // to send on a session where nothing is happening.
            false
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
        val current = _state.value
        val sessionId = current.session?.id ?: return
        if (body.isEmpty() || current.sending) return
        // Sending against a transcript that has not loaded would race the load,
        // which replaces rows wholesale and would drop the message. Refuse instead
        // of losing it; the composer disables itself for the same reason.
        if (current.transcript !is Loadable.Ready) return

        _state.update { state ->
            state.copy(
                sending = true,
                sendFailure = null,
                // The turn is about to start and the composer must not feel like it
                // swallowed the tap. Only claimed when there will be a stream to
                // settle it: without live events this client cannot know when a
                // turn ends and must not pretend to.
                running = liveEventsSupported,
                phase = if (liveEventsSupported) TurnPhase.Waiting else TurnPhase.Idle,
            ).mapTranscript { it.withLocalPrompt(body) }
        }

        scope.launch {
            try {
                backend.sendPrompt(sessionId, body)
                _state.update { it.copy(sending = false) }
                if (liveEventsSupported) {
                    watch(sessionId)
                } else {
                    // No stream to tell us anything: one refetch is the whole of
                    // what this backend can offer.
                    load(sessionId, showSpinner = false, onlyIfIdle = false)
                }
            } catch (failure: BackendException) {
                if (failure.failure == BackendFailure.Unauthorized) onUnauthorized()
                _state.update { state ->
                    if (state.session?.id != sessionId) {
                        state
                    } else {
                        // The optimistic row stays: it is the only remaining copy
                        // of what the user typed, and the failure is shown beside
                        // it. `settle` clears the pending marker so an unrelated
                        // later echo cannot overwrite it.
                        state.copy(sending = false, sendFailure = failure.failure).settle()
                    }
                }
            }
        }
    }

    /**
     * Aborts the turn in flight.
     *
     * Nothing is settled here on success. The turn is over when the stream says it
     * is over; unlocking the composer the moment the abort is accepted would let a
     * second prompt race an engine that is still winding down.
     */
    public fun cancel() {
        val current = _state.value
        val sessionId = current.session?.id ?: return
        if (!current.running || current.cancelling) return

        _state.update { it.copy(cancelling = true, cancelFailure = null) }
        scope.launch {
            try {
                backend.cancelTurn(sessionId)
            } catch (failure: BackendException) {
                if (failure.failure == BackendFailure.Unauthorized) onUnauthorized()
                _state.update { state ->
                    if (state.session?.id != sessionId) state
                    else state.copy(cancelling = false, cancelFailure = failure.failure)
                }
            }
        }
    }

    /**
     * Creates a session rooted at [cwd] and opens it.
     *
     * No transcript fetch and no stream: a session that has just been created has
     * no messages, and its engine is left to the first prompt to talk to.
     */
    public fun newSession(cwd: String) {
        val root = cwd.trim()
        if (root.isEmpty() || _state.value.creating) return

        _state.update { it.copy(creating = true, createFailure = null) }
        scope.launch {
            try {
                val created = backend.createSession(root)
                watcher?.cancel()
                watcher = null
                val session = SessionSummary(id = created, cwd = root)
                _state.value = ChatState(
                    session = session,
                    transcript = Loadable.Ready(Transcript()),
                )
                onSessionCreated(session)
            } catch (failure: BackendException) {
                if (failure.failure == BackendFailure.Unauthorized) onUnauthorized()
                _state.update { it.copy(creating = false, createFailure = failure.failure) }
            }
        }
    }

    private fun watch(sessionId: String) {
        if (watcher?.isActive == true) return
        watcher = scope.launch(streamContext) {
            _state.update { if (it.session?.id == sessionId) it.copy(live = true) else it }
            try {
                backend.events(sessionId).collect { event ->
                    // A frame for a session the user has already left. The watcher
                    // is cancelled by open/clear, but a frame can already be in
                    // flight when that happens.
                    val before = _state.value
                    if (before.session?.id != sessionId) return@collect
                    val after = _state.updateAndGet { it.reduce(event) }

                    // One authoritative reload per turn, and only once the turn is
                    // genuinely over. It reconciles the rows this client assembled
                    // from frames with the session file's own entry ids, and picks
                    // up anything emitted between the initial snapshot and the
                    // attach. `onlyIfIdle` drops it if a new turn started while it
                    // was in flight — that snapshot would be behind the frames
                    // already applied.
                    if (before.running && !after.running) {
                        load(sessionId, showSpinner = false, onlyIfIdle = true)
                    }
                }
            } catch (failure: BackendException) {
                if (failure.failure == BackendFailure.Unauthorized) onUnauthorized()
            } finally {
                // Cancellation means the session was closed or swapped; there is
                // nothing to reconcile and the state belongs to someone else now.
                val abandoned = !isActive
                _state.update { if (it.session?.id == sessionId) it.copy(live = false).settle() else it }
                if (!abandoned && _state.value.session?.id == sessionId) {
                    load(sessionId, showSpinner = false, onlyIfIdle = true)
                }
            }
        }
    }

    private suspend fun load(sessionId: String, showSpinner: Boolean, onlyIfIdle: Boolean) {
        if (showSpinner) {
            _state.update { if (it.session?.id == sessionId) it.copy(transcript = Loadable.Loading) else it }
        }
        try {
            // withContext, so it does not matter which dispatcher called: a long
            // transcript is megabytes of JSON and `body()` deserialises on the
            // caller's coroutine. Decoding that on the UI thread spends the frame
            // budget of a whole second before anything can be drawn
            // (docs/android-ux.md §6.9).
            val loaded = withContext(streamContext) { backend.loadTranscript(sessionId) }
            _state.update { current ->
                val session = current.session
                // Late arrival for a session the user has already navigated away
                // from: drop it rather than overwrite the current one.
                if (session == null || session.id != sessionId) return@update current
                if (onlyIfIdle && current.running) return@update current
                current.copy(
                    session = session.copy(name = loaded.info.name ?: session.name),
                    transcript = Loadable.Ready(
                        Transcript.of(loaded.context.messages, loaded.context.entryIds),
                    ),
                )
            }
        } catch (failure: BackendException) {
            if (failure.failure == BackendFailure.Unauthorized) onUnauthorized()
            _state.update { current ->
                if (current.session?.id != sessionId) return@update current
                // A failed refetch must not blank a transcript the user is
                // reading; only a failed FIRST load becomes an error state.
                if (current.transcript is Loadable.Ready) return@update current
                current.copy(transcript = failure.asFailed())
            }
        }
    }
}
