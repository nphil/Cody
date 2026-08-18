package dev.cody.shared.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * One entry of a session transcript, discriminated by the wire's `role` field
 * rather than serialization's default `type` (the server uses `type` for
 * content blocks and `role` for messages, and this mirrors that exactly).
 *
 * Deliberately NOT modelled: `usage`, `contextSnapshot` and `details`. They are
 * decodable but nothing renders them yet, and a field with no reader is a field
 * that silently rots.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("role")
public sealed interface ChatMessage {
    /** Epoch millis; absent on older entries. */
    public val timestamp: Long?

    @Serializable
    @SerialName("user")
    public data class User(
        public val content: MessageContent = MessageContent.Empty,
        override val timestamp: Long? = null,
    ) : ChatMessage

    @Serializable
    @SerialName("assistant")
    public data class Assistant(
        public val content: MessageContent = MessageContent.Empty,
        public val stopReason: String? = null,
        /** Set when the turn failed; the UI shows this instead of empty content. */
        public val errorMessage: String? = null,
        override val timestamp: Long? = null,
    ) : ChatMessage

    @Serializable
    @SerialName("toolResult")
    public data class ToolResult(
        public val toolCallId: String = "",
        public val toolName: String? = null,
        public val content: MessageContent = MessageContent.Empty,
        public val isError: Boolean = false,
        override val timestamp: Long? = null,
    ) : ChatMessage

    @Serializable
    @SerialName("bashExecution")
    public data class Bash(
        public val command: String = "",
        public val output: String = "",
        public val exitCode: Int? = null,
        public val cancelled: Boolean = false,
        public val truncated: Boolean = false,
        override val timestamp: Long? = null,
    ) : ChatMessage

    @Serializable
    @SerialName("pythonExecution")
    public data class Python(
        public val code: String = "",
        public val output: String = "",
        public val exitCode: Int? = null,
        public val cancelled: Boolean = false,
        public val truncated: Boolean = false,
        override val timestamp: Long? = null,
    ) : ChatMessage

    /** System-slot instruction message (steering envelopes, file-mention text). */
    @Serializable
    @SerialName("developer")
    public data class Developer(
        public val content: MessageContent = MessageContent.Empty,
        override val timestamp: Long? = null,
    ) : ChatMessage

    @Serializable
    @SerialName("custom")
    public data class Custom(
        public val customType: String = "",
        public val content: MessageContent = MessageContent.Empty,
        /** The server's own "should this be shown" flag; honour it. */
        public val display: Boolean = true,
        override val timestamp: Long? = null,
    ) : ChatMessage

    @Serializable
    @SerialName("fileMention")
    public data class FileMention(
        public val files: List<MentionedFile> = emptyList(),
        override val timestamp: Long? = null,
    ) : ChatMessage

    /**
     * A role this build does not understand. Not a failure mode: the server
     * gains message kinds over time and an installed app must keep rendering
     * the rest of the transcript around one it cannot draw.
     */
    @Serializable
    @SerialName("__unknown")
    public data class Unknown(
        public val role: String = "",
        override val timestamp: Long? = null,
    ) : ChatMessage
}

@Serializable
public data class MentionedFile(
    public val path: String = "",
    public val byteSize: Long? = null,
    public val skippedReason: String? = null,
)

/**
 * Decodes one transcript entry, degrading an unrecognised or malformed role to
 * [ChatMessage.Unknown] rather than throwing.
 *
 * Shared by the transcript decoder below and by [AgentEvent], because a
 * `message_end` frame carries exactly the same entry shape as a line of the
 * session file. One implementation, so the live stream and the file can never
 * disagree about what a message is.
 */
public fun decodeChatMessage(element: JsonElement, json: Json = CodyJson): ChatMessage =
    try {
        json.decodeFromJsonElement(ChatMessage.serializer(), element)
    } catch (_: SerializationException) {
        ChatMessage.Unknown(role = (element as? JsonObject)?.stringOrNull("role") ?: "unknown")
    }

/** `this[key]` as a string, or null when absent or not a primitive. */
internal fun JsonObject.stringOrNull(key: String): String? =
    (this[key] as? JsonPrimitive)?.content

/**
 * Decodes `context.messages` element by element so a single unrecognised or
 * malformed entry becomes [ChatMessage.Unknown] instead of throwing away the
 * whole transcript. This is the difference between "the app shows one grey
 * placeholder row" and "the app shows an error screen".
 */
public object ChatMessagesSerializer : KSerializer<List<ChatMessage>> {
    override val descriptor: SerialDescriptor = ListSerializer(JsonElement.serializer()).descriptor

    override fun deserialize(decoder: Decoder): List<ChatMessage> {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("Transcript messages can only be read from JSON")
        val array = input.decodeJsonElement() as? JsonArray ?: return emptyList()
        return array.map { decodeChatMessage(it, input.json) }
    }

    override fun serialize(encoder: Encoder, value: List<ChatMessage>) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("Transcript messages can only be written as JSON")
        output.encodeJsonElement(
            JsonArray(value.map { output.json.encodeToJsonElement(ChatMessage.serializer(), it) }),
        )
    }
}
