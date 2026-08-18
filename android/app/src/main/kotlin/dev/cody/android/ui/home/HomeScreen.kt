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
import dev.cody.android.ui.settings.SettingsScreen
import dev.cody.android.ui.sessions.VerticalHairline
import dev.cody.android.ui.theme.LocalCodyColors
import dev.cody.android.ui.theme.LocalCodyPalette
import androidx.compose.foundation.layout.fillMaxWidth
import dev.cody.shared.backend.BackendIdentity
import dev.cody.shared.presentation.ChatModel
import dev.cody.shared.presentation.Loadable
import dev.cody.shared.presentation.SessionsModel
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import dev.cody.android.ui.logs.LogsScreen
import dev.cody.android.ui.terminal.TerminalScreen

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

    var destination by rememberSaveable { mutableStateOf(HomeDestination.Chat) }

    Column(modifier = modifier.fillMaxSize()) {
        IdentityBanner(identity)

        Row(modifier = Modifier.fillMaxSize()) {
            WorkspaceRail(destination = destination, onSelect = { destination = it })
            VerticalHairline()
            when (destination) {
                // These own their view models and take nothing from session
                // state, so they are leaves here rather than panes in the split.
                HomeDestination.Terminal -> TerminalScreen(modifier = Modifier.fillMaxSize())
                HomeDestination.Logs -> LogsScreen(onBack = null, modifier = Modifier.fillMaxSize())
                HomeDestination.Settings -> SettingsScreen(
                    identity = identity,
                    onSignOut = onSignOut,
                    onBack = null,
                    modifier = Modifier.fillMaxSize(),
                )
                HomeDestination.Chat -> ChatWorkspace(
                    sessions = sessions,
                    sessionsState = sessionsState,
                    chat = chat,
                    chatState = chatState,
                    liveEvents = liveEvents,
                    canSend = canSend,
                    onSignOut = onSignOut,
                )
            }
        }
    }
}

/**
 * Which workspace surface the window is showing.
 *
 * A three-value enum rather than a nav graph, for the same reason [CodyRoot] has
 * no `NavHost`: there is no back-stack to model — the rail is always visible and
 * every destination is one tap from every other.
 */
private enum class HomeDestination { Chat, Terminal, Logs, Settings }

/**
 * The always-visible rail. Text rather than icons deliberately: the icon set is
 * a separate dependency, and three words cost less than pulling it in for them.
 */
@Composable
private fun WorkspaceRail(destination: HomeDestination, onSelect: (HomeDestination) -> Unit) {
    val colors = LocalCodyPalette.current
    Column(
        modifier = Modifier
            .width(RAIL_WIDTH)
            .fillMaxSize()
            .padding(vertical = 8.dp),
    ) {
        RailItem(stringResource(R.string.sessions_title), destination == HomeDestination.Chat, colors.accent) {
            onSelect(HomeDestination.Chat)
        }
        Spacer(modifier = Modifier.height(4.dp))
        RailItem(stringResource(R.string.terminal_title), destination == HomeDestination.Terminal, colors.accent) {
            onSelect(HomeDestination.Terminal)
        }
        Spacer(modifier = Modifier.height(4.dp))
        RailItem(stringResource(R.string.logs_title), destination == HomeDestination.Logs, colors.accent) {
            onSelect(HomeDestination.Logs)
        }
        Spacer(modifier = Modifier.height(4.dp))
        RailItem(stringResource(R.string.settings_title), destination == HomeDestination.Settings, colors.accent) {
            onSelect(HomeDestination.Settings)
        }
    }
}

@Composable
private fun RailItem(label: String, selected: Boolean, accent: androidx.compose.ui.graphics.Color, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) accent.copy(alpha = 0.16f) else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 4.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            textAlign = TextAlign.Center,
            color = if (selected) accent else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** The list/detail split, unchanged; only its container moved. */
@Composable
private fun ChatWorkspace(
    sessions: SessionsModel,
    sessionsState: dev.cody.shared.presentation.SessionsState,
    chat: ChatModel,
    chatState: dev.cody.shared.presentation.ChatState,
    liveEvents: Boolean,
    canSend: Boolean,
    onSignOut: () -> Unit,
) {
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            val twoPane = maxWidth >= LIST_PANE_WIDTH + CHAT_MIN_WIDTH

            val open: (dev.cody.shared.model.SessionSummary) -> Unit = { session ->
                sessions.select(session.id)
                chat.open(
                    session = session,
                    // Process liveness, not "a turn is running": ChatModel asks the
                    // agent route which it is.
                    hasLiveEngine = session.id in sessionsState.running,
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
                        onCancelTurn = chat::cancel,
                        onNewSession = chat::newSession,
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
                    onCancelTurn = chat::cancel,
                    onNewSession = chat::newSession,
                    onDismissNotice = chat::dismissNotice,
                    modifier = Modifier.fillMaxSize(),
                )
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

/** Rail width: wide enough for a short word at labelSmall, narrow enough that
 *  the chat keeps the window. */
private val RAIL_WIDTH = 72.dp
