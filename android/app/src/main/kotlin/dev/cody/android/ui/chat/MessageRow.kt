package dev.cody.android.ui.chat

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.cody.android.R
import dev.cody.android.ui.theme.LocalCodyColors
import dev.cody.android.ui.theme.ToolCardRadius
import dev.cody.shared.model.ChatMessage
import dev.cody.shared.model.ContentBlock
import dev.cody.shared.model.MessageContent
import dev.cody.shared.presentation.StreamingTurn

/**
 * One transcript row.
 *
 * Long machine output is capped rather than rendered whole: a tool result can be
 * tens of thousands of lines, and a `LazyColumn` item that measures all of it
 * stalls the frame that scrolls it into view. The cap is a display decision only
 * — nothing is dropped from the model.
 */
@Composable
fun MessageRow(message: ChatMessage, modifier: Modifier = Modifier) {
    when (message) {
        is ChatMessage.User -> UserRow(message, modifier)
        is ChatMessage.Assistant -> AssistantRow(message, modifier)
        is ChatMessage.ToolResult -> ToolResultRow(message, modifier)
        is ChatMessage.Bash -> CommandRow(
            label = stringResource(R.string.chat_shell),
            source = message.command,
            output = message.output,
            exitCode = message.exitCode,
            cancelled = message.cancelled,
            truncated = message.truncated,
            modifier = modifier,
        )
        is ChatMessage.Python -> CommandRow(
            label = stringResource(R.string.chat_python),
            source = message.code,
            output = message.output,
            exitCode = message.exitCode,
            cancelled = message.cancelled,
            truncated = message.truncated,
            modifier = modifier,
        )
        is ChatMessage.Developer -> MetaRow(
            label = stringResource(R.string.chat_role_developer),
            body = message.content.text,
            modifier = modifier,
        )
        is ChatMessage.Custom -> MetaRow(
            label = message.customType,
            body = message.content.text,
            modifier = modifier,
        )
        is ChatMessage.FileMention -> MetaRow(
            label = stringResource(R.string.chat_files_read, message.files.size),
            body = message.files.joinToString("\n") { it.path },
            modifier = modifier,
        )
        is ChatMessage.Unknown -> MetaRow(
            label = stringResource(R.string.chat_unsupported_message, message.role),
            body = "",
            modifier = modifier,
        )
    }
}

@Composable
private fun UserRow(message: ChatMessage.User, modifier: Modifier) {
    Column(modifier = modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        RoleLabel(stringResource(R.string.chat_role_user))
        Surface(
            color = MaterialTheme.colorScheme.primaryContainer,
            shape = MaterialTheme.shapes.medium,
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                BlockList(message.content, MaterialTheme.colorScheme.onPrimaryContainer)
            }
        }
    }
}

