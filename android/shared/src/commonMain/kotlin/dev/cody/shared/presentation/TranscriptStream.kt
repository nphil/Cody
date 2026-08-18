package dev.cody.shared.presentation

import dev.cody.shared.model.AgentEvent
import dev.cody.shared.model.ChatMessage
import dev.cody.shared.model.ContentBlock
import dev.cody.shared.model.MessageContent

/**
 * One settled transcript row: a message plus the stable key it is drawn with.
 *
 * The key is the session file's own entry id where there is one, so a `LazyColumn`
 * reuses the right node across a refetch and rows keep their scroll anchoring
 * (docs/android-ux.md §6.2). Rows that arrived as stream frames have no entry id
 * yet — the file gains one only when the turn is written out — so they get a
 * monotonic `stream-N` key from [Transcript.streamKeySeq]. What matters is that
 * the key is never an index: an index key turns a prepend into a full
 * re-composition and loses the scroll position.
 */
public data class TranscriptRow(
    public val key: String,
    public val message: ChatMessage,
)

/** A tool the engine has started and not yet finished. */
public data class RunningTool(
    public val toolCallId: String,
    public val toolName: String,
)

/**
 * What the engine is doing right now.
 *
 * Read by the status line only. Deliberately NOT read by any settled transcript
 * row: a committed row that reads live state is invalidated on every frame, which
 * is the exact failure docs/android-ux.md §6.5 exists to prevent.
 */
public sealed interface TurnPhase {
    /** No turn in flight. */
    public data object Idle : TurnPhase

    /** A turn is running and the model has not produced anything yet. */
    public data object Waiting : TurnPhase

    /** The model is emitting a message. */
    public data object Streaming : TurnPhase

    public data class Tools(public val running: List<RunningTool>) : TurnPhase
}

/**
 * The message currently being streamed, flattened for drawing.
 *
 * Built off the main thread (see `ChatModel`'s stream context) precisely so the
 * live item can draw a token delta without walking a block list or joining
 * strings in composition — docs/android-ux.md §6.8 and §6.9.
 */
public data class StreamingTurn(
    public val text: String = "",
    public val thinking: String = "",
    public val toolCalls: List<ContentBlock.ToolCall> = emptyList(),
) {
    public val isEmpty: Boolean
        get() = text.isEmpty() && thinking.isEmpty() && toolCalls.isEmpty()

    public companion object {
        public fun of(message: ChatMessage.Assistant): StreamingTurn {
            var text: String? = null
            var thinking: String? = null
            var calls: MutableList<ContentBlock.ToolCall>? = null
            for (block in message.content.blocks) {
                when (block) {
                    // Concatenation is deliberately the slow path. An engine
                    // emits ONE text block per streaming bubble, so the common
                    // case hands the string straight through instead of copying
                    // the whole accumulated message on every frame.
                    is ContentBlock.Text ->
                        text = if (text == null) block.text else text + "\n\n" + block.text

                    is ContentBlock.Thinking -> if (!block.deferred) {
                        thinking = if (thinking == null) block.thinking else thinking + "\n\n" + block.thinking
                    }

                    is ContentBlock.ToolCall -> {
                        val list = calls ?: mutableListOf<ContentBlock.ToolCall>().also { calls = it }
                        list.add(block)
                    }

                    else -> Unit
                }
            }
            return StreamingTurn(
                text = text.orEmpty(),
                thinking = thinking.orEmpty(),
                // Copied, never aliased: the models are declared stable in
                // app/compose-stability.conf and that promise is only true if
                // nothing keeps a handle on a list a model holds.
                toolCalls = calls?.toList() ?: emptyList(),
            )
        }
    }
}

/**
 * A transcript as the screen draws it: settled rows, plus at most one message
 * still arriving.
 *
 * The split is structural rather than cosmetic. Keeping the streaming message
 * out of [rows] is mechanism 1 of docs/android-ux.md §6.5 — the live item is its
 * own `item(key = "live")`, so a token delta invalidates that one item and no
 * committed row at all.
 */
