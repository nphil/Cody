package dev.cody.shared

import dev.cody.shared.backend.BackendCapabilities
import dev.cody.shared.backend.BackendException
import dev.cody.shared.backend.BackendFailure
import dev.cody.shared.backend.BackendIdentity
import dev.cody.shared.backend.BackendKind
import dev.cody.shared.backend.CodyBackend
import dev.cody.shared.model.AgentEvent
import dev.cody.shared.model.ChatMessage
import dev.cody.shared.model.EngineState
import dev.cody.shared.model.MessageContent
import dev.cody.shared.model.SessionActivity
import dev.cody.shared.model.SessionContext
import dev.cody.shared.model.SessionListPage
import dev.cody.shared.model.SessionSummary
import dev.cody.shared.model.SessionTranscript
import dev.cody.shared.presentation.ChatModel
import dev.cody.shared.presentation.ChatState
import dev.cody.shared.presentation.Loadable
import dev.cody.shared.presentation.Transcript
import dev.cody.shared.presentation.TurnPhase
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * THE SPAWN POLICY. This is the most consequential test in the module.
 *
 * `GET /api/agent/{id}/events` is not a passive subscription: when no live
 * session exists for that id the route calls `startRpcSession` and COLD-SPAWNS
 * an engine process. A client that opens the stream just to look at a session
 * therefore starts a process per tap, on a box the user is not watching.
 *
 * So `ChatModel.open` may attach the stream only when the server has already
 * reported the session as running, and `send` may attach it because the prompt
 * spawns the engine anyway. Nothing about that is visible in a type signature
 * and nothing about it fails loudly if it regresses — the app would simply feel
 * fine while quietly forking engines. Hence these tests.
 *
 * The second half of the file covers the lifecycle around the same seam: that
 * streaming replaces refetching (one authoritative reload per turn, not one per
 * frame), that a session joined mid-turn actually renders, and that creating a
 * session does not quietly become a third attach point.
 */
class ChatModelSpawnPolicyTest {

    private class RecordingBackend : CodyBackend {
        /** Incremented when the event stream is actually COLLECTED, i.e. when the HTTP request would go out. */
        var eventSubscriptions = 0
            private set
        var prompts = 0
            private set
        var transcriptLoads = 0
            private set
        var aborts = 0
            private set
        var creates = mutableListOf<Pair<String, String?>>()
            private set

        /** Messages the fake server claims are in the session file. */
        var storedMessages: List<ChatMessage> = emptyList()

        /** Id the fake server hands back from `POST /api/agent/new`. */
        var createdSessionId: String = "s-new"

        /** Frames the test pushes at the model, in order. */
        private val frames = Channel<AgentEvent>(capacity = Channel.UNLIMITED)

        fun emit(event: AgentEvent) {
            frames.trySend(event)
        }

        override val kind: BackendKind get() = BackendKind.Remote

        override suspend fun identify(): BackendIdentity = BackendIdentity(
            kind = BackendKind.Remote,
            label = "test",
            codyVersion = "",
            engineName = "",
            username = null,
            capabilities = BackendCapabilities.Core,
        )

        override suspend fun listSessions(): SessionListPage = SessionListPage()

        /**
         * What `GET /api/agent/{id}` reports.
         *
         * Defaults to a warm-but-idle engine, which is what a real server reports
         * most of the time: `runningSessionIds` contains every session with a live
         * process, and a process sits idle between turns.
         */
        var activity: SessionActivity = SessionActivity(running = true, state = EngineState())

        /** Set when the activity probe should fail the way an old server would. */
        var activityFails = false

        var activityProbes = 0
            private set

        override suspend fun sessionActivity(sessionId: String): SessionActivity {
            activityProbes++
            if (activityFails) {
                throw BackendException(failure = BackendFailure.Server, status = 400, code = "unsupported")
            }
            return activity
        }

        /**
         * When set, `loadTranscript` suspends on it.
         *
         * The only way to observe the window between `open()` and a resolved
         * transcript: on an unconfined dispatcher a fake that returns immediately
         * has already finished by the time `open` returns, so a test of what
         * happens "while loading" would assert against a loaded transcript.
         */
        var loadGate: CompletableDeferred<Unit>? = null

        override suspend fun loadTranscript(sessionId: String): SessionTranscript {
            loadGate?.await()
            transcriptLoads++
            return SessionTranscript(
                sessionId = sessionId,
                context = SessionContext(
                    messages = storedMessages,
                    entryIds = storedMessages.indices.map { "e-$it" },
                ),
            )
        }

        override suspend fun createSession(cwd: String, firstPrompt: String?): String {
            creates.add(cwd to firstPrompt)
            return createdSessionId
        }

