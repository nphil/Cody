package dev.cody.shared

import dev.cody.shared.model.AgentEvent
import dev.cody.shared.model.ChatMessage
import dev.cody.shared.model.CodyJson
import dev.cody.shared.model.ContentBlock
import dev.cody.shared.model.MessageContent
import dev.cody.shared.model.SessionSummary
import dev.cody.shared.presentation.ChatState
import dev.cody.shared.presentation.Loadable
import dev.cody.shared.presentation.Transcript
import dev.cody.shared.presentation.TranscriptRow
import dev.cody.shared.presentation.TurnPhase
import dev.cody.shared.presentation.reduce
import dev.cody.shared.presentation.withLocalPrompt
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * HOW A STREAM BECOMES A TRANSCRIPT.
 *
 * Every frame below is a real wire payload, fed through `AgentEvent.from` rather
 * than hand-built as a Kotlin object, so these tests pin the decoding and the
 * application together. That matters more than it sounds: the two bugs this file
 * exists to prevent are both *decoding* bugs wearing a state-machine costume —
 * a `message_update` treated as a delta (silently duplicated text) and a streamed
 * `toolCall` decoded from the wrong field names (a tool call with no id, so no
 * result can ever be matched to it).
 */
class TranscriptStreamTest {

    private val idle = ChatState(
        session = SessionSummary(id = "s-1", cwd = "/w"),
        transcript = Loadable.Ready(Transcript()),
    )

    private fun frame(json: String): AgentEvent =
        AgentEvent.from(CodyJson.decodeFromString(JsonObject.serializer(), json))

    private fun ChatState.apply(vararg frames: String): ChatState =
        frames.fold(this) { state, json -> state.reduce(frame(json)) }

    private val ChatState.transcriptValue: Transcript
        get() = assertIs<Loadable.Ready<Transcript>>(transcript).value

    private val ChatState.rows: List<TranscriptRow> get() = transcriptValue.rows

    private fun assistantFrame(type: String, text: String): String =
        """{"type":"$type","message":{"role":"assistant","content":[{"type":"text","text":"$text"}]}}"""

    // ---- deltas ------------------------------------------------------------

    @Test
    fun `accumulated message frames replace, so a coalesced stream never duplicates text`() {
        // The server collapses consecutive message_update frames under
        // backpressure because each carries the FULL accumulated message
        // (docs/api.md). A client that appended would print "HelloHello, " here.
        val state = idle.apply(
            """{"type":"agent_start"}""",
            assistantFrame("message_start", "Hello"),
            assistantFrame("message_update", "Hello, wor"),
            assistantFrame("message_update", "Hello, world."),
        )

        val streaming = assertNotNull(state.transcriptValue.streaming)
        assertEquals("Hello, world.", streaming.text)
        assertTrue(state.rows.isEmpty(), "a streaming message is not a settled row yet")
        assertEquals(TurnPhase.Streaming, state.phase)
        assertTrue(state.running)
    }

    @Test
    fun `a dropped middle frame still leaves the full text, which is the point of replacing`() {
        // Exactly what backpressure does: frame 2 never arrives. Replacement is
        // lossless here; appending would have lost "…, wor" forever.
        val state = idle.apply(
            """{"type":"agent_start"}""",
            assistantFrame("message_start", "Hello"),
            assistantFrame("message_update", "Hello, world."),
        )

        assertEquals("Hello, world.", assertNotNull(state.transcriptValue.streaming).text)
    }