public data class Transcript(
    public val rows: List<TranscriptRow> = emptyList(),
    public val streaming: StreamingTurn? = null,
    /**
     * `toolCallId` → `toolName` for every call seen in this session.
     *
     * A tool result names the call it answers by id; whether it also repeats the
     * *name* is up to the engine. This index is what lets a result card be
     * labelled with the tool it belongs to instead of an anonymous placeholder.
     */
    public val toolNames: Map<String, String> = emptyMap(),
    /** Monotonic suffix source for the keys of rows that arrived as frames. */
    public val streamKeySeq: Int = 0,
    /**
     * Key of the row this client added for a prompt it has just sent, before the
     * engine echoed it back. Cleared the moment the echo is consumed, so that a
     * later steering message with identical text is still drawn.
     */
    public val pendingLocalKey: String? = null,
) {
    public val isEmpty: Boolean get() = rows.isEmpty() && streaming == null

    /** Rows plus the live item, i.e. what the list actually shows. */
    public val itemCount: Int get() = rows.size + if (streaming == null) 0 else 1

    public companion object {
        /**
         * Builds a transcript from `GET /api/sessions/{id}`.
         *
         * `entryIds` is documented as parallel to `messages`, but a transcript is
         * user data and the app must not crash if it is ever short: the
         * index-based fallback keeps keys unique either way. Messages the server
         * marked as not for display are dropped, exactly as the stream path drops
         * them.
         */
        public fun of(messages: List<ChatMessage>, entryIds: List<String>): Transcript {
            val rows = ArrayList<TranscriptRow>(messages.size)
            val names = HashMap<String, String>()
            messages.forEachIndexed { index, message ->
                if (message is ChatMessage.Custom && !message.display) return@forEachIndexed
                val entryId = entryIds.getOrNull(index)
                rows.add(
                    TranscriptRow(
                        key = if (entryId.isNullOrBlank()) "index-$index" else entryId,
                        message = message,
                    ),
                )
                names.putAll(message.toolCallNames())
            }
            return Transcript(rows = rows, toolNames = names)
        }
    }
}

/**
 * Applies one stream frame to the chat state.
 *
 * Pure, total, and the only place transcript mutation lives — which is what makes
 * the semantics testable without a server, an emulator or a clock. The rules are
 * lifted from `hooks/useAgentSession.ts` rather than invented; the two that are
 * easy to miss and expensive to get wrong:
 *
 * 1. **`running` is the gate.** Every run-scoped frame is dropped unless a turn
 *    is known to be in flight. Frames buffered by the transport and flushed after
 *    a turn settled belong to a superseded run; applying them resurrects a ghost
 *    streaming bubble or duplicates a message the authoritative reload already
 *    has. The frames carry no run id, so this flag is the only fence available —
 *    the web client fences the same way.
 * 2. **[AgentEvent.MessageProgress] replaces.** The frame carries the full
 *    accumulated message because the server coalesces consecutive updates under
 *    backpressure. Appending duplicates text; the duplication is silent and looks
 *    like a model repeating itself.
 */
public fun ChatState.reduce(event: AgentEvent): ChatState = when (event) {
    // "Stream open", NOT "agent ready": the route sends this before it spawns
    // the engine.
    is AgentEvent.Connected -> this

    is AgentEvent.Notice -> if (event.isError) copy(notice = event.message) else this

    AgentEvent.AgentStart -> copy(running = true, phase = TurnPhase.Waiting)
        .mapTranscript { it.copy(streaming = null) }

    is AgentEvent.AgentEnd -> when {
        // An async delivery resumes this same run; the turn is not over.
        !event.terminal -> this
        // Late duplicate for a run already settled.
        !running -> this
        else -> settle()
    }

    is AgentEvent.MessageProgress -> when {
        !running -> this
        // Only assistant bubbles stream. A user message reaching this frame is
        // an echo of a delivery and belongs in the transcript, not in the live
        // item — it arrives again as message_end.
        event.message !is ChatMessage.Assistant -> this
        else -> copy(phase = TurnPhase.Streaming)
            .mapTranscript { it.copy(streaming = StreamingTurn.of(event.message)) }
    }

    is AgentEvent.MessageSettled ->
        if (!running) this
        else copy(phase = TurnPhase.Waiting).mapTranscript { it.commit(event.message) }

    is AgentEvent.ToolStart ->
        if (!running) this
        else copy(phase = phase.withTool(RunningTool(event.toolCallId, event.toolName)))
            .mapTranscript { it.rememberTool(event.toolCallId, event.toolName) }

    is AgentEvent.ToolEnd ->
        if (!running) this else copy(phase = phase.withoutTool(event.toolCallId))

    // Terminal in its own right: no agent_end follows a failed prompt, so a
    // client that waits for one keeps the composer locked.
    is AgentEvent.PromptFailed -> {
        val noticed = if (event.message.isBlank()) this else copy(notice = event.message)
        if (running) noticed.settle() else noticed
    }

    // A prompt a builtin or extension answered entirely: no agent_start /
    // agent_end pair will follow it either.
    is AgentEvent.PromptHandled -> if (event.agentInvoked || !running) this else settle()

    is AgentEvent.Other -> this
}

