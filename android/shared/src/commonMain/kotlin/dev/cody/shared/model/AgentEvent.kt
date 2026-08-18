package dev.cody.shared.model

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A frame from the agent event stream (`GET /api/agent/{id}/events`).
 *
 * Only the two frames whose shape is part of the route's own source are modelled
 * ([Connected] and [Notice]); everything else is carried as [Other] with its
 * wire `type` intact. That is a deliberate limit, not an omission: inventing
 * typed events for a vocabulary this client has not verified would be a
 * confident-looking guess, and the phase-1 chat screen only needs to know THAT
 * the session moved, not the internal shape of every step (see
 * `ChatModel.watch`).
 */
public sealed interface AgentEvent {
    /** The wire `type` of the frame, for logging and for [Other]. */
    public val type: String

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

    public data class Other(
        override val type: String,
        public val data: JsonObject,
    ) : AgentEvent

    public companion object {
        /** Maps one decoded SSE `data:` payload onto the model above. */
        public fun from(frame: JsonObject): AgentEvent {
            val type = (frame["type"] as? JsonPrimitive)?.content ?: return Other("", frame)
            return when (type) {
                "connected" -> Connected((frame["sessionId"] as? JsonPrimitive)?.content ?: "")
                "notice" -> Notice(
                    level = (frame["level"] as? JsonPrimitive)?.content ?: "info",
                    message = (frame["message"] as? JsonPrimitive)?.content ?: "",
                )
                else -> Other(type, frame)
            }
        }
    }
}