        override suspend fun sendPrompt(sessionId: String, text: String) {
            prompts++
        }

        override suspend fun cancelTurn(sessionId: String) {
            aborts++
        }

        override fun events(sessionId: String): Flow<AgentEvent> = channelFlow {
            // Inside the builder, not beside it: RemoteBackend.events() is a
            // channelFlow and the request is made on collection, so counting at
            // call time would count a subscription that never happened.
            eventSubscriptions++
            send(AgentEvent.Connected(sessionId))
            // A real SSE stream stays open for the whole turn; the channel never
            // completes on its own, so "is the stream still attached?" assertions
            // cannot pass for the wrong reason.
            frames.consumeAsFlow().collect { send(it) }
        }

        override fun close() = Unit
    }

    private val session = SessionSummary(id = "s-1", cwd = "/w", name = "Test")

    /**
     * ChatModel gets a scope on an UnconfinedTestDispatcher rather than
     * `runTest`'s `backgroundScope`, which is not an incidental choice:
     * `backgroundScope.launch { }` followed by `advanceUntilIdle()` does not run
     * the coroutine on this coroutines version, so every assertion here would
     * pass vacuously against a model that had done nothing at all.
     *
     * `streamContext` is pinned to the same test dispatcher for the same reason:
     * the model's default is `Dispatchers.Default`, which would put the watcher on
     * a real thread pool and make every assertion below a race.
     */
    private fun chatTest(body: suspend TestScope.(RecordingBackend, ChatModel) -> Unit) = runTest {
        val backend = RecordingBackend()
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        val scope = CoroutineScope(dispatcher + SupervisorJob())
        try {
            body(
                backend,
                ChatModel(
                    backend = backend,
                    scope = scope,
                    onUnauthorized = { },
                    streamContext = dispatcher,
                ),
            )
        } finally {
            scope.cancel()
        }
    }

    private val ChatState.rowCount: Int get() = assertIs<Loadable.Ready<Transcript>>(transcript).value.rows.size

    private val ChatState.streamingText: String?
        get() = assertIs<Loadable.Ready<Transcript>>(transcript).value.streaming?.text

    private fun assistant(text: String) =
        ChatMessage.Assistant(content = MessageContent.of(text))

    /** Makes the fake server report a turn genuinely in flight. */
    private fun RecordingBackend.withTurnInFlight() = apply {
        activity = SessionActivity(running = true, state = EngineState(isStreaming = true))
    }

    // ---- the policy --------------------------------------------------------

    @Test
    fun `opening an idle session does not subscribe and therefore does not spawn an engine`() =
        chatTest { backend, model ->
            model.open(session, hasLiveEngine = false, liveEventsSupported = true)
            advanceUntilIdle()

            assertEquals(0, backend.eventSubscriptions, "browsing an idle session must not open the event stream")
            assertFalse(model.state.value.live)
            assertFalse(model.state.value.running)

            // ...and the screen still works. The guard is about the stream, not
            // the transcript; asserting this is what stops the test passing
            // because nothing ran at all.
            assertEquals(1, backend.transcriptLoads)
            assertEquals("s-1", model.state.value.session?.id)
            assertIs<Loadable.Ready<*>>(model.state.value.transcript)
        }

    @Test
    fun `a warm but idle engine is not a running turn, so nothing is attached`() =
        chatTest { backend, model ->
            // `runningSessionIds` lists every session with a live PROCESS, and a
            // process sits warm between turns. Treating that as a running turn puts
            // a Stop button on an idle session and refuses to let the user send.
            model.open(session, hasLiveEngine = true, liveEventsSupported = true)
            advanceUntilIdle()

            assertEquals(1, backend.activityProbes, "the list's flag is not the answer; ask the agent route")
            assertEquals(0, backend.eventSubscriptions, "nothing is happening, so there is nothing to stream")
            assertFalse(model.state.value.running)
            assertEquals(TurnPhase.Idle, model.state.value.phase)
        }

    @Test
    fun `opening a session with a turn in flight subscribes and seeds the run`() = chatTest { backend, model ->
        backend.withTurnInFlight()
        model.open(session, hasLiveEngine = true, liveEventsSupported = true)
        advanceUntilIdle()

        assertEquals(1, backend.eventSubscriptions)
        assertTrue(model.state.value.live)
        assertTrue(model.state.value.running)
    }

    @Test
    fun `an unanswerable activity probe does not claim a running turn`() = chatTest { backend, model ->
        // An older or non-omp server can answer `unsupported` here. Guessing "yes"
        // would lock the composer on a session that may be idle; guessing "no" only
        // costs visibility of a turn this client joined late.
        backend.activityFails = true
        model.open(session, hasLiveEngine = true, liveEventsSupported = true)
        advanceUntilIdle()

        assertEquals(0, backend.eventSubscriptions)
        assertFalse(model.state.value.running)
        assertIs<Loadable.Ready<*>>(model.state.value.transcript)
    }

