package dev.cody.shared

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.cody.shared.backend.RemoteBackend
import dev.cody.shared.backend.ServerConfig
import dev.cody.shared.model.ChatMessage
import dev.cody.shared.model.SessionSummary
import dev.cody.shared.presentation.ChatModel
import dev.cody.shared.presentation.ChatState
import dev.cody.shared.presentation.Loadable
import dev.cody.shared.presentation.Transcript
import dev.cody.shared.presentation.TurnPhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * THE WHOLE STREAMING PATH, OVER A REAL SOCKET.
 *
 * Everything else in this module tests one layer with the next one faked. This
 * runs a genuine HTTP server, serves a genuine `text/event-stream`, and asserts on
 * what `ChatModel` ends up holding — so it covers the seams the layer tests cannot:
 * Ktor's SSE framing, the `:` heartbeat comment, chunked flushing, `AgentEvent.from`
 * against bytes rather than against a `JsonObject` someone built by hand, and the
 * request COUNT, which is the whole point of replacing the debounced refetch.
 *
 * It is the closest thing to a device smoke test that is reachable without one.
 * What it cannot see is Compose: recomposition counts and frame timing need real
 * hardware.
 */
class StreamOverHttpTest {

    /** Frames the fake server sends, in order, once the stream is open. */
    private val script = listOf(
        // The heartbeat is a bare comment. A client that treats it as a frame
        // fails here rather than in six weeks on a quiet connection.
        HEARTBEAT,
        """{"type":"agent_start"}""",
        """{"type":"message_end","message":{"role":"user","content":"say hello","timestamp":1}}""",
        """{"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"Hel"}]}}""",
        """{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hello, "}]}}""",
        """{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hello, wor"}]}}""",
        """{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hello, world"}]}}""",
        // The engine announces a tool with the LIVE field spelling.
        """{"type":"tool_execution_start","toolCallId":"c1","toolName":"read"}""",
        """{"type":"message_end","message":{"role":"assistant","content":[
             {"type":"text","text":"Hello, world."},
             {"type":"toolCall","id":"c1","name":"read","arguments":{"path":"a.txt"}}],"timestamp":2}}""",
        // ...and the result names only the id, so the label has to come from the
        // call it answers.
        """{"type":"message_end","message":{"role":"toolResult","toolCallId":"c1",
             "content":[{"type":"text","text":"file body"}],"isError":false,"timestamp":3}}""",
        """{"type":"tool_execution_end","toolCallId":"c1","toolName":"read"}""",
        """{"type":"agent_end","isTerminal":true,"messages":[]}""",
    )

    /** What the fake session file contains once the turn has been written out. */
    private val settledTranscript = """
        {"sessionId":"s-1","info":{"id":"s-1","cwd":"/w","name":"Smoke"},
         "context":{"messages":[
            {"role":"user","content":"say hello","timestamp":1},
            {"role":"assistant","content":[
               {"type":"text","text":"Hello, world."},
               {"type":"toolCall","toolCallId":"c1","toolName":"read","input":{"path":"a.txt"}}],
             "timestamp":2},
            {"role":"toolResult","toolCallId":"c1","toolName":"read",
             "content":[{"type":"text","text":"file body"}],"timestamp":3}],
          "entryIds":["e-1","e-2","e-3"]}}
    """.trimIndent()

    private val emptyTranscript =
        """{"sessionId":"s-1","info":{"id":"s-1","cwd":"/w","name":"Smoke"},"context":{"messages":[],"entryIds":[]}}"""

