package dev.cody.android.ui.home

import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.cody.android.R
import dev.cody.android.ui.chat.ChatPane
import dev.cody.android.ui.sessions.SessionListPane
import dev.cody.android.ui.sessions.VerticalHairline
import dev.cody.android.ui.theme.LocalCodyColors
import dev.cody.shared.backend.BackendIdentity
import dev.cody.shared.presentation.ChatModel
import dev.cody.shared.presentation.Loadable
import dev.cody.shared.presentation.SessionsModel

/**
 * The list/detail container, and the ONLY composable that knows how wide the
 * window is.
 *
 * Two panes when the arithmetic allows it; otherwise the LIST collapses and the
 * chat keeps the window, because a squeezed transcript is worse than a hidden
 * list. [CHAT_MIN_WIDTH] is the floor that decision is made against
 * (docs/android-ux.md §2.3).
 *
 * This is deliberately a hand-rolled two-pane split rather than
 * `ListDetailPaneScaffold`: the three-pane version needs an "extra" pane and
 * there are no workspace tool screens yet. Because the panes below receive their
 * role as parameters and never query the window themselves, adopting the
 * scaffold later replaces this file and nothing else.
 */
@Composable
fun HomeScreen(
    identity: Loadable<BackendIdentity>,
    sessions: SessionsModel,
    chat: ChatModel,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val sessionsState by sessions.state.collectAsStateWithLifecycle()
    val chatState by chat.state.collectAsStateWithLifecycle()

    LaunchedEffect(sessions) { sessions.refresh() }

    val capabilities = (identity as? Loadable.Ready)?.value?.capabilities
    val liveEvents = capabilities?.liveEvents ?: false
    val canSend = capabilities?.prompts ?: false

    Column(modifier = modifier.fillMaxSize()) {
        IdentityBanner(identity)

        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            val twoPane = maxWidth >= LIST_PANE_WIDTH + CHAT_MIN_WIDTH

            val open: (dev.cody.shared.model.SessionSummary) -> Unit = { session ->
                sessions.select(session.id)
                chat.open(
                    session = session,
                    isRunning = session.id in sessionsState.running,
                    liveEventsSupported = liveEvents,
                )
            }

            if (twoPane) {
                Row(modifier = Modifier.fillMaxSize()) {
                    SessionListPane(
                        state = sessionsState,
                        onSelect = open,
                        onRefresh = sessions::refresh,
                        onSignOut = onSignOut,
                        modifier = Modifier.width(LIST_PANE_WIDTH),
                    )
                    VerticalHairline()
                    ChatPane(
                        state = chatState,
                        canSend = canSend,
                        // Both panes are visible, so there is nowhere to go back to.
                        onBack = null,
                        onSend = { chat.send(it, liveEvents) },
                        onDismissNotice = chat::dismissNotice,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            } else if (chatState.session == null) {
                SessionListPane(
                    state = sessionsState,
                    onSelect = open,
                    onRefresh = sessions::refresh,
                    onSignOut = onSignOut,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                ChatPane(
                    state = chatState,
                    canSend = canSend,
                    onBack = {
                        sessions.select(null)
                        chat.clear()
                    },
                    onSend = { chat.send(it, liveEvents) },
                    onDismissNotice = chat::dismissNotice,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
}

/**
 * The persistent remote/local badge the architecture brief requires, and the
 * place a failed identity probe surfaces.
 *
 * Shown as a strip rather than hidden in a menu on purpose: the user must always
 * be able to see which brain they are talking to.
 */
@Composable
private fun IdentityBanner(identity: Loadable<BackendIdentity>) {
    val cody = LocalCodyColors.current
    val (message, tint) = when (identity) {
        Loadable.Idle, Loadable.Loading ->
            stringResource(R.string.status_connecting) to cody.textDim

        is Loadable.Failed ->
            stringResource(R.string.status_server_unreachable) to MaterialTheme.colorScheme.error

        is Loadable.Ready -> {
            val badge = stringResource(R.string.badge_remote)
            val parts = listOfNotNull(
                badge,
                identity.value.label.takeIf { it.isNotBlank() },
                identity.value.username?.takeIf { it.isNotBlank() },
                identity.value.engineName.takeIf { it.isNotBlank() },
            )
            parts.joinToString(" · ") to cody.textDim
        }
    }
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Text(
            text = message,
            style = MaterialTheme.typography.labelSmall,
            color = tint,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )
    }
}

/**
 * Narrowest the chat may ever be. Below this, code blocks and tool frames wrap
 * into unreadable ribbons, so the list yields instead.
 */
private val CHAT_MIN_WIDTH = 320.dp

/** Session list width when both panes fit. */
private val LIST_PANE_WIDTH = 340.dp
