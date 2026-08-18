package dev.cody.shared.model

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * A frame from the agent event stream (`GET /api/agent/{id}/events`).
 *
 * `connected` and `notice` are the two frames documented as **Stable** in
 * `docs/api.md`; everything else in the vocabulary belongs to the engine and is
 * documented as **Incidental**. The frames modelled below are exactly the subset
 * this client applies to a transcript, mirroring `hooks/useAgentSession.ts`
 * frame for frame. Anything else stays [Other] with its wire `type` intact,
 * because "ignore unknown types silently" is the only forward-compatible policy
 * for an app that ships on its own release train.
 *
 * Two shapes here are easy to get wrong and both are load-bearing:
 *
 * - [MessageProgress] carries the **full accumulated message**, not a delta. The
 *   server says so explicitly (`docs/api.md`: "always replace, never append"),
 *   and the reason is backpressure — consecutive `message_update` frames collapse
 *   to the latest one, so a client that appended would drop text under load and
 *   duplicate it otherwise.
 * - [AgentEnd] with `terminal == false` means an async delivery will resume the
 *   same run. Treating it as the end of the turn unlocks the composer while the
 *   agent is still working.
 */
public sealed interface AgentEvent {
    /** The wire `type` of the frame, for logging and for [Other]. */
    public val type: String

    /**
     * The stream is open. NOT "the agent is ready": the route sends this before
     * it spawns the engine, and a cold start takes seconds.
     */
    public data class Connected(public val sessionId: String) : AgentEvent {
        override val type: String get() = "connected"
    }

    public data class Notice(
        public val level: String,
        public val message: String,
    ) : AgentEvent {
        override val type: String get() = "notice"

        public val isError: Boolean get() = level == "error"
    }

    /** A turn began. */
    public data object AgentStart : AgentEvent {
        override val type: String get() = "agent_start"
    }

    /**
     * A turn ended.
     *
     * @param terminal false when an async delivery will resume this same run, in
     *   which case the turn is NOT over and nothing may be settled.
     */
    public data class AgentEnd(public val terminal: Boolean) : AgentEvent {
        override val type: String get() = "agent_end"
    }

    /**
     * The message being streamed, as accumulated so far — `message_start` or
     * `message_update`. Replaces the streaming message; never appended to.
     */
    public data class MessageProgress(
        override val type: String,
        public val message: ChatMessage,
    ) : AgentEvent

    /** A message reached its final form and belongs in the transcript. */
    public data class MessageSettled(public val message: ChatMessage) : AgentEvent {
        override val type: String get() = "message_end"
    }

    public data class ToolStart(
        public val toolCallId: String,
        public val toolName: String,
    ) : AgentEvent {
        override val type: String get() = "tool_execution_start"
    }

    public data class ToolEnd(
        public val toolCallId: String,
        public val toolName: String,
    ) : AgentEvent {
        override val type: String get() = "tool_execution_end"
    }

    /**
     * The prompt itself failed. Terminal: no [AgentEnd] follows it, so a client
     * that waits for one leaves the composer locked until it gives up.
     */
    public data class PromptFailed(public val message: String) : AgentEvent {
        override val type: String get() = "prompt_error"
    }

    /**
     * A prompt was handled without invoking the agent — a builtin or extension
     * slash command. Also terminal, for the same reason.
     *
     * @param agentInvoked true (the default when the field is absent) means an
     *   ordinary turn is running and this frame says nothing new.
     */
    public data class PromptHandled(public val agentInvoked: Boolean) : AgentEvent {
        override val type: String get() = "prompt_result"
    }

    public data class Other(
        override val type: String,
        public val data: JsonObject,
    ) : AgentEvent

    public companion object {
        /** Maps one decoded SSE `data:` payload onto the model above. */
        public fun from(frame: JsonObject): AgentEvent {
            val type = frame.stringOrNull("type") ?: return Other("", frame)
            return when (type) {
                "connected" -> Connected(frame.stringOrNull("sessionId").orEmpty())
                "notice" -> Notice(
                    level = frame.stringOrNull("level") ?: "info",
                    message = frame.stringOrNull("message").orEmpty(),
                )
                "agent_start" -> AgentStart
                // Absent `isTerminal` means terminal; only an explicit `false`
                // says "an async delivery resumes this run".
                "agent_end" -> AgentEnd(terminal = frame.booleanOrNull("isTerminal") != false)
                "message_start", "message_update" -> frame["message"]
                    ?.let { MessageProgress(type, decodeChatMessage(it)) }
                    ?: Other(type, frame)
                "message_end" -> frame["message"]
                    ?.let { MessageSettled(decodeChatMessage(it)) }
                    ?: Other(type, frame)
                "tool_execution_start" -> ToolStart(
                    toolCallId = frame.stringOrNull("toolCallId").orEmpty(),
                    toolName = frame.stringOrNull("toolName").orEmpty(),
                )
                "tool_execution_end" -> ToolEnd(
                    toolCallId = frame.stringOrNull("toolCallId").orEmpty(),
                    toolName = frame.stringOrNull("toolName").orEmpty(),
                )
                "prompt_error" -> PromptFailed(frame.stringOrNull("errorMessage").orEmpty())
                "prompt_result" -> PromptHandled(agentInvoked = frame.booleanOrNull("agentInvoked") != false)
                else -> Other(type, frame)
            }
        }

        private fun JsonObject.booleanOrNull(key: String): Boolean? =
            (this[key] as? JsonPrimitive)?.booleanOrNull
    }
}
