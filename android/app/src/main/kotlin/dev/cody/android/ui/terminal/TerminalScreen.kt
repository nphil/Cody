package dev.cody.android.ui.terminal

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.cody.android.R
import dev.cody.android.termux.TermuxIntentRunner
import dev.cody.android.ui.common.CodyTopBar
import dev.cody.android.ui.common.Hairline
import dev.cody.android.ui.common.StatusPane
import dev.cody.android.ui.theme.LocalCodyColors
import dev.cody.android.ui.theme.ToolCardRadius
import dev.cody.android.vm.TerminalViewModel
import dev.cody.shared.presentation.TerminalEntry
import dev.cody.shared.presentation.TerminalModel
import dev.cody.shared.presentation.TerminalState
import dev.cody.shared.termux.TermuxAvailability
import dev.cody.shared.termux.TermuxFailure
import dev.cody.shared.termux.TermuxOutcome
import dev.cody.shared.termux.TermuxProtocol
import dev.cody.shared.termux.TermuxRejection
import dev.cody.shared.termux.TermuxSendFailure
import dev.cody.shared.termux.TermuxStream
import dev.cody.shared.termux.TermuxWorkspace

/**
 * The Termux command runner.
 *
 * **Entry point.** Wire it from the navigation host as:
 *
 * ```kotlin
 * TerminalScreen(onBack = { /* leave the terminal */ })
 * ```
 *
 * It owns its own [TerminalViewModel], so there is nothing to construct, inject
 * or hoist; `onBack` is null when the screen is a pane that is not covering the
 * window, exactly like [dev.cody.android.ui.chat.ChatPane].
 *
 * What this screen is, stated plainly because the gap between the two is the
 * kind of thing that makes an app feel dishonest: it sends **one command at a
 * time** to Termux, which runs it to completion in a background shell and sends
 * back stdout, stderr and an exit code. There is no pseudo-terminal, so there is
 * no interactivity, no `top`, no `vi`, no Ctrl-C, and no state carried from one
 * command to the next. A real in-app shell means embedding Termux's
 * `terminal-view`/`terminal-emulator`, which are GPLv3 — a licence decision
 * `docs/android.md` requires be taken before that code exists, not after.
 */
@Composable
fun TerminalScreen(
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    val viewModel: TerminalViewModel = viewModel(factory = TerminalViewModel.Factory)
    val state by viewModel.terminal.state.collectAsStateWithLifecycle()

    // All three failure states are fixed by leaving this app — installing
    // Termux, granting a permission in Settings, editing termux.properties —
    // so the moment the user comes back is exactly when the answer may have
    // changed. Re-probing then is the difference between the screen noticing
    // and the user having to work out that a button needs pressing.
    LifecycleResumeEffect(Unit) {
        if (!viewModel.terminal.state.value.availability.canRun) viewModel.terminal.refresh()
        onPauseOrDispose { }
    }
    TerminalScreen(
        state = state,
        onRun = viewModel.terminal::run,
        onRerun = viewModel.terminal::rerun,
        onClear = viewModel.terminal::clear,
        onRecheck = viewModel.terminal::refresh,
        onBack = onBack,
        modifier = modifier,
    )
}

/** The stateless half, so the screen can be exercised without a Termux install. */
@Composable
private fun TerminalScreen(
    state: TerminalState,
    onRun: (String) -> Unit,
    onRerun: (Long) -> Unit,
    onClear: () -> Unit,
    onRecheck: () -> Unit,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize()) {
        CodyTopBar {
            if (onBack != null) {
                IconButton(onClick = onBack) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = stringResource(R.string.action_back),
                    )
                }
            }
            Column(modifier = Modifier.weight(1f).padding(horizontal = 8.dp)) {
                Text(
                    text = stringResource(R.string.terminal_title),
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                // Persistent, not a one-time dismissible hint: what this is
                // must be readable at the moment someone types a command.
                Text(
                    text = stringResource(R.string.terminal_subtitle),
                    style = MaterialTheme.typography.labelSmall,
                    color = LocalCodyColors.current.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (state.entries.isNotEmpty()) {
                IconButton(onClick = onClear) {
                    Icon(
                        imageVector = Icons.Filled.Delete,
                        contentDescription = stringResource(R.string.terminal_clear),
                    )
                }
            }
        }

        Box(modifier = Modifier.weight(1f)) {
            when {
                state.checking && state.availability == TermuxAvailability.Unknown ->
                    StatusPane(message = stringResource(R.string.terminal_checking), busy = true)

                state.availability is TermuxAvailability.Ready ->
                    Scrollback(state = state, onRerun = onRerun, onRecheck = onRecheck)

                else -> SetupPane(
                    availability = state.availability,
                    checking = state.checking,
                    onRecheck = onRecheck,
                )
            }
        }

        if (state.availability.canRun) {
            Hairline()
            CommandField(busy = state.busy, onRun = onRun)
        }
    }
}

// --- the transcript ---------------------------------------------------------

@Composable
private fun Scrollback(
    state: TerminalState,
    onRerun: (Long) -> Unit,
    onRecheck: () -> Unit,
) {
    val listState = rememberLazyListState()
    val entries = state.entries

    // derivedStateOf so the follow decision invalidates on the ANSWER changing,
    // not on every scroll pixel (docs/android-ux.md §6.4).
    val following by remember {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= info.totalItemsCount - FOLLOW_SLACK
        }
    }
    LaunchedEffect(entries.size) {
        if (entries.isNotEmpty() && following) listState.animateScrollToItem(entries.lastIndex)
    }

    if (entries.isEmpty()) {
        Column(modifier = Modifier.fillMaxSize()) {
            val availability = state.availability
            if (availability is TermuxAvailability.Ready && !availability.workspaceReady) {
                Box(modifier = Modifier.padding(16.dp)) {
                    WorkspaceNotice(state.workspace, onRecheck)
                }
            }
            // weight, not fillMaxSize: inside a Column a full-height child
            // would be measured against the whole viewport and push the notice
            // above it off screen.
            StatusPane(
                message = stringResource(R.string.terminal_empty, state.workspace),
                modifier = Modifier.weight(1f),
            )
        }
        return
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val availability = state.availability
        if (availability is TermuxAvailability.Ready && !availability.workspaceReady) {
            item(key = "workspace-notice") { WorkspaceNotice(state.workspace, onRecheck) }
        }
        // Keyed by the entry's own id: running `ls` twice must not reuse the
        // first row's node and inherit its output.
        items(items = entries, key = { it.key }) { entry ->
            EntryCard(entry = entry, busy = state.busy, onRerun = onRerun)
        }
    }
}

@Composable
private fun EntryCard(entry: TerminalEntry, busy: Boolean, onRerun: (Long) -> Unit) {
    val cody = LocalCodyColors.current
    val context = LocalContext.current

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = RoundedCornerShape(ToolCardRadius),
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, cody.border, RoundedCornerShape(ToolCardRadius)),
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "$ ${entry.commandLine}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                text = stringResource(R.string.terminal_cwd, entry.workingDirectory),
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = cody.textDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )

            OutcomeStatus(entry.outcome)

            when (val outcome = entry.outcome) {
                is TermuxOutcome.Completed -> {
                    StreamBlock(stringResource(R.string.terminal_stdout), outcome.stdout, isError = false)
                    StreamBlock(stringResource(R.string.terminal_stderr), outcome.stderr, isError = true)
                    if (outcome.stdout.isEmpty && outcome.stderr.isEmpty) {
                        Text(
                            text = stringResource(R.string.terminal_no_output),
                            style = MaterialTheme.typography.labelSmall,
                            color = cody.textDim,
                        )
                    }
                }

                is TermuxOutcome.Failed -> {
                    StreamBlock(stringResource(R.string.terminal_stdout), outcome.stdout, isError = false)
                    StreamBlock(stringResource(R.string.terminal_stderr), outcome.stderr, isError = true)
                }

                else -> Unit
            }

            if (entry.outcome != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { onRerun(entry.key) }, enabled = !busy) {
                        Text(stringResource(R.string.terminal_rerun))
                    }
                    val copyLabel = stringResource(R.string.terminal_title)
                    TextButton(onClick = { context.copyToClipboard(copyLabel, entry.asPlainText()) }) {
                        Text(stringResource(R.string.terminal_copy))
                    }
                }
            }
        }
    }
}

@Composable
private fun OutcomeStatus(outcome: TermuxOutcome?) {
    val cody = LocalCodyColors.current
    when (outcome) {
        null -> Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            CircularProgressIndicator(
                modifier = Modifier.size(12.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.primary,
            )
            StatusLabel(stringResource(R.string.terminal_running), cody.textDim)
        }

        is TermuxOutcome.Completed -> StatusLabel(
            text = stringResource(R.string.terminal_exit_code, outcome.exitCode),
            color = if (outcome.exitCode == 0) cody.success else MaterialTheme.colorScheme.error,
        )

        is TermuxOutcome.Failed -> StatusLabel(
            text = when (outcome.failure) {
                TermuxFailure.ExternalAppsDisabled ->
                    stringResource(R.string.terminal_failed_external_apps)

                TermuxFailure.Internal -> outcome.detail
                    ?.let { stringResource(R.string.terminal_failed_detail, it) }
                    ?: stringResource(R.string.terminal_failed_generic)
            },
            color = MaterialTheme.colorScheme.error,
        )

        is TermuxOutcome.NotSent -> StatusLabel(
            text = when (val reason = outcome.reason) {
                TermuxSendFailure.NotInstalled -> stringResource(R.string.terminal_state_missing_title)
                TermuxSendFailure.PermissionDenied -> stringResource(R.string.terminal_state_permission_title)
                TermuxSendFailure.AppInBackground -> stringResource(R.string.terminal_not_sent_background)
                is TermuxSendFailure.Rejected -> when (val rejection = reason.rejection) {
                    TermuxRejection.Empty -> stringResource(R.string.terminal_failed_generic)
                    is TermuxRejection.TooLarge -> stringResource(
                        R.string.terminal_too_large,
                        rejection.bytes / 1024,
                        rejection.limit / 1024,
                    )
                }

                is TermuxSendFailure.Unknown -> reason.message
                    ?.let { stringResource(R.string.terminal_failed_detail, it) }
                    ?: stringResource(R.string.terminal_failed_generic)
            },
            color = MaterialTheme.colorScheme.error,
        )

        TermuxOutcome.TimedOut -> StatusLabel(
            text = stringResource(R.string.terminal_timed_out),
            color = cody.warning,
        )
    }
}

@Composable
private fun StatusLabel(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        fontFamily = FontFamily.Monospace,
        color = color,
    )
}

/**
 * One captured stream.
 *
 * Two independent truncations can apply and they are reported separately,
 * because they mean different things: Termux caps what it will hand over at all,
 * and this card caps what it will lay out. Both keep the **tail**.
 */
@Composable
private fun StreamBlock(label: String, stream: TermuxStream, isError: Boolean) {
    if (stream.isEmpty) return
    val cody = LocalCodyColors.current
    val context = LocalContext.current
    val shown = remember(stream) {
        if (stream.text.length > DISPLAY_CHARS) stream.text.takeLast(DISPLAY_CHARS) else stream.text
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = if (isError) MaterialTheme.colorScheme.error else cody.textDim,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { context.copyToClipboard(label, stream.text) }) {
                Text(stringResource(R.string.terminal_copy))
            }
        }
        Surface(
            color = cody.inkWash,
            shape = RoundedCornerShape(ToolCardRadius),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text = shown,
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
            )
        }
        if (stream.truncated) {
            Text(
                text = stringResource(R.string.terminal_truncated_by_termux, stream.droppedChars),
                style = MaterialTheme.typography.labelSmall,
                color = cody.warning,
            )
        }
        if (shown.length < stream.text.length) {
            Text(
                text = stringResource(
                    R.string.terminal_truncated_for_display,
                    shown.length,
                    stream.text.length,
                ),
                style = MaterialTheme.typography.labelSmall,
                color = cody.textDim,
            )
        }
    }
}

// --- the three ways this is broken ------------------------------------------

/**
 * Termux absent, permission ungranted, and `allow-external-apps` unset are three
 * different states with three different fixes, and two of the three are things
 * only the user can do. Collapsing them into one "terminal unavailable" card
 * would leave the owner guessing which of the three they are in.
 */
@Composable
private fun SetupPane(
    availability: TermuxAvailability,
    checking: Boolean,
    onRecheck: () -> Unit,
) {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    var permissionDialogExhausted by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        // Denied with no rationale left means the system dialog will not appear
        // again. Asking a second time is a no-op the user reads as a dead
        // button, so switch to the settings deep link instead of looping.
        permissionDialogExhausted = !granted && activity != null &&
            !ActivityCompat.shouldShowRequestPermissionRationale(activity, TermuxProtocol.PERMISSION)
        onRecheck()
    }

    Box(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier.widthIn(max = 520.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            when (availability) {
                TermuxAvailability.NotInstalled -> SetupCard(
                    title = stringResource(R.string.terminal_state_missing_title),
                    body = stringResource(R.string.terminal_state_missing_body),
                ) {
                    Button(onClick = { context.openUrl(TERMUX_INSTALL_URL) }) {
                        Text(stringResource(R.string.terminal_state_missing_action))
                    }
                }

                TermuxAvailability.PermissionDenied -> SetupCard(
                    title = stringResource(R.string.terminal_state_permission_title),
                    body = stringResource(R.string.terminal_state_permission_body),
                    footnote = if (permissionDialogExhausted) {
                        stringResource(R.string.terminal_state_permission_settings_hint)
                    } else {
                        null
                    },
                ) {
                    if (permissionDialogExhausted) {
                        Button(onClick = { context.openAppSettings() }) {
                            Text(stringResource(R.string.terminal_state_permission_settings))
                        }
                    } else {
                        Button(onClick = { permissionLauncher.launch(TermuxProtocol.PERMISSION) }) {
                            Text(stringResource(R.string.terminal_state_permission_action))
                        }
                    }
                }

                TermuxAvailability.ExternalAppsDisabled -> SetupCard(
                    title = stringResource(R.string.terminal_state_external_title),
                    body = stringResource(
                        R.string.terminal_state_external_body,
                        TermuxProtocol.PROPERTIES_FILE,
                    ),
                    mono = TermuxProtocol.PROPERTY_ALLOW_EXTERNAL_APPS_LINE,
                    footnote = stringResource(R.string.terminal_state_external_footnote),
                ) {
                    Button(
                        onClick = {
                            context.copyToClipboard(
                                TermuxProtocol.PROPERTY_ALLOW_EXTERNAL_APPS,
                                TermuxProtocol.PROPERTY_ALLOW_EXTERNAL_APPS_LINE,
                            )
                        },
                    ) {
                        Text(stringResource(R.string.terminal_state_external_action))
                    }
                    TextButton(onClick = { TermuxIntentRunner.launchTermux(context) }) {
                        Text(stringResource(R.string.terminal_open_termux))
                    }
                }

                is TermuxAvailability.Broken -> SetupCard(
                    title = stringResource(R.string.terminal_state_broken_title),
                    body = availability.detail ?: stringResource(R.string.terminal_state_broken_body),
                ) {
                    TextButton(onClick = { TermuxIntentRunner.launchTermux(context) }) {
                        Text(stringResource(R.string.terminal_open_termux))
                    }
                }

                // Ready and Unknown never reach here; Unknown only while the
                // very first probe is still running, which the caller handles.
                else -> SetupCard(
                    title = stringResource(R.string.terminal_checking),
                    body = stringResource(R.string.terminal_state_broken_body),
                    actions = {},
                )
            }

            TextButton(onClick = onRecheck, enabled = !checking) {
                Text(
                    stringResource(
                        if (checking) R.string.terminal_checking else R.string.terminal_check_again,
                    ),
                )
            }
        }
    }
}

@Composable
private fun SetupCard(
    title: String,
    body: String,
    mono: String? = null,
    footnote: String? = null,
    actions: @Composable () -> Unit,
) {
    val cody = LocalCodyColors.current
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, cody.border, MaterialTheme.shapes.medium),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(text = title, style = MaterialTheme.typography.titleMedium)
            Text(
                text = body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (mono != null) {
                Surface(
                    color = cody.inkWash,
                    shape = RoundedCornerShape(ToolCardRadius),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = mono,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                    )
                }
            }
            if (footnote != null) {
                Text(
                    text = footnote,
                    style = MaterialTheme.typography.labelSmall,
                    color = cody.textDim,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { actions() }
        }
    }
}

/**
 * The workspace is a separate concern from availability: Termux can be perfectly
 * usable and still have no shared-storage access, in which case commands run in
 * Termux's home directory and the shared directory simply does not exist yet.
 */
@Composable
private fun WorkspaceNotice(workspace: String, onRecheck: () -> Unit) {
    val context = LocalContext.current
    SetupCard(
        title = stringResource(R.string.terminal_workspace_missing_title),
        body = stringResource(R.string.terminal_workspace_missing_body, workspace),
        mono = TermuxWorkspace.SETUP_STORAGE_COMMAND,
    ) {
        Button(
            onClick = {
                context.copyToClipboard(
                    TermuxWorkspace.SETUP_STORAGE_COMMAND,
                    TermuxWorkspace.SETUP_STORAGE_COMMAND,
                )
            },
        ) {
            Text(stringResource(R.string.terminal_copy))
        }
        TextButton(onClick = { TermuxIntentRunner.launchTermux(context) }) {
            Text(stringResource(R.string.terminal_open_termux))
        }
        TextButton(onClick = onRecheck) { Text(stringResource(R.string.terminal_check_again)) }
    }
}

// --- the composer -----------------------------------------------------------

@Composable
private fun CommandField(busy: Boolean, onRun: (String) -> Unit) {
    var draft by remember { mutableStateOf("") }
    val submit = {
        if (!busy && draft.isNotBlank()) {
            onRun(draft)
            draft = ""
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .imePadding()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            modifier = Modifier.weight(1f),
            enabled = !busy,
            placeholder = { Text(stringResource(R.string.terminal_input_hint)) },
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            maxLines = COMMAND_MAX_LINES,
            // Autocorrect and auto-capitalisation on a shell command line turn
            // `ls` into `Ls` and silently break every command the owner types.
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { submit() }),
        )
        IconButton(onClick = submit, enabled = !busy && draft.isNotBlank()) {
            if (busy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.primary,
                )
            } else {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Send,
                    contentDescription = stringResource(R.string.terminal_run),
                )
            }
        }
    }
}

// --- plumbing ---------------------------------------------------------------

/** The whole entry as text, for the copy action. */
private fun TerminalEntry.asPlainText(): String = buildString {
    append("$ ").append(commandLine).append('\n')
    when (val result = outcome) {
        is TermuxOutcome.Completed -> {
            if (!result.stdout.isEmpty) append(result.stdout.text).append('\n')
            if (!result.stderr.isEmpty) append(result.stderr.text).append('\n')
            append("exit ").append(result.exitCode)
        }

        is TermuxOutcome.Failed -> append(result.detail.orEmpty())
        else -> Unit
    }
}

private fun Context.copyToClipboard(label: String, text: String) {
    ContextCompat.getSystemService(this, ClipboardManager::class.java)
        ?.setPrimaryClip(ClipData.newPlainText(label, text))
}

private fun Context.openUrl(url: String) {
    // No <queries> entry needed: apps that handle web intents are always
    // visible, by an explicit platform exemption.
    runCatching {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

private fun Context.openAppSettings() {
    runCatching {
        startActivity(
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", packageName, null),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/**
 * Termux hands back up to 100 KB per result. Laying that out as one `Text` is
 * tens of milliseconds of text measurement on the main thread for something
 * nobody reads top to bottom, so the card draws the tail and Copy takes the lot
 * (docs/android-ux.md §6.9).
 */
private const val DISPLAY_CHARS = 4_000

private const val COMMAND_MAX_LINES = 5

/** How far from the tail the user may be and still get auto-followed. */
private const val FOLLOW_SLACK = 2

private const val TERMUX_INSTALL_URL = "https://f-droid.org/en/packages/com.termux"