@Composable
private fun AssistantRow(message: ChatMessage.Assistant, modifier: Modifier) {
    Column(
        modifier = modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        RoleLabel(stringResource(R.string.chat_role_assistant))
        BlockList(message.content, MaterialTheme.colorScheme.onSurface)
        message.errorMessage?.takeIf { it.isNotBlank() }?.let { error ->
            Text(
                text = stringResource(R.string.chat_turn_failed, error),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/** Renders every block of a message body in order. */
@Composable
private fun BlockList(content: MessageContent, textColor: Color) {
    val cody = LocalCodyColors.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        content.blocks.forEach { block ->
            when (block) {
                is ContentBlock.Text -> if (block.text.isNotBlank()) {
                    Text(
                        text = block.text,
                        style = MaterialTheme.typography.bodyMedium,
                        color = textColor,
                    )
                }

                is ContentBlock.Thinking -> Text(
                    text = if (block.deferred || block.thinking.isBlank()) {
                        stringResource(R.string.chat_thinking_deferred)
                    } else {
                        block.thinking
                    },
                    style = MaterialTheme.typography.bodySmall,
                    fontStyle = FontStyle.Italic,
                    color = cody.textDim,
                    maxLines = THINKING_MAX_LINES,
                    overflow = TextOverflow.Ellipsis,
                )

                is ContentBlock.ToolCall -> ToolCard(
                    title = stringResource(R.string.chat_tool_call, block.toolName),
                    body = block.input.toString(),
                    accent = cody.success,
                )

                is ContentBlock.Image -> Chip(
                    label = stringResource(R.string.chat_image),
                    color = cody.textDim,
                )

                is ContentBlock.Unknown -> Chip(
                    label = stringResource(R.string.chat_unsupported_block, block.kind),
                    color = cody.textDim,
                )
            }
        }
    }
}

@Composable
private fun ToolResultRow(message: ChatMessage.ToolResult, modifier: Modifier) {
    val cody = LocalCodyColors.current
    val name = message.toolName?.takeIf { it.isNotBlank() }
    Column(modifier = modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        ToolCard(
            title = if (name != null) {
                stringResource(R.string.chat_tool_result, name)
            } else {
                stringResource(R.string.chat_tool_result_untitled)
            },
            body = message.content.text,
            accent = if (message.isError) MaterialTheme.colorScheme.error else cody.success,
            trailing = if (message.isError) stringResource(R.string.chat_tool_failed) else null,
        )
    }
}

@Composable
private fun CommandRow(
    label: String,
    source: String,
    output: String,
    exitCode: Int?,
    cancelled: Boolean,
    truncated: Boolean,
    modifier: Modifier,
) {
    val cody = LocalCodyColors.current
    val notes = buildList {
        // `!= 0` deliberately, not a truthiness check: exit code 0 is success and
        // must not read as "no exit code".
        if (exitCode != null && exitCode != 0) add(stringResource(R.string.chat_exit_code, exitCode))
        if (cancelled) add(stringResource(R.string.chat_cancelled))
        if (truncated) add(stringResource(R.string.chat_truncated))
    }
    Column(modifier = modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        ToolCard(
            title = label,
            body = buildString {
                append(source.trim())
                if (output.isNotBlank()) {
                    append("\n\n")
                    append(output.trim())
                }
            },
            accent = if (exitCode != null && exitCode != 0) MaterialTheme.colorScheme.error else cody.textDim,
            trailing = notes.takeIf { it.isNotEmpty() }?.joinToString(" · "),
        )
    }
}

/**
 * The tool-call frame: a hairline card at 7dp, matching `ToolCallBlock` on the
 * web, over the 5% ink wash rather than a solid surface.
 */
@Composable
private fun ToolCard(
    title: String,
    body: String,
    accent: Color,
    trailing: String? = null,
) {
    val cody = LocalCodyColors.current
    Surface(
        color = cody.inkWash,
        shape = RoundedCornerShape(ToolCardRadius),
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, cody.border, RoundedCornerShape(ToolCardRadius)),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.labelMedium,
                    color = accent,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                trailing?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                        maxLines = 1,
                    )
                }
            }
            if (body.isNotBlank()) {
                Text(
                    text = body,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = OUTPUT_MAX_LINES,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun MetaRow(label: String, body: String, modifier: Modifier) {
    val cody = LocalCodyColors.current
    Column(
        modifier = modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = cody.textDim,
        )
        if (body.isNotBlank()) {
            Text(
                text = body,
                style = MaterialTheme.typography.bodySmall,
                color = cody.textDim,
                maxLines = META_MAX_LINES,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun RoleLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = LocalCodyColors.current.textDim,
        modifier = Modifier.padding(bottom = 3.dp),
    )
}

@Composable
private fun Chip(label: String, color: Color) {
    Surface(
        color = LocalCodyColors.current.inkWash,
        shape = MaterialTheme.shapes.extraSmall,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = color,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
    }
}

/**
 * The live item: the assistant message currently arriving.
 *
 * The one row in the list that is invalidated by a token delta, which is why it
 * draws from pre-flattened strings ([StreamingTurn], built on `Dispatchers.Default`
 * in `ChatModel`) rather than walking a block list here. No markdown parsing and
 * no string joining happen in this composable — docs/android-ux.md §6.8.
 *
 * The tail marker is a text glyph appended to the same `Text`, not a second
 * composable beside it: a separate node would have to be measured and positioned
 * against a paragraph whose last line moves on every frame.
 */
@Composable
fun StreamingRow(turn: StreamingTurn, modifier: Modifier = Modifier) {
    val cody = LocalCodyColors.current
    Column(
        modifier = modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        RoleLabel(stringResource(R.string.chat_role_assistant))

        if (turn.thinking.isNotBlank()) {
            Text(
                text = turn.thinking,
                style = MaterialTheme.typography.bodySmall,
                fontStyle = FontStyle.Italic,
                color = cody.textDim,
                maxLines = THINKING_MAX_LINES,
                overflow = TextOverflow.Ellipsis,
            )
        }

        if (turn.text.isNotEmpty()) {
            Text(
                text = turn.text + TAIL_MARKER,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }

        turn.toolCalls.forEach { call ->
            ToolCard(
                title = stringResource(R.string.chat_tool_call, call.toolName),
                body = call.input.toString(),
                accent = cody.success,
            )
        }
    }
}

/**
 * LazyColumn reuse bucket for a row.
 *
 * Rows of different shapes must not reuse each other's nodes: a `UserRow` slot
 * recycled into a `ToolCard` throws away every measured subtree it had. String
 * constants rather than `::class`, because a `KClass` lookup allocates and this
 * runs for every visible item on every relayout.
 */
fun ChatMessage.contentTypeKey(): String = when (this) {
    is ChatMessage.User -> "user"
    is ChatMessage.Assistant -> "assistant"
    is ChatMessage.ToolResult -> "toolResult"
    is ChatMessage.Bash -> "bash"
    is ChatMessage.Python -> "python"
    is ChatMessage.Developer -> "developer"
    is ChatMessage.Custom -> "custom"
    is ChatMessage.FileMention -> "fileMention"
    is ChatMessage.Unknown -> "unknown"
}

private const val OUTPUT_MAX_LINES = 14
private const val THINKING_MAX_LINES = 8
private const val META_MAX_LINES = 6

/**
 * Tail marker on the streaming paragraph.
 *
 * A character, not an animated cursor: a blinking node inside a `LazyColumn` item
 * would re-lay-out that item on every blink, which is exactly the pattern
 * docs/android-ux.md §6.6 forbids inside the transcript.
 */
private const val TAIL_MARKER = "\u2588"
