package dev.cody.android.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.cody.android.R
import dev.cody.android.ui.common.CodyTopBar
import dev.cody.android.ui.common.Hairline
import dev.cody.android.ui.common.StatusDot
import dev.cody.android.ui.common.StatusPane
import dev.cody.android.ui.common.failureMessage
import dev.cody.android.ui.theme.LocalCodyColors
import dev.cody.shared.model.SessionSummary
import dev.cody.shared.presentation.Loadable
import dev.cody.shared.presentation.SessionsState

/**
 * The session list.
 *
 * Takes what it needs as parameters and never asks the window how wide it is —
 * that is the container's job. Holding that line is what lets the two-pane
 * container be swapped for `ListDetailPaneScaffold` later without touching this
 * file (docs/android-ux.md §2.3).
 */
@Composable
fun SessionListPane(
    state: SessionsState,
    onSelect: (SessionSummary) -> Unit,
    onRefresh: () -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize()) {
        CodyTopBar {
            Text(
                text = stringResource(R.string.sessions_title),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier
                    .padding(start = 8.dp)
                    .weight(1f),
            )
            TextButton(onClick = onSignOut) {
                Text(
                    text = stringResource(R.string.action_sign_out),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            IconButton(onClick = onRefresh) {
                Icon(
                    imageVector = Icons.Default.Refresh,
                    contentDescription = stringResource(R.string.action_refresh),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // A refresh over an existing list is a bar, not a spinner: replacing a
        // list the user is reading with a spinner loses their place.
        if (state.refreshing) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }

        when (val sessions = state.sessions) {
            Loadable.Idle, Loadable.Loading -> StatusPane(
                message = stringResource(R.string.sessions_loading),
                busy = true,
            )

            is Loadable.Failed -> StatusPane(
                message = failureMessage(sessions.failure, sessions.code),
                actionLabel = stringResource(R.string.action_retry),
                onAction = onRefresh,
            )

            is Loadable.Ready -> if (sessions.value.isEmpty()) {
                StatusPane(message = stringResource(R.string.sessions_empty))
            } else {
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(items = sessions.value, key = { it.id }) { session ->
                        SessionRow(
                            session = session,
                            running = session.id in state.running,
                            selected = session.id == state.selectedId,
                            onClick = { onSelect(session) },
                        )
                        Hairline()
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionRow(
    session: SessionSummary,
    running: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val cody = LocalCodyColors.current
    Surface(
        // Literal Cody surface tokens for rest/selected rather than an M3 state
        // layer: --bg-selected is contrast-verified against --text and an 8%
        // overlay on top of it is not (docs/android-ux.md §1.2).
        color = if (selected) {
            MaterialTheme.colorScheme.surfaceContainerHighest
        } else {
            MaterialTheme.colorScheme.surface
        },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                // 56dp minimum: a comfortable touch target, not a paint size.
                .heightIn(min = 56.dp)
                .clickable(onClick = onClick)
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = session.label,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.padding(top = 3.dp),
                ) {
                    Text(
                        text = session.projectName,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    session.worktreeBranch?.let { branch ->
                        Text(
                            text = stringResource(R.string.sessions_worktree, branch),
                            style = MaterialTheme.typography.labelSmall,
                            color = cody.renamed,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    if (session.messageCount > 0) {
                        Text(
                            text = if (session.messageCount == 1) {
                                stringResource(R.string.sessions_message_count_one)
                            } else {
                                stringResource(R.string.sessions_message_count, session.messageCount)
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = cody.textDim,
                            maxLines = 1,
                        )
                    }
                }
            }
            if (running) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    StatusDot(color = cody.success)
                    Text(
                        text = stringResource(R.string.sessions_running),
                        style = MaterialTheme.typography.labelSmall,
                        color = cody.success,
                    )
                }
            }
        }
    }
}
/** Pane divider. Cody has one border tier, so one colour. */
@Composable
fun VerticalHairline(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxHeight()
            .width(1.dp)
            .background(LocalCodyColors.current.border),
    )
}
