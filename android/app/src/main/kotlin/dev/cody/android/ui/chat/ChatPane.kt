package dev.cody.android.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.cody.android.R
import dev.cody.android.ui.common.CodyTopBar
import dev.cody.android.ui.common.Hairline
import dev.cody.android.ui.common.StatusDot
import dev.cody.android.ui.common.StatusPane
import dev.cody.android.ui.common.failureMessage
import dev.cody.android.ui.theme.LocalCodyColors
import dev.cody.shared.presentation.ChatState
import dev.cody.shared.presentation.Loadable
import dev.cody.shared.presentation.Transcript
import dev.cody.shared.presentation.TurnPhase
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * One session's transcript, plus the composer.
 *
 * ### Entry point
 *
 * This is the top-level composable for the chat surface. It reads state and calls
 * back; it owns no models and knows nothing about navigation or window size.
 *
 * @param onBack supplied only when this pane owns the whole window; null in the
 *   two-pane layout, where the list is still on screen and a back affordance
 *   would be a lie. The pane does not work out which case it is in — see
 *   docs/android-ux.md §2.3.
 * @param canSend the backend's `prompts` capability. Also gates "new session":
 *   creating a session you cannot prompt is a dead end, not a feature.
 * @param onCancelTurn abort the turn in flight. Only reachable while one is.
 * @param onNewSession create a session rooted at the given absolute path.
 *
 * ### Fluidity
 *
 * Three things here are load-bearing rather than stylistic, all from
 * docs/android-ux.md §6:
 *
 * 1. The streaming message is its own `item(key = "live")`. A token delta
 *    invalidates that item and nothing else — no committed row reads live state.
 * 2. Nothing reads `listState.layoutInfo` in composition. `atBottom` goes through
 *    `derivedStateOf`, so a finger on the screen does not recompose this scope
 *    120 times a second.
 * 3. Scroll-following is driven by ONE long-lived coroutine fed by a conflated
 *    `StateFlow`, not by a `LaunchedEffect` whose key changes per token. Several
 *    tokens landing inside one frame therefore cost one scroll, not several.
 */
@Composable
fun ChatPane(
    state: ChatState,
    canSend: Boolean,
    onBack: (() -> Unit)?,
    onSend: (String) -> Unit,
    onCancelTurn: () -> Unit,
    onNewSession: (String) -> Unit,
    onDismissNotice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var newSessionOpen by remember { mutableStateOf(false) }
    // Any session change closes the dialog: either this one succeeded, or the
    // user picked a row from the list and the dialog is stale either way.
    LaunchedEffect(state.session?.id) { newSessionOpen = false }

    if (newSessionOpen) {
        NewSessionDialog(
            suggestedCwd = state.session?.root.orEmpty(),
            busy = state.creating,
            failure = state.createFailure,
            onDismiss = { newSessionOpen = false },
            onCreate = onNewSession,
        )
    }

    val onNew: (() -> Unit)? = if (canSend) ({ newSessionOpen = true }) else null
    val session = state.session

    if (session == null) {
        Column(modifier = modifier.fillMaxSize()) {
            ChatTopBar(title = null, live = false, phase = TurnPhase.Idle, onBack = null, onNewSession = onNew)
            StatusPane(message = stringResource(R.string.chat_pick_session))
        }
        return
    }

    var draft by remember(session.id) { mutableStateOf("") }
    // Bumped on every prompt this pane sends. The only thing besides a session
    // switch that is allowed to re-arm tail-following.
    var promptEpoch by remember(session.id) { mutableStateOf(0) }

    Column(modifier = modifier.fillMaxSize()) {
        ChatTopBar(
            title = session.label,
            live = state.live,
            phase = state.phase,
            onBack = onBack,
            onNewSession = onNew,
        )

        state.notice?.let { notice -> NoticeBanner(notice, onDismissNotice) }

        when (val transcript = state.transcript) {
            Loadable.Idle, Loadable.Loading -> StatusPane(
                message = stringResource(R.string.chat_loading),
                busy = true,
                modifier = Modifier.weight(1f),
            )

            is Loadable.Failed -> StatusPane(
                message = failureMessage(transcript.failure, transcript.code),
                modifier = Modifier.weight(1f),
            )

            is Loadable.Ready -> TranscriptList(
                transcript = transcript.value,
                // A session this app created a moment ago carries no server
                // timestamps; say "this is new" rather than the generic line,
                // which reads like something failed to load.
                emptyMessage = stringResource(
                    if (session.created == null) R.string.session_new_empty else R.string.chat_empty,
                ),
                sessionId = session.id,
                promptEpoch = promptEpoch,
                modifier = Modifier.weight(1f),
            )
        }

        if (canSend) {
            Hairline()
            Composer(
                draft = draft,
                sending = state.sending,
                running = state.running,
                cancelling = state.cancelling,
                onDraftChange = { draft = it },
                onSend = {
                    val body = draft
                    draft = ""
                    promptEpoch++
                    onSend(body)
                },
                onCancel = onCancelTurn,
            )
        }

        state.sendFailure?.let { failure ->
            InlineError(failureMessage(failure))
        }
        state.cancelFailure?.let { failure ->
            InlineError(stringResource(R.string.chat_cancel_failed, failureMessage(failure)))
        }
    }
}

