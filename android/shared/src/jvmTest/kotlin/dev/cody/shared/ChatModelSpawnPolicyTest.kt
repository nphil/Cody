package dev.cody.shared

import dev.cody.shared.backend.BackendCapabilities
import dev.cody.shared.backend.BackendIdentity
import dev.cody.shared.backend.BackendKind
import dev.cody.shared.backend.CodyBackend
import dev.cody.shared.model.AgentEvent
import dev.cody.shared.model.SessionContext
import dev.cody.shared.model.SessionListPage
import dev.cody.shared.model.SessionSummary
import dev.cody.shared.model.SessionTranscript
import dev.cody.shared.presentation.ChatModel
import dev.cody.shared.presentation.Loadable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
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

        override suspend fun loadTranscript(sessionId: String): SessionTranscript {
            transcriptLoads++
            return SessionTranscript(sessionId = sessionId, context = SessionContext())
        }

        override suspend fun sendPrompt(sessionId: String, text: String) {
            prompts++
        }

        override fun events(sessionId: String): Flow<AgentEvent> = flow {
            // Inside the builder, not beside it: RemoteBackend.events() is a
            // channelFlow and the request is made on collection, so counting at
            // call time would count a subscription that never happened.
            eventSubscriptions++
            emit(AgentEvent.Connected(sessionId))
            // A real SSE stream stays open for the whole turn. Completing here
            // instead would make every "is the stream still attached?" assertion
            // below pass for the wrong reason.
            awaitCancellation()
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
     */
    private fun chatTest(body: suspend TestScope.(RecordingBackend, ChatModel) -> Unit) = runTest {
        val backend = RecordingBackend()
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler) + SupervisorJob())
        try {
            body(backend, ChatModel(backend, scope) { })
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `opening an idle session does not subscribe and therefore does not spawn an engine`() =
        chatTest { backend, model ->
            model.open(session, isRunning = false, liveEventsSupported = true)
            advanceUntilIdle()

            assertEquals(0, backend.eventSubscriptions, "browsing an idle session must not open the event stream")
            assertFalse(model.state.value.live)

            // ...and the screen still works. The guard is about the stream, not
            // the transcript; asserting this is what stops the test passing
            // because nothing ran at all.
            assertEquals(1, backend.transcriptLoads)
            assertEquals("s-1", model.state.value.session?.id)
            assertIs<Loadable.Ready<*>>(model.state.value.transcript)
        }

    @Test
    fun `opening a session the server reported as running does subscribe`() = chatTest { backend, model ->
        model.open(session, isRunning = true, liveEventsSupported = true)
        advanceUntilIdle()

        assertEquals(1, backend.eventSubscriptions)
        assertTrue(model.state.value.live)
    }

    @Test
    fun `a backend without live events never subscribes, running or not`() = chatTest { backend, model ->
        model.open(session, isRunning = true, liveEventsSupported = false)
        advanceUntilIdle()

        assertEquals(0, backend.eventSubscriptions)
        assertFalse(model.state.value.live)
        assertEquals(1, backend.transcriptLoads)
    }

    @Test
    fun `sending a prompt attaches the stream because the prompt spawns the engine anyway`() =
        chatTest { backend, model ->
            model.open(session, isRunning = false, liveEventsSupported = true)
            advanceUntilIdle()
            assertEquals(0, backend.eventSubscriptions)

            model.send("hello", liveEventsSupported = true)
            advanceUntilIdle()

            assertEquals(1, backend.prompts)
            assertEquals(1, backend.eventSubscriptions, "after a prompt the engine is running, so the stream is free")
            assertFalse(model.state.value.sending)
        }

    @Test
    fun `an empty or whitespace prompt is not sent`() = chatTest { backend, model ->
        model.open(session, isRunning = false, liveEventsSupported = true)
        advanceUntilIdle()

        model.send("   ", liveEventsSupported = true)
        advanceUntilIdle()

        assertEquals(0, backend.prompts)
        assertEquals(0, backend.eventSubscriptions)
    }

    @Test
    fun `switching to an idle session detaches the previous live stream`() = chatTest { backend, model ->
        model.open(session, isRunning = true, liveEventsSupported = true)
        advanceUntilIdle()
        assertEquals(1, backend.eventSubscriptions)
        assertTrue(model.state.value.live)

        model.open(session.copy(id = "s-2"), isRunning = false, liveEventsSupported = true)
        advanceUntilIdle()

        assertEquals(1, backend.eventSubscriptions, "the new session is idle; nothing new may be opened")
        assertFalse(model.state.value.live, "the previous session's stream must not stay attached")
        assertEquals("s-2", model.state.value.session?.id)
    }

    @Test
    fun `clear detaches everything`() = chatTest { backend, model ->
        model.open(session, isRunning = true, liveEventsSupported = true)
        advanceUntilIdle()
        assertTrue(model.state.value.live)

        model.clear()
        advanceUntilIdle()

        assertFalse(model.state.value.live)
        assertNull(model.state.value.session)
        assertEquals(1, backend.eventSubscriptions)
    }
}