    @Test
    fun `a backend without live events never subscribes, running or not`() = chatTest { backend, model ->
        model.open(session, hasLiveEngine = true, liveEventsSupported = false)
        advanceUntilIdle()

        assertEquals(0, backend.eventSubscriptions)
        assertFalse(model.state.value.live)
        assertEquals(1, backend.transcriptLoads)
    }

    @Test
    fun `sending a prompt attaches the stream because the prompt spawns the engine anyway`() =
        chatTest { backend, model ->
            model.open(session, hasLiveEngine = false, liveEventsSupported = true)
            advanceUntilIdle()
            assertEquals(0, backend.eventSubscriptions)

            model.send("hello", liveEventsSupported = true)
            advanceUntilIdle()

            assertEquals(1, backend.prompts)
            assertEquals(1, backend.eventSubscriptions, "after a prompt the engine is running, so the stream is free")
            assertFalse(model.state.value.sending)
        }

    @Test
    fun `creating a session is not a third attach point`() = chatTest { backend, model ->
        // `ensure_session` does leave a runtime alive, so attaching here would be
        // harmless — and that is exactly how a two-case rule becomes a three-case
        // rule and then no rule at all. The first prompt attaches.
        model.newSession("/work/thing")
        advanceUntilIdle()

        assertEquals("/work/thing", backend.creates.single().first)
        assertNull(backend.creates.single().second, "create-only: ensure_session, not a first prompt")
        assertEquals(0, backend.eventSubscriptions, "creating a session must not open the stream")
        assertEquals(0, backend.transcriptLoads, "a session created a moment ago has nothing to fetch")
        assertEquals("s-new", model.state.value.session?.id)
        assertEquals(0, model.state.value.rowCount)
        assertFalse(model.state.value.creating)
    }

    @Test
    fun `an empty or whitespace prompt is not sent`() = chatTest { backend, model ->
        model.open(session, hasLiveEngine = false, liveEventsSupported = true)
        advanceUntilIdle()

        model.send("   ", liveEventsSupported = true)
        advanceUntilIdle()

        assertEquals(0, backend.prompts)
        assertEquals(0, backend.eventSubscriptions)
    }

    @Test
    fun `a prompt before the transcript has loaded is refused, then works once it lands`() =
        chatTest { backend, model ->
            // A prompt sent while the snapshot is in flight would append a row that
            // the arriving snapshot then replaces away — the message would simply
            // vanish from the screen. The refusal must be temporary, not a lockout.
            val gate = CompletableDeferred<Unit>()
            backend.loadGate = gate
            model.open(session, hasLiveEngine = false, liveEventsSupported = true)
            advanceUntilIdle()
            assertIs<Loadable.Loading>(model.state.value.transcript)

            model.send("too early", liveEventsSupported = true)
            advanceUntilIdle()
            assertEquals(0, backend.prompts)
            assertEquals(0, backend.eventSubscriptions)

            gate.complete(Unit)
            advanceUntilIdle()
            model.send("now", liveEventsSupported = true)
            advanceUntilIdle()

            assertEquals(1, backend.prompts)
            assertEquals(1, backend.eventSubscriptions)
        }

    @Test
    fun `switching to an idle session detaches the previous live stream`() = chatTest { backend, model ->
        backend.withTurnInFlight()
        model.open(session, hasLiveEngine = true, liveEventsSupported = true)
        advanceUntilIdle()
        assertEquals(1, backend.eventSubscriptions)
        assertTrue(model.state.value.live)

        model.open(session.copy(id = "s-2"), hasLiveEngine = false, liveEventsSupported = true)
        advanceUntilIdle()

        assertEquals(1, backend.eventSubscriptions, "the new session is idle; nothing new may be opened")
        assertFalse(model.state.value.live, "the previous session's stream must not stay attached")
        assertEquals("s-2", model.state.value.session?.id)
    }

    @Test
    fun `clear detaches everything`() = chatTest { backend, model ->
        backend.withTurnInFlight()
        model.open(session, hasLiveEngine = true, liveEventsSupported = true)
        advanceUntilIdle()
        assertTrue(model.state.value.live)

        model.clear()
        advanceUntilIdle()

        assertFalse(model.state.value.live)
        assertNull(model.state.value.session)
        assertEquals(1, backend.eventSubscriptions)
    }

    // ---- streaming instead of refetching -----------------------------------