    @Test
    fun `reasoning and text stream side by side and are kept apart`() {
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"message_update","message":{"role":"assistant","content":[
                 {"type":"thinking","thinking":"weighing options"},
                 {"type":"text","text":"Here goes"}]}}""",
        )

        val streaming = assertNotNull(state.transcriptValue.streaming)
        assertEquals("weighing options", streaming.thinking)
        assertEquals("Here goes", streaming.text)
    }

    @Test
    fun `a settled message leaves the live item and becomes a keyed row exactly once`() {
        val state = idle.apply(
            """{"type":"agent_start"}""",
            assistantFrame("message_start", "Done"),
            assistantFrame("message_end", "Done"),
        )

        assertNull(state.transcriptValue.streaming, "the live item must be released on settle")
        val row = state.rows.single()
        assertEquals("Done", assertIs<ChatMessage.Assistant>(row.message).content.text)
        assertTrue(row.key.isNotBlank())
        // Still running: message_end ends a MESSAGE, not the turn.
        assertTrue(state.running)
        assertEquals(TurnPhase.Waiting, state.phase)
    }

    // ---- tool calls and their results --------------------------------------

    @Test
    fun `a streamed tool call decodes from the live wire spelling`() {
        // The live stream is NOT put through lib/normalize.ts, so its blocks carry
        // the on-disk spelling {id, name, arguments}. Decoding these as absent is
        // the failure that makes every tool result an orphan.
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"message_update","message":{"role":"assistant","content":[
                 {"type":"toolCall","id":"toolu_01","name":"Bash","arguments":{"command":"ls"}}]}}""",
        )

        val call = assertNotNull(state.transcriptValue.streaming).toolCalls.single()
        assertEquals("toolu_01", call.toolCallId)
        assertEquals("Bash", call.toolName)
        assertEquals("ls", call.input["command"]?.toString()?.trim('"'))
    }

    @Test
    fun `a tool result is labelled with the call it answers`() {
        // The result names its call by id and nothing else. Without the id → name
        // index the card reads "Tool result" and the user cannot tell which of
        // four parallel calls it belongs to.
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"message_end","message":{"role":"assistant","content":[
                 {"type":"text","text":"Listing."},
                 {"type":"toolCall","id":"toolu_01","name":"Bash","arguments":{"command":"ls"}}]}}""",
            """{"type":"message_end","message":{"role":"toolResult","toolCallId":"toolu_01",
                 "content":[{"type":"text","text":"a\nb"}],"isError":false}}""",
        )

        val result = assertIs<ChatMessage.ToolResult>(state.rows.last().message)
        assertEquals("toolu_01", result.toolCallId)
        assertEquals("Bash", result.toolName)
    }

    @Test
    fun `two calls in flight get their own results, not each other's`() {
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"message_end","message":{"role":"assistant","content":[
                 {"type":"toolCall","id":"c1","name":"read","arguments":{}},
                 {"type":"toolCall","id":"c2","name":"grep","arguments":{}}]}}""",
            // Deliberately answered out of order.
            """{"type":"message_end","message":{"role":"toolResult","toolCallId":"c2","content":"hit"}}""",
            """{"type":"message_end","message":{"role":"toolResult","toolCallId":"c1","content":"file"}}""",
        )

        val results = state.rows.mapNotNull { it.message as? ChatMessage.ToolResult }
        assertEquals(listOf("c2" to "grep", "c1" to "read"), results.map { it.toolCallId to it.toolName })
    }

    @Test
    fun `a result that names its own tool keeps that name`() {
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"message_end","message":{"role":"assistant","content":[
                 {"type":"toolCall","id":"c1","name":"stale","arguments":{}}]}}""",
            """{"type":"message_end","message":{"role":"toolResult","toolCallId":"c1",
                 "toolName":"authoritative","content":"x"}}""",
        )

        assertEquals(
            "authoritative",
            assertIs<ChatMessage.ToolResult>(state.rows.last().message).toolName,
        )
    }

    @Test
    fun `tool_execution_start supplies the name when no assistant frame carried it`() {
        // Attaching mid-turn means the assistant message announcing the call was
        // emitted before this client was listening; the lifecycle frame is then
        // the only place the name exists.
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"tool_execution_start","toolCallId":"c9","toolName":"write"}""",
            """{"type":"message_end","message":{"role":"toolResult","toolCallId":"c9","content":"ok"}}""",
        )

        assertEquals("write", assertIs<ChatMessage.ToolResult>(state.rows.single().message).toolName)
    }

    @Test
    fun `the phase tracks tools in flight and returns to waiting when the last one ends`() {
        var state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"tool_execution_start","toolCallId":"c1","toolName":"read"}""",
            """{"type":"tool_execution_start","toolCallId":"c2","toolName":"grep"}""",
        )
        assertEquals(listOf("read", "grep"), assertIs<TurnPhase.Tools>(state.phase).running.map { it.toolName })

        state = state.apply("""{"type":"tool_execution_end","toolCallId":"c1","toolName":"read"}""")
        assertEquals(listOf("grep"), assertIs<TurnPhase.Tools>(state.phase).running.map { it.toolName })

        state = state.apply("""{"type":"tool_execution_end","toolCallId":"c2","toolName":"grep"}""")
        assertEquals(TurnPhase.Waiting, state.phase, "the turn is still running, just not in a tool")
    }

    // ---- superseded runs ---------------------------------------------------

    @Test
    fun `frames buffered past the end of a run are ignored rather than resurrecting it`() {
        // The realistic cause: the transport held frames while the process was
        // backgrounded and flushed them after the turn settled. Applying them
        // shows a streaming bubble with no turn behind it, and appends a message
        // the authoritative reload already has.
        val settled = idle.apply(
            """{"type":"agent_start"}""",
            assistantFrame("message_start", "first"),
            assistantFrame("message_end", "first"),
            """{"type":"agent_end","isTerminal":true}""",
        )
        assertFalse(settled.running)
        assertEquals(1, settled.rows.size)

        val afterLateFrames = settled.apply(
            assistantFrame("message_update", "ghost"),
            assistantFrame("message_end", "ghost"),
            """{"type":"tool_execution_start","toolCallId":"zz","toolName":"ghost"}""",
            """{"type":"agent_end","isTerminal":true}""",
        )

        assertNull(afterLateFrames.transcriptValue.streaming, "no ghost streaming bubble")
        assertEquals(1, afterLateFrames.rows.size, "no duplicated row from a finished run")
        assertEquals(TurnPhase.Idle, afterLateFrames.phase)
        assertFalse(afterLateFrames.running)
    }

    @Test
    fun `a message_end for a run that never started is dropped`() {
        // Same guard from the other side: an app that has not seen agent_start has
        // no run to attribute a message to, and the reload is what will fetch it.
        val state = idle.apply(assistantFrame("message_end", "orphan"))

        assertTrue(state.rows.isEmpty())
        assertFalse(state.running)
    }

    // ---- terminal frames ---------------------------------------------------

    @Test
    fun `agent_end with isTerminal false does not settle, because a delivery resumes the run`() {
        val state = idle.apply(
            """{"type":"agent_start"}""",
            assistantFrame("message_update", "half"),
            """{"type":"agent_end","isTerminal":false}""",
        )

        assertTrue(state.running, "an async delivery will resume this same run")
        assertNotNull(state.transcriptValue.streaming, "the live bubble stays")
    }

    @Test
    fun `agent_end without isTerminal is terminal`() {
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"agent_end","messages":[]}""",
        )

        assertFalse(state.running)
        assertEquals(TurnPhase.Idle, state.phase)
    }

    @Test
    fun `the terminal event settles the turn and releases the live item`() {
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"tool_execution_start","toolCallId":"c1","toolName":"read"}""",
            assistantFrame("message_update", "partial"),
            """{"type":"agent_end","isTerminal":true}""",
        )

        assertFalse(state.running)
        assertFalse(state.cancelling)
        assertEquals(TurnPhase.Idle, state.phase)
        assertNull(state.transcriptValue.streaming)
    }

    @Test
    fun `prompt_error settles the turn and surfaces the reason`() {
        // No agent_end follows a failed prompt. Waiting for one leaves the
        // composer locked until something else times out.
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"prompt_error","errorMessage":"engine not logged in"}""",
        )

        assertFalse(state.running)
        assertEquals("engine not logged in", state.notice)
    }

    @Test
    fun `prompt_result settles only when the agent was never invoked`() {
        val ordinary = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"prompt_result","agentInvoked":true}""",
        )
        assertTrue(ordinary.running, "an ordinary turn is still running")

        val slashCommand = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"prompt_result","agentInvoked":false}""",
        )
        assertFalse(slashCommand.running, "a builtin answered it; no agent_end will come")
    }

    // ---- local prompt reconciliation ---------------------------------------

    /** The state right after the user taps send, before the engine echoes back. */
    private fun sent(text: String): ChatState =
        idle.copy(transcript = Loadable.Ready(idle.transcriptValue.withLocalPrompt(text)))

    @Test
    fun `the engine's echo replaces this client's own prompt row instead of duplicating it`() {
        val local = sent("ship it")
        assertEquals(1, local.rows.size)

        val echoed = local.apply(
            """{"type":"agent_start"}""",
            """{"type":"message_end","message":{"role":"user","content":"ship it","timestamp":9}}""",
        )

        assertEquals(1, echoed.rows.size, "the prompt must appear once, not twice")
        assertEquals("ship it", assertIs<ChatMessage.User>(echoed.rows.single().message).content.text)
        assertEquals(9L, echoed.rows.single().message.timestamp, "the authoritative copy wins")
    }

    @Test
    fun `a second user message with identical text is still drawn`() {
        // The one-shot marker matters: steering can deliver the same words twice
        // and the second one is a real message, not an echo to swallow.
        val state = sent("again").apply(
            """{"type":"agent_start"}""",
            """{"type":"message_end","message":{"role":"user","content":"again"}}""",
            """{"type":"message_end","message":{"role":"user","content":"again"}}""",
        )

        assertEquals(2, state.rows.size)
    }

    @Test
    fun `a prompt whose turn never echoed it keeps the row and drops the marker`() {
        // The turn ended without the engine echoing the prompt back — a failed
        // spawn, say. The user's own words must survive, and the marker must not.
        val state = sent("hello").apply(
            """{"type":"agent_start"}""",
            """{"type":"agent_end","isTerminal":true}""",
        )

        assertEquals(1, state.rows.size)
        assertNull(state.transcriptValue.pendingLocalKey)
    }

    // ---- keys and forward compatibility ------------------------------------

    @Test
    fun `every row of a streamed turn has a unique, non-positional key`() {
        // An index key turns a prepend into a full re-composition and loses scroll
        // anchoring (docs/android-ux.md §6.2), so nothing here may be one.
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"message_end","message":{"role":"user","content":"go"}}""",
            assistantFrame("message_end", "one"),
            assistantFrame("message_end", "two"),
            """{"type":"message_end","message":{"role":"toolResult","toolCallId":"c1","content":"x"}}""",
        )

        val keys = state.rows.map { it.key }
        assertEquals(4, keys.size)
        assertEquals(keys.size, keys.toSet().size, "duplicate keys break LazyColumn reuse")
        assertTrue(keys.none { it.startsWith("index-") }, "streamed rows must not be index-keyed")
    }

    @Test
    fun `a message the server marked as not for display is not drawn`() {
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"message_end","message":{"role":"custom","customType":"internal",
                 "content":"bookkeeping","display":false}}""",
        )

        assertTrue(state.rows.isEmpty())
    }

    @Test
    fun `unknown frames and unknown roles change nothing and break nothing`() {
        val state = idle.apply(
            """{"type":"agent_start"}""",
            """{"type":"some_future_frame","payload":{"a":1}}""",
            """{"type":"subagent_progress","progress":{"id":"x"}}""",
        )

        assertTrue(state.running)
        assertTrue(state.rows.isEmpty())
        assertNull(state.notice)
    }

    @Test
    fun `an info notice is not raised as an error banner but an error one is`() {
        val info = idle.apply("""{"type":"notice","level":"info","message":"fyi"}""")
        assertNull(info.notice)

        val error = idle.apply("""{"type":"notice","level":"error","message":"spawn failed"}""")
        assertEquals("spawn failed", error.notice)
    }

    @Test
    fun `connected does not mean the agent is running`() {
        // The route sends this BEFORE it spawns the engine. Treating it as
        // "running" would apply frames from a previous run's tail.
        val state = idle.apply("""{"type":"connected","sessionId":"s-1"}""")

        assertFalse(state.running)
        assertEquals(TurnPhase.Idle, state.phase)
    }

    @Test
    fun `a transcript that has not loaded absorbs frames without inventing rows`() {
        val loading = ChatState(session = SessionSummary(id = "s-1"), transcript = Loadable.Loading)

        val state = loading.apply(
            """{"type":"agent_start"}""",
            assistantFrame("message_end", "text"),
        )

        assertIs<Loadable.Loading>(state.transcript)
        assertTrue(state.running, "run state is still tracked; only rows need a surface")
    }

    @Test
    fun `a transcript built from the session file keeps its entry ids as keys`() {
        val transcript = Transcript.of(
            messages = listOf(
                ChatMessage.User(),
                ChatMessage.Assistant(
                    content = MessageContent(
                        listOf(ContentBlock.ToolCall(toolCallId = "c1", toolName = "read")),
                    ),
                ),
            ),
            entryIds = listOf("e-1", "e-2"),
        )

        assertEquals(listOf("e-1", "e-2"), transcript.rows.map { it.key })
        assertEquals(mapOf("c1" to "read"), transcript.toolNames)
    }
}