/** Ends the turn: nothing more is expected for it. */
internal fun ChatState.settle(): ChatState =
    copy(running = false, cancelling = false, phase = TurnPhase.Idle)
        .mapTranscript { it.copy(streaming = null, pendingLocalKey = null) }

/**
 * Adds the row this client draws for a prompt it is sending, before the engine
 * echoes it back. Without it the user's own text does not appear until the echo
 * arrives — or at all, on a backend with no event stream.
 */
internal fun Transcript.withLocalPrompt(text: String): Transcript {
    val key = "local-$streamKeySeq"
    return copy(
        rows = rows + TranscriptRow(key, ChatMessage.User(MessageContent.of(text))),
        streamKeySeq = streamKeySeq + 1,
        pendingLocalKey = key,
    )
}

/** Records a `(toolCallId, toolName)` pair a later result can be matched against. */
private fun Transcript.rememberTool(toolCallId: String, toolName: String): Transcript =
    if (toolCallId.isBlank() || toolName.isBlank() || toolNames[toolCallId] == toolName) this
    else copy(toolNames = toolNames + (toolCallId to toolName))

/** Moves a settled message out of the live item and into the row list. */
private fun Transcript.commit(message: ChatMessage): Transcript {
    // Honour the server's own "do not show this" flag, exactly as a file-loaded
    // transcript does. Dropping it here rather than in the UI keeps the two
    // paths agreeing about what a transcript contains.
    if (message is ChatMessage.Custom && !message.display) return copy(streaming = null)

    val resolved = if (message is ChatMessage.ToolResult && message.toolName.isNullOrBlank()) {
        message.copy(toolName = toolNames[message.toolCallId])
    } else {
        message
    }

    val local = pendingLocalKey
    if (resolved is ChatMessage.User && local != null && rows.lastOrNull()?.key == local) {
        // The engine's echo of the prompt we optimistically drew. Replace the
        // local row with the authoritative one rather than appending a second
        // copy of the same text, and consume the marker so the NEXT user
        // message — a steering delivery, possibly with identical text — is
        // drawn in full.
        return copy(
            rows = rows.dropLast(1) + TranscriptRow(local, resolved),
            streaming = null,
            pendingLocalKey = null,
        )
    }

    val names = resolved.toolCallNames()
    return copy(
        rows = rows + TranscriptRow("stream-$streamKeySeq", resolved),
        streaming = null,
        toolNames = if (names.isEmpty()) toolNames else toolNames + names,
        streamKeySeq = streamKeySeq + 1,
        pendingLocalKey = if (resolved is ChatMessage.User) null else local,
    )
}

/** Every `toolCallId` → `toolName` this message announces. */
private fun ChatMessage.toolCallNames(): Map<String, String> {
    if (this !is ChatMessage.Assistant) return emptyMap()
    var names: MutableMap<String, String>? = null
    for (block in content.blocks) {
        if (block !is ContentBlock.ToolCall) continue
        if (block.toolCallId.isBlank() || block.toolName.isBlank()) continue
        val target = names ?: HashMap<String, String>().also { names = it }
        target[block.toolCallId] = block.toolName
    }
    return names ?: emptyMap()
}

private fun TurnPhase.withTool(tool: RunningTool): TurnPhase {
    val running = (this as? TurnPhase.Tools)?.running.orEmpty()
    if (running.any { it.toolCallId == tool.toolCallId }) return this
    return TurnPhase.Tools(running + tool)
}

private fun TurnPhase.withoutTool(toolCallId: String): TurnPhase {
    val running = (this as? TurnPhase.Tools)?.running ?: return this
    val remaining = running.filterNot { it.toolCallId == toolCallId }
    // Back to waiting on the model, not idle: the turn is still running.
    return if (remaining.isEmpty()) TurnPhase.Waiting else TurnPhase.Tools(remaining)
}

/**
 * Applies [block] to a loaded transcript, leaving a loading or failed one alone.
 *
 * Frames only ever arrive against a loaded transcript — `ChatModel` attaches the
 * stream after the first load resolves and refuses to send before it — so this is
 * a guard, not a code path with behaviour of its own.
 */
internal inline fun ChatState.mapTranscript(block: (Transcript) -> Transcript): ChatState {
    val ready = transcript as? Loadable.Ready ?: return this
    return copy(transcript = Loadable.Ready(block(ready.value)))
}