    @Test
    fun `a real event stream grows the transcript in place and costs two requests`() = runBlocking {
        val paths = CopyOnWriteArrayList<String>()
        // The handler runs on the server's thread and the assertions on this one,
        // so the "has the turn been written out yet?" flag has to be shared safely.
        val turnFinished = java.util.concurrent.atomic.AtomicBoolean(false)

        val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        server.createContext("/api/sessions/s-1") { exchange ->
            paths.add(exchange.requestURI.path)
            exchange.respondJson(if (turnFinished.get()) settledTranscript else emptyTranscript)
        }
        // The agent route: this session has an engine AND a turn in flight, which
        // is what licenses attaching the stream at all.
        server.createContext("/api/agent/s-1") { exchange ->
            paths.add(exchange.requestURI.path)
            exchange.respondJson("""{"running":true,"state":{"isStreaming":true,"isPromptRunning":true}}""")
        }
        server.createContext("/api/agent/s-1/events") { exchange ->
            paths.add(exchange.requestURI.path)
            exchange.responseHeaders.add("Content-Type", "text/event-stream")
            exchange.responseHeaders.add("Cache-Control", "no-cache")
            // Length 0 means chunked, which is what lets each frame be flushed on
            // its own instead of buffered until the handler returns.
            exchange.sendResponseHeaders(200, 0)
            val out = exchange.responseBody
            out.writeFrame("""{"type":"connected","sessionId":"s-1"}""")
            for (frame in script) {
                // The session file is written BEFORE the terminal frame goes out,
                // which is the only ordering that makes the reload meaningful: a
                // client told "the turn is over" and then handed a stale snapshot
                // would blank the rows it just assembled.
                if (frame.contains("agent_end")) turnFinished.set(true)
                if (frame === HEARTBEAT) out.write(":\n\n".toByteArray()) else out.writeFrame(frame)
                out.flush()
                // Enough for the client to observe intermediate states; the
                // assertions below do not depend on how many it catches.
                Thread.sleep(FRAME_GAP_MS)
            }
            // Deliberately NOT closed: a real SSE stream stays open between turns,
            // and closing it here would trigger the stream-died reconcile and make
            // the request count a different number for the wrong reason.
            Thread.sleep(STREAM_LINGER_MS)
        }
        server.executor = null
        server.start()

        val backend = RemoteBackend(
            ServerConfig(baseUrl = "http://127.0.0.1:${server.address.port}", token = "cody_pat_test"),
        )
        val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
        val model = ChatModel(backend, scope, onUnauthorized = { })

        // Every streaming text the client actually observed, for the monotonicity
        // check. StateFlow conflates, so this is a subsequence of what was sent —
        // which is exactly the guarantee the server's backpressure gives too.
        val seen = CopyOnWriteArrayList<String>()
        val watcher = scope.launch {
            model.state.collect { state ->
                val text = state.streamingText ?: return@collect
                if (seen.lastOrNull() != text) seen.add(text)
            }
        }

        try {
            model.open(SessionSummary(id = "s-1", cwd = "/w"), hasLiveEngine = true, liveEventsSupported = true)

            // Wait for the turn to settle AND for the authoritative reload to have
            // replaced the streamed keys with the session file's entry ids.
            val settled = withTimeout(TIMEOUT_MS) {
                model.state.first { !it.running && it.rows.map { row -> row.key } == RELOADED_KEYS }
            }

            // --- what streamed ---
            assertTrue(seen.isNotEmpty(), "no streaming text was ever observed")
            assertTrue(
                seen.zipWithNext().all { (earlier, later) -> later.startsWith(earlier) },
                "streamed text must only ever grow as a prefix; saw $seen",
            )
            assertTrue(
                seen.last().length > seen.first().length,
                "the transcript did not grow incrementally; saw $seen",
            )
            assertTrue(seen.none { it.contains("HelHel") }, "text was appended instead of replaced: $seen")

            // --- what settled ---
            assertNull(settled.streamingText, "the live item must be released")
            assertEquals(TurnPhase.Idle, settled.phase)
            assertFalse(settled.live.not(), "the stream is still open between turns")
            assertEquals(RELOADED_KEYS, settled.rows.map { it.key })

            val result = settled.rows[2].message as ChatMessage.ToolResult
            assertEquals("c1", result.toolCallId)
            assertEquals("read", result.toolName)

            // --- what it cost ---
            assertEquals(
                EXPECTED_PATHS,
                paths.toList().sorted(),
                "a streamed turn is one snapshot, one stream, one reload — not one refetch per frame",
            )
        } finally {
            watcher.cancel()
            scope.cancel()
            backend.close()
            server.stop(0)
        }
    }

    private val ChatState.rows
        get() = (transcript as? Loadable.Ready<Transcript>)?.value?.rows.orEmpty()

    private val ChatState.streamingText
        get() = (transcript as? Loadable.Ready<Transcript>)?.value?.streaming?.text

    private fun HttpExchange.respondJson(body: String) {
        val bytes = body.toByteArray()
        responseHeaders.add("Content-Type", "application/json")
        sendResponseHeaders(200, bytes.size.toLong())
        responseBody.use { it.write(bytes) }
    }

    /** One SSE frame: a bare `data:` line and a blank line. No event names. */
    private fun java.io.OutputStream.writeFrame(json: String) {
        write("data: ${json.replace("\n", "")}\n\n".toByteArray())
    }

    private companion object {
        /** Sentinel for "send the `:` heartbeat here", not a frame body. */
        const val HEARTBEAT = "<<heartbeat>>"

        /**
         * Every request a streamed turn makes, sorted so the transcript probe and
         * the activity probe -- which run in parallel -- cannot race the assertion.
         * The point of the assertion is the COUNT and the set: one snapshot, one
         * activity probe, one stream, one reload. Not one refetch per frame.
         */
        val EXPECTED_PATHS = listOf(
            "/api/agent/s-1",
            "/api/agent/s-1/events",
            "/api/sessions/s-1",
            "/api/sessions/s-1",
        ).sorted()

        /** Entry ids the reloaded session file supplies, replacing the stream keys. */
        val RELOADED_KEYS = listOf("e-1", "e-2", "e-3")
        const val FRAME_GAP_MS = 15L
        const val STREAM_LINGER_MS = 2_000L
        const val TIMEOUT_MS = 20_000L
    }
}
