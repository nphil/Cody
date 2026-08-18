package dev.cody.android.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
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

/**
 * One session's transcript, plus the composer.
 *
 * @param onBack supplied only when this pane owns the whole window; null in the
 *   two-pane layout, where the list is still on screen and a back affordance
 *   would be a lie. The pane does not work out which case it is in — see
 *   docs/android-ux.md §2.3.
 */
@Composable
fun ChatPane(
    state: ChatState,
    canSend: Boolean,
    onBack: (() -> Unit)?,
    onSend: (String) -> Unit,
    onDismissNotice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val session = state.session
    if (session == null) {
        Column(modifier = modifier.fillMaxSize()) {
            CodyTopBar { }
            StatusPane(message = stringResource(R.string.chat_pick_session))
        }
        return
    }

    var draft by remember(session.id) { mutableStateOf("") }
    val listState = rememberLazyListState()
    val rows = (state.transcript as? Loadable.Ready)?.value.orEmpty()

    // Follow the tail only when the user is already reading it. Yanking the view
    // down while they are scrolled up in history is the single most annoying
    // thing a chat client can do.
    LaunchedEffect(rows.size) {
        if (rows.isEmpty()) return@LaunchedEffect
        val lastVisible = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index
        val nearTail = lastVisible == null || lastVisible >= rows.size - 1 - FOLLOW_SLACK
        if (nearTail) listState.animateScrollToItem(rows.lastIndex)
    }

    Column(modifier = modifier.fillMaxSize()) {
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
                text = session.label,
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .padding(start = if (onBack == null) 8.dp else 0.dp)
                    .weight(1f),
            )
            if (state.live) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                    modifier = Modifier.padding(end = 8.dp),
                ) {
                    StatusDot(color = LocalCodyColors.current.success)
                    Text(
                        text = stringResource(R.string.chat_live),
                        style = MaterialTheme.typography.labelSmall,
                        color = LocalCodyColors.current.success,
                    )
                }
            }
        }

        state.notice?.let { notice ->
            NoticeBanner(notice, onDismissNotice)
        }

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

            is Loadable.Ready -> if (rows.isEmpty()) {
                StatusPane(
                    message = stringResource(R.string.chat_empty),
                    modifier = Modifier.weight(1f),
                )
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        horizontal = 16.dp,
                        vertical = 12.dp,
                    ),
                ) {
                    // Keyed by the session file's entry id, so a refetch reuses
                    // the existing nodes instead of rebuilding the list.
                    items(items = rows, key = { it.key }) { row ->
                        MessageRow(row.message)
                    }
                }
            }
        }

        if (canSend) {
            Hairline()
            Composer(
                draft = draft,
                sending = state.sending,
                onDraftChange = { draft = it },
                onSend = {
                    val body = draft
                    draft = ""
                    onSend(body)
                },
            )
        }

        state.sendFailure?.let { failure ->
            Text(
                text = failureMessage(failure),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
        }
    }
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

@Composable
private fun Composer(
    draft: String,
    sending: Boolean,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
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
        IconButton(
            onClick = onSend,
            enabled = !sending && draft.isNotBlank(),
        ) {
            if (sending) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    color = MaterialTheme.colorScheme.primary,
                )
            } else {
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

/** How far from the tail the user may be and still get auto-followed. */
private const val FOLLOW_SLACK = 2
private const val COMPOSER_MAX_LINES = 6
