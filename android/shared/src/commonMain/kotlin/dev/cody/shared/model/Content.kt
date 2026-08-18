package dev.cody.shared.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNames
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement

/**
 * One block of message content, mirroring the server's `TextContent |
 * ImageContent | ThinkingContent | ToolCallContent` union (lib/types.ts).
 *
 * [Unknown] is the forward-compatibility escape hatch: a newer server may add a
 * block type, and one unrecognised block must degrade to a placeholder rather
 * than fail the surrounding transcript.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
public sealed interface ContentBlock {

    @Serializable
    @SerialName("text")
    public data class Text(public val text: String = "") : ContentBlock

    @Serializable
    @SerialName("thinking")
    public data class Thinking(
        public val thinking: String = "",
        /** Server omitted the body; it is fetched on demand and is not shown inline. */
        public val deferred: Boolean = false,
    ) : ContentBlock

    /**
     * Image block. The server persists a flat `{data, mimeType}` shape, while
     * older entries used a nested Anthropic-style `source` object; both are
     * accepted, exactly as the web UI accepts both.
     */
    @Serializable
    @SerialName("image")
    public data class Image(
        public val mimeType: String? = null,
        public val data: String? = null,
        public val source: ImageSource? = null,
    ) : ContentBlock {
        public val effectiveMimeType: String? get() = mimeType ?: source?.mediaType
        /** Base64 payload, from whichever shape carried it. */
        public val base64: String? get() = data ?: source?.data
        /** Set instead of [base64] when the server deferred the image to a URL. */
        public val url: String? get() = source?.url
    }

    /**
     * A tool invocation.
     *
     * Two field spellings reach this client and both are load-bearing. The
     * session file — and therefore `GET /api/sessions/{id}` — carries
     * `{toolCallId, toolName, input}` because `lib/normalize.ts` rewrites it on
     * the way out. The LIVE event stream does not go through that rewrite: its
     * `message_*` frames carry the raw on-disk spelling `{id, name, arguments}`
     * (see `lib/harness/claude-stream.ts`, and `normalizeToolCalls` being called
     * again on every streamed frame in `hooks/useAgentSession.ts`). Accepting
     * both here is what makes one model serve both sources; without it a
     * streamed tool call decodes with an empty id and no result can ever be
     * matched to it.
     */
    @Serializable
    @SerialName("toolCall")
    public data class ToolCall(
        @JsonNames("id") public val toolCallId: String = "",
        @JsonNames("name") public val toolName: String = "",
        @JsonNames("arguments") public val input: JsonObject = JsonObject(emptyMap()),
    ) : ContentBlock

    /** A block type this build does not understand. [kind] is the wire `type`. */
    @Serializable
    @SerialName("__unknown")
    public data class Unknown(public val kind: String = "") : ContentBlock
}

@Serializable
public data class ImageSource(
    public val type: String? = null,
    @SerialName("media_type") public val mediaType: String? = null,
    public val data: String? = null,
    public val url: String? = null,
)

/**
 * A message body, normalised to a block list.
 *
 * The server types several `content` fields as `string | Block[]` — a plain
 * string for simple messages, an array once images or tool calls are involved.
 * Normalising at the edge means no screen ever branches on which shape arrived.
 */
@Serializable(with = MessageContentSerializer::class)
public data class MessageContent(public val blocks: List<ContentBlock> = emptyList()) {

    /** Renderable text, tool calls and thinking excluded. */
    public val text: String
        get() = blocks.filterIsInstance<ContentBlock.Text>()
            .joinToString("\n\n") { it.text }
            .trim()

    public val isEmpty: Boolean get() = blocks.isEmpty()

    public companion object {
        public val Empty: MessageContent = MessageContent(emptyList())
        public fun of(text: String): MessageContent = MessageContent(listOf(ContentBlock.Text(text)))
    }
}

public object MessageContentSerializer : KSerializer<MessageContent> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): MessageContent {
        val input = decoder as? JsonDecoder
            ?: throw SerializationException("MessageContent can only be read from JSON")
        return MessageContent(blocksOf(input.decodeJsonElement(), input.json))
    }

    override fun serialize(encoder: Encoder, value: MessageContent) {
        val output = encoder as? JsonEncoder
            ?: throw SerializationException("MessageContent can only be written as JSON")
        // Always the array form. The client only ever sends `{type:"prompt",
        // message:"..."}`, so this path exists for round-trip tests and local
        // persistence, never to satisfy a server contract.
        output.encodeJsonElement(
            JsonArray(value.blocks.map { output.json.encodeToJsonElement(it) }),
        )
    }

    private fun blocksOf(element: JsonElement, json: Json): List<ContentBlock> = when (element) {
        // A bare string is the common case for user/developer messages.
        is JsonPrimitive -> if (element.isString) listOf(ContentBlock.Text(element.content)) else emptyList()
        is JsonArray -> element.map { block(it, json) }
        is JsonObject -> listOf(block(element, json))
    }

    private fun block(element: JsonElement, json: Json): ContentBlock =
        try {
            json.decodeFromJsonElement(ContentBlock.serializer(), element)
        } catch (_: SerializationException) {
            ContentBlock.Unknown(wireType(element))
        }

    private fun wireType(element: JsonElement): String {
        val type = (element as? JsonObject)?.get("type") as? JsonPrimitive
        return type?.content ?: "unknown"
    }
}