/**
 * The transcript, its live tail, and the scroll-follow policy.
 *
 * Follow rule, matching the web client: the view tracks the tail while a turn
 * streams, and a manual drag wins immediately and stops the following. It resumes
 * on the next prompt, or when the user brings themselves back to the bottom — the
 * same `atBottom` re-arm the web does, because a reader who has scrolled back down
 * has plainly asked to be at the tail again.
 *
 * @param promptEpoch changes when the user sends a prompt or switches session, and
 *   re-arms following. Nothing else may re-arm it: yanking the viewport away from
 *   someone reading history is the single most annoying thing a chat client does.
 */
@Composable
private fun TranscriptList(
    transcript: Transcript,
    emptyMessage: String,
    sessionId: String,
    promptEpoch: Int,
    modifier: Modifier = Modifier,
) {
    if (transcript.isEmpty) {
        StatusPane(message = emptyMessage, modifier = modifier)
        return
    }

    // Keyed on the session, not on the prompt: a new prompt must not throw away
    // the scroll position, and a new session must not inherit one that points into
    // a different transcript. rememberLazyListState would restore across both.
    val listState = remember(sessionId) { LazyListState() }
    var following by remember(sessionId) { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    // Re-arm on the user's own prompt. The whole point of the manual-scroll rule
    // is that nothing ELSE does this.
    LaunchedEffect(promptEpoch) { following = true }

    // derivedStateOf, because layoutInfo is written on every scrolled pixel. An
    // unwrapped read here would recompose this scope while a finger is down
    // (docs/android-ux.md §6.4).
    val atBottom by remember(listState) {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()
            last == null ||
                (last.index == info.totalItemsCount - 1 &&
                    last.offset + last.size <= info.viewportEndOffset + FOLLOW_SLACK_PX)
        }
    }

    LaunchedEffect(listState) {
        // A drag is the only unambiguous signal of intent: a programmatic scroll
        // also sets isScrollInProgress, so that flag alone cannot tell the two
        // apart and would make the transcript stop following itself.
        listState.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Start) following = false
        }
    }

    LaunchedEffect(listState) {
        // Re-arm once everything has settled — including the fling a drag ends
        // with — and only if the user is genuinely back at the tail.
        var wasScrolling = false
        snapshotFlow { listState.isScrollInProgress }.collect { scrolling ->
            if (wasScrolling && !scrolling && atBottom) following = true
            wasScrolling = scrolling
        }
    }

    // The follow signal. A StateFlow rather than a LaunchedEffect key so the whole
    // streaming turn is served by one coroutine, and so several frames arriving
    // inside one displayed frame collapse into a single scroll.
    val followSignal = remember(listState) { MutableStateFlow(0L) }
    SideEffect { followSignal.value = transcript.followSignature() }

    LaunchedEffect(listState, followSignal) {
        var lastCount = -1
        followSignal.collect { signature ->
            val count = (signature ushr TAIL_BITS).toInt()
            if (count == 0) return@collect
            val newItem = count != lastCount
            lastCount = count
            if (!following) return@collect
            if (newItem) {
                listState.animateScrollToItem(count - 1)
            } else {
                // The last item is growing in place, a few pixels per frame.
                // Nudging to the content end clamps; re-animating to the item
                // would restart the animation on every token and fight itself.
                listState.scrollBy(FOLLOW_NUDGE_PX)
            }
        }
    }

    Box(modifier = modifier.fillMaxWidth()) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
        ) {
            // Keyed by the session file's entry id (or a monotonic stream key for
            // rows that do not have one yet), never by index. contentType lets
            // LazyColumn reuse a node only for a row of the same shape.
            items(
                items = transcript.rows,
                key = { it.key },
                contentType = { it.message.contentTypeKey() },
            ) { row ->
                MessageRow(row.message)
            }

            transcript.streaming?.let { streaming ->
                // The live item, with a constant key: this is mechanism 1 of
                // docs/android-ux.md §6.5. A token delta invalidates this one item
                // and leaves every committed row composed.
                item(key = LIVE_ITEM_KEY, contentType = LIVE_ITEM_KEY) {
                    StreamingRow(streaming)
                }
            }
        }

        if (!atBottom) {
            val itemCount = transcript.itemCount
            JumpToLatest(
                onClick = {
                    following = true
                    scope.launch { listState.animateScrollToItem(itemCount - 1) }
                },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 16.dp, bottom = 16.dp),
            )
        }
    }
}

/**
 * Item count in the high bits, streamed text length in the low bits.
 *
 * One `Long` so the follow coroutine can tell "a new row landed" (animate to it)
 * from "the last row grew" (nudge to the end) without holding a reference to the
 * transcript or comparing lists.
 */
private fun Transcript.followSignature(): Long {
    val tail = streaming?.let { it.text.length + it.thinking.length } ?: 0
    return (itemCount.toLong() shl TAIL_BITS) or (tail.toLong() and TAIL_MASK)
}