    @Test
    fun `a streamed turn refetches once, at the end, not once per frame`() = chatTest { backend, model ->
        // This is the regression that matters for the whole slice: the previous
        // implementation scheduled a debounced transcript refetch per burst of
        // frames. A turn now costs exactly two requests — the opening snapshot and
        // one authoritative reload once it is over.
        backend.withTurnInFlight()
        model.open(session, hasLiveEngine = true, liveEventsSupported = true)
        advanceUntilIdle()
        assertEquals(1, backend.transcriptLoads)

        backend.emit(AgentEvent.AgentStart)
        repeat(40) { index ->
            backend.emit(AgentEvent.MessageProgress("message_update", assistant("token $index")))
        }
        advanceUntilIdle()

        assertEquals(1, backend.transcriptLoads, "frames must not each trigger a refetch")
        assertEquals("token 39", model.state.value.streamingText)

        backend.storedMessages = listOf(assistant("token 39"))
        backend.emit(AgentEvent.MessageSettled(assistant("token 39")))
        backend.emit(AgentEvent.AgentEnd(terminal = true))
        advanceUntilIdle()

        assertEquals(2, backend.transcriptLoads, "exactly one authoritative reload, at the end")
        assertFalse(model.state.value.running)
        assertNull(model.state.value.streamingText)
        // The reload is what gives the row the session file's own entry id.
        assertEquals(
            listOf("e-0"),
            assertIs<Loadable.Ready<Transcript>>(model.state.value.transcript).value.rows.map { it.key },
        )
    }

    @Test
    fun `a session joined mid-turn renders its frames instead of dropping them`() = chatTest { backend, model ->
        // The stream replays nothing and the route emits `agent_start` only when a
        // turn begins, so a client that attaches to an already-running session
        // never sees one. Without seeding the run state from the server's own
        // `runningSessionIds`, every frame of that turn is discarded by the
        // superseded-run guard and a busy session renders as a dead one.
        backend.withTurnInFlight()
        model.open(session, hasLiveEngine = true, liveEventsSupported = true)
        advanceUntilIdle()
        assertTrue(model.state.value.running, "the server said this session is running")

        backend.emit(AgentEvent.MessageProgress("message_update", assistant("mid-turn text")))
        advanceUntilIdle()

        assertEquals("mid-turn text", model.state.value.streamingText)
    }

    @Test
    fun `the stream ending without a terminal frame still settles the turn`() = chatTest { backend, model ->
        backend.withTurnInFlight()
        model.open(session, hasLiveEngine = true, liveEventsSupported = true)
        advanceUntilIdle()
        backend.emit(AgentEvent.AgentStart)
        backend.emit(AgentEvent.MessageProgress("message_update", assistant("half a sentence")))
        advanceUntilIdle()
        assertNotNull(model.state.value.streamingText)

        // A severed link, not a finished turn. The composer must come back anyway:
        // there is nothing left that could ever settle it.
        backend.emit(AgentEvent.Notice(level = "error", message = "stream died"))
        advanceUntilIdle()
        model.clear()
        advanceUntilIdle()

        assertFalse(model.state.value.live)
        assertFalse(model.state.value.running)
    }

    @Test
    fun `an optimistic prompt row appears before any frame arrives`() = chatTest { backend, model ->
        model.open(session, hasLiveEngine = false, liveEventsSupported = true)
        advanceUntilIdle()
        assertEquals(0, model.state.value.rowCount)

        model.send("do the thing", liveEventsSupported = true)
        advanceUntilIdle()

        assertEquals(1, model.state.value.rowCount, "the user's own words appear immediately")
        assertTrue(model.state.value.running)
        assertEquals(TurnPhase.Waiting, model.state.value.phase)
    }

    // ---- cancelling --------------------------------------------------------

    @Test
    fun `cancel aborts the turn but settles only when the stream says so`() = chatTest { backend, model ->
        backend.withTurnInFlight()
        model.open(session, hasLiveEngine = true, liveEventsSupported = true)
        advanceUntilIdle()
        backend.emit(AgentEvent.AgentStart)
        advanceUntilIdle()

        model.cancel()
        advanceUntilIdle()

        assertEquals(1, backend.aborts)
        assertTrue(model.state.value.cancelling)
        assertTrue(model.state.value.running, "the engine is still winding down; the composer stays locked")

        backend.emit(AgentEvent.AgentEnd(terminal = true))
        advanceUntilIdle()

        assertFalse(model.state.value.running)
        assertFalse(model.state.value.cancelling)
    }

    @Test
    fun `cancel with no turn in flight does nothing`() = chatTest { backend, model ->
        model.open(session, hasLiveEngine = false, liveEventsSupported = true)
        advanceUntilIdle()

        model.cancel()
        advanceUntilIdle()

        assertEquals(0, backend.aborts)
        assertFalse(model.state.value.cancelling)
    }
}