@Composable
private fun ChatTopBar(
    title: String?,
    live: Boolean,
    phase: TurnPhase,
    onBack: (() -> Unit)?,
    onNewSession: (() -> Unit)?,
) {
    CodyTopBar {
        if (onBack != null) {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = stringResource(R.string.action_back),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Text(
            text = title ?: stringResource(R.string.sessions_title),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(start = if (onBack == null) 8.dp else 0.dp)
                .weight(1f),
        )

        val phaseText = phaseLabel(phase)
        if (live || phaseText != null) {
            val cody = LocalCodyColors.current
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                modifier = Modifier.padding(end = 4.dp),
            ) {
                StatusDot(color = cody.success)
                Text(
                    // The phase is the more specific truth, so it wins the label
                    // when there is one; "Live" alone means the stream is attached
                    // and nothing is running.
                    text = phaseText ?: stringResource(R.string.chat_live),
                    style = MaterialTheme.typography.labelSmall,
                    color = cody.success,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (onNewSession != null) {
            IconButton(onClick = onNewSession) {
                Icon(
                    imageVector = Icons.Default.Add,
                    contentDescription = stringResource(R.string.session_new),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun phaseLabel(phase: TurnPhase): String? = when (phase) {
    TurnPhase.Idle -> null
    TurnPhase.Waiting -> stringResource(R.string.chat_phase_waiting)
    TurnPhase.Streaming -> stringResource(R.string.chat_phase_replying)
    is TurnPhase.Tools -> phase.running.singleOrNull()
        ?.let { stringResource(R.string.chat_phase_tool, it.toolName) }
        ?: stringResource(R.string.chat_phase_tools, phase.running.size)
}

@Composable
private fun JumpToLatest(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surfaceContainerHighest,
        border = BorderStroke(1.dp, LocalCodyColors.current.border),
    ) {
        IconButton(onClick = onClick) {
            Icon(
                imageVector = Icons.Default.KeyboardArrowDown,
                contentDescription = stringResource(R.string.chat_jump_to_latest),
                tint = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun InlineError(message: String) {
    Text(
        text = message,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
    )
}

@Composable
private fun NoticeBanner(notice: String, onDismiss: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.errorContainer) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = notice,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onDismiss) {
                Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = stringResource(R.string.action_dismiss),
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                )
            }
        }
    }
}

/**
 * The composer.
 *
 * While a turn runs the trailing control is Stop, not Send: this client has no
 * steering channel, so a second prompt cannot go anywhere until the turn ends. The
 * field stays editable throughout, so the next prompt can be written while the
 * current one runs.
 */
@Composable
private fun Composer(
    draft: String,
    sending: Boolean,
    running: Boolean,
    cancelling: Boolean,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
    onCancel: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            // The composer owns the bottom edge, which is why there is no
            // NavigationBar at any size: the two would stack under the IME.
            .imePadding()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = onDraftChange,
            placeholder = { Text(stringResource(R.string.chat_composer_hint)) },
            enabled = !sending,
            maxLines = COMPOSER_MAX_LINES,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
            modifier = Modifier.weight(1f),
        )
        when {
            sending -> IconButton(onClick = { }, enabled = false) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    color = MaterialTheme.colorScheme.primary,
                )
            }

            running -> {
                val stopLabel = stringResource(
                    if (cancelling) R.string.chat_stopping else R.string.chat_stop,
                )
                IconButton(
                    onClick = onCancel,
                    enabled = !cancelling,
                    modifier = Modifier.semantics { contentDescription = stopLabel },
                ) {
                    // A filled square, drawn rather than iconified: the stop glyph
                    // lives in the extended Material icon set, and pulling that
                    // whole dependency in for one 14dp square is not a trade worth
                    // making.
                    Surface(
                        modifier = Modifier.size(14.dp),
                        shape = RoundedCornerShape(2.dp),
                        color = if (cancelling) {
                            LocalCodyColors.current.textDim
                        } else {
                            MaterialTheme.colorScheme.error
                        },
                        content = {},
                    )
                }
            }

            else -> IconButton(onClick = onSend, enabled = draft.isNotBlank()) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Send,
                    contentDescription = stringResource(R.string.chat_send),
                    tint = if (draft.isNotBlank()) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        LocalCodyColors.current.textDim
                    },
                )
            }
        }
    }
}

/** Stable key for the streaming item; the one key in the list that is a constant. */
private const val LIVE_ITEM_KEY = "live"

/** How close to the content end still counts as "at the bottom", in pixels. */
private const val FOLLOW_SLACK_PX = 24

/**
 * Follow nudge, deliberately larger than any single frame's growth.
 *
 * `scrollBy` clamps at the content end, so an over-large delta lands exactly at
 * the tail without needing to know how tall the growing item became.
 */
private const val FOLLOW_NUDGE_PX = 4_000f

/** Bit split of the follow signature: item count above, tail length below. */
private const val TAIL_BITS = 24
private const val TAIL_MASK = (1L shl TAIL_BITS) - 1

private const val COMPOSER_MAX_LINES = 6
