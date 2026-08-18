package dev.cody.android.ui.settings

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.cody.android.BuildConfig
import dev.cody.android.R
import dev.cody.android.shizuku.ShizukuState
import dev.cody.android.shizuku.ShizukuStatus
import dev.cody.android.termux.TermuxIntentRunner
import dev.cody.android.ui.common.CodyTopBar
import dev.cody.android.ui.common.StatusDot
import dev.cody.android.ui.common.failureMessage
import dev.cody.android.ui.theme.LocalCodyColors
import dev.cody.android.ui.theme.ToolCardRadius
import dev.cody.shared.backend.BackendIdentity
import dev.cody.shared.backend.BackendKind
import dev.cody.shared.presentation.CapabilityId
import dev.cody.shared.presentation.CapabilityRow
import dev.cody.shared.presentation.Loadable
import dev.cody.shared.presentation.PrereqLevel
import dev.cody.shared.presentation.TerminalState
import dev.cody.shared.presentation.TermuxFix
import dev.cody.shared.presentation.ThemeChoice
import dev.cody.shared.presentation.asPrereq
import dev.cody.shared.presentation.capabilityRows
import dev.cody.shared.termux.TermuxAvailability
import dev.cody.shared.termux.TermuxProtocol
import dev.cody.shared.termux.TermuxWorkspace

/**
 * Everything the app can honestly tell the user about itself, and the three
 * things it lets them change: the palette, the stored credential, and whether
 * the two optional companion apps are set up.
 *
 * The distinction that governs the whole screen is **live versus local**. The
 * connection, identity, server version, engine and capability rows are the
 * server's own answers, reloaded when the identity probe runs. The theme, the
 * token's storage and the two device prerequisites are facts about this tablet
 * and are true with the network down. Nothing here mixes the two in one row.
 *
 * It is a `LazyColumn` rather than a scrolling `Column` because the capability
 * list is data-driven: keyed rows compose on demand and survive a palette
 * change without re-measuring every row above them (docs/android-ux.md §6.2).
 */
@Composable
fun SettingsScreen(
    identity: Loadable<BackendIdentity>,
    onSignOut: () -> Unit,
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
    viewModel: SettingsViewModel = viewModel(factory = SettingsViewModel.Factory),
) {
    val theme by viewModel.theme.collectAsStateWithLifecycle()
    val serverUrl by viewModel.serverUrl.collectAsStateWithLifecycle()
    val shizuku by viewModel.shizukuStatus.collectAsStateWithLifecycle()
    val termux by viewModel.termux.collectAsStateWithLifecycle()

    // Every fix for every prerequisite state happens in another app, so the user
    // comes back to this screen expecting it to have noticed.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.recheck() }

    var confirmForget by rememberSaveable { mutableStateOf(false) }

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
                text = stringResource(R.string.settings_title),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .padding(start = if (onBack == null) 8.dp else 0.dp)
                    .weight(1f),
            )
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item(key = "connection") {
                ConnectionSection(
                    identity = identity,
                    serverUrl = serverUrl,
                    onSignOut = { confirmForget = true },
                )
            }
            item(key = "appearance") {
                AppearanceSection(choice = theme, onChoose = viewModel::setTheme)
            }
            item(key = "token") {
                TokenSection(onForget = { confirmForget = true })
            }
            item(key = "termux") {
                TermuxSection(state = termux, onRecheck = viewModel::recheck)
            }
            item(key = "shizuku") {
                ShizukuSection(
                    status = shizuku,
                    onRequestPermission = viewModel::requestShizukuPermission,
                    onOpenShizuku = { viewModel.openShizuku() },
                    onOpenHomepage = { viewModel.openShizukuHomepage() },
                    onRecheck = viewModel::recheck,
                )
            }
            item(key = "about") {
                AboutSection(identity = identity)
            }
            capabilitySection(identity)
        }
    }

    if (confirmForget) {
        ForgetTokenDialog(
            onDismiss = { confirmForget = false },
            onConfirm = {
                confirmForget = false
                onSignOut()
            },
        )
    }
}

// --- connection and identity (live) -----------------------------------------

@Composable
private fun ConnectionSection(
    identity: Loadable<BackendIdentity>,
    serverUrl: String?,
    onSignOut: () -> Unit,
) {
    SettingsSection(stringResource(R.string.settings_section_connection)) {
        MonoRow(
            label = stringResource(R.string.settings_server_address),
            value = serverUrl ?: stringResource(R.string.settings_unreported),
        )

        when (identity) {
            // Idle never reaches this screen: AppState.Connected starts the probe
            // before the shell it is part of exists. Treated as in-flight anyway,
            // because "checking" is the one honest thing to say about a value
            // that has not arrived.
            Loadable.Idle, Loadable.Loading -> StatusRow(
                level = PrereqLevel.Unknown,
                text = stringResource(R.string.status_connecting),
            )

            is Loadable.Failed -> {
                StatusRow(
                    level = PrereqLevel.Blocked,
                    text = failureMessage(identity.failure, identity.code),
                )
                Note(stringResource(R.string.settings_unreachable_note))
            }

            is Loadable.Ready -> {
                val value = identity.value
                StatusRow(
                    level = PrereqLevel.Ready,
                    text = stringResource(
                        R.string.settings_state_connected,
                        stringResource(
                            when (value.kind) {
                                BackendKind.Remote -> R.string.badge_remote
                                BackendKind.Local -> R.string.badge_local
                            },
                        ),
                        value.label,
                    ),
                )
                Text(
                    text = value.username
                        ?.let { stringResource(R.string.settings_signed_in_as, it) }
                        ?: stringResource(R.string.settings_identity_unknown),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }

        TextButton(onClick = onSignOut) {
            Text(
                text = stringResource(R.string.action_sign_out),
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

// --- appearance (local) ------------------------------------------------------

@Composable
private fun AppearanceSection(choice: ThemeChoice, onChoose: (ThemeChoice) -> Unit) {
    SettingsSection(stringResource(R.string.settings_section_appearance)) {
        FieldLabel(stringResource(R.string.settings_theme))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (option in ThemeChoice.entries) {
                ChoiceChip(
                    label = stringResource(
                        when (option) {
                            ThemeChoice.FollowSystem -> R.string.settings_theme_system
                            ThemeChoice.Light -> R.string.settings_theme_light
                            ThemeChoice.Dark -> R.string.settings_theme_dark
                        },
                    ),
                    selected = option == choice,
                    onClick = { onChoose(option) },
                )
            }
        }
        Note(stringResource(R.string.settings_theme_note))
    }
}

// --- the token (local) -------------------------------------------------------

@Composable
private fun TokenSection(onForget: () -> Unit) {
    SettingsSection(stringResource(R.string.settings_section_token)) {
        Body(stringResource(R.string.settings_token_storage))
        Body(stringResource(R.string.settings_token_never_shown))
        Note(stringResource(R.string.settings_sign_out_note))
        Button(
            onClick = onForget,
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.error,
                contentColor = MaterialTheme.colorScheme.onError,
            ),
        ) {
            Text(stringResource(R.string.settings_token_forget))
        }
    }
}

@Composable
private fun ForgetTokenDialog(onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_token_forget_title)) },
        text = { Text(stringResource(R.string.settings_token_forget_body)) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    text = stringResource(R.string.settings_token_forget_confirm),
                    color = MaterialTheme.colorScheme.error,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
    )
}

// --- device prerequisites (local, live-probed) -------------------------------

/**
 * Termux, summarised in one line by the same [dev.cody.shared.termux.TermuxAvailability]
 * the Terminal surface renders its setup cards from. Settings offers the link
 * OUT to whichever app owns the fix; it never duplicates the fix itself, which is
 * why the permission state deep-links to App info instead of raising the system
 * dialog a second place.
 */
@Composable
private fun TermuxSection(state: TerminalState, onRecheck: () -> Unit) {
    val context = LocalContext.current
    val prereq = remember(state.availability) { state.availability.asPrereq() }

    SettingsSection(stringResource(R.string.settings_prereq_termux)) {
        StatusRow(
            level = if (state.checking) PrereqLevel.Unknown else prereq.level,
            text = when {
                state.checking -> stringResource(R.string.settings_prereq_checking)
                else -> termuxLine(state)
            },
        )

        when (prereq.fix) {
            TermuxFix.None -> Unit

            TermuxFix.Install -> Actions {
                Button(onClick = { context.openUrl(TERMUX_INSTALL_URL) }) {
                    Text(stringResource(R.string.terminal_state_missing_action))
                }
            }

            TermuxFix.AppPermissions -> Actions {
                Button(onClick = { context.openAppSettings() }) {
                    Text(stringResource(R.string.terminal_state_permission_settings))
                }
            }

            TermuxFix.EnableExternalApps -> {
                Mono(TermuxProtocol.PROPERTY_ALLOW_EXTERNAL_APPS_LINE)
                Note(stringResource(R.string.terminal_state_external_footnote))
                Actions {
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
            }

            TermuxFix.SetUpStorage -> {
                Mono(TermuxWorkspace.SETUP_STORAGE_COMMAND)
                Actions {
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
                }
            }

            TermuxFix.OpenTermux -> Actions {
                Button(onClick = { TermuxIntentRunner.launchTermux(context) }) {
                    Text(stringResource(R.string.terminal_open_termux))
                }
            }
        }

        RecheckButton(busy = state.checking, onRecheck = onRecheck)
    }
}

@Composable
private fun termuxLine(state: TerminalState): String {
    val availability = state.availability
    return when (availability) {
        TermuxAvailability.Unknown ->
            stringResource(R.string.settings_termux_unknown)

        TermuxAvailability.NotInstalled ->
            stringResource(R.string.settings_termux_absent)

        TermuxAvailability.PermissionDenied ->
            stringResource(R.string.settings_termux_permission)

        TermuxAvailability.ExternalAppsDisabled ->
            stringResource(R.string.settings_termux_external)

        is TermuxAvailability.Broken ->
            availability.detail ?: stringResource(R.string.settings_termux_broken)

        is TermuxAvailability.Ready -> if (availability.workspaceReady) {
            stringResource(R.string.settings_termux_ready, state.workspace)
        } else {
            stringResource(R.string.settings_termux_no_workspace, state.workspace)
        }
    }
}

/**
 * Shizuku, mapped onto the same severity vocabulary as Termux.
 *
 * Red only ever appears once Shizuku is installed — i.e. once the user has opted
 * into it. A missing Shizuku is [PrereqLevel.Absent] and painted neutral,
 * because it is an optional power feature and a red row would be nagging about
 * something nobody asked for (docs/android-ux.md §5.2).
 *
 * The `READ_LOGS` grant itself is deliberately NOT here: it is a two-step
 * grant-then-restart flow that belongs to the surface it enables, so this row
 * says where to find it.
 */
@Composable
private fun ShizukuSection(
    status: ShizukuStatus,
    onRequestPermission: () -> Unit,
    onOpenShizuku: () -> Unit,
    onOpenHomepage: () -> Unit,
    onRecheck: () -> Unit,
) {
    SettingsSection(stringResource(R.string.settings_prereq_shizuku)) {
        StatusRow(level = status.level(), text = stringResource(status.line()))

        if (status.logsReadable && status.serverUid >= 0) {
            Note(
                stringResource(
                    if (status.serverUid == 0) R.string.shizuku_via_root else R.string.shizuku_via_adb,
                ),
            )
        }

        Actions {
            when (val state = status.shizuku) {
                ShizukuState.NotInstalled -> Button(onClick = onOpenHomepage) {
                    Text(stringResource(R.string.shizuku_not_installed_action))
                }

                ShizukuState.NotRunning, ShizukuState.Unsupported -> Button(onClick = onOpenShizuku) {
                    Text(stringResource(R.string.shizuku_open))
                }

                is ShizukuState.Denied -> if (state.canAsk) {
                    Button(onClick = onRequestPermission) {
                        Text(stringResource(R.string.shizuku_denied_action))
                    }
                } else {
                    Button(onClick = onOpenShizuku) {
                        Text(stringResource(R.string.shizuku_open))
                    }
                }

                ShizukuState.Ready -> TextButton(onClick = onOpenShizuku) {
                    Text(stringResource(R.string.shizuku_open))
                }
            }
        }

        RecheckButton(busy = false, onRecheck = onRecheck)
    }
}

/**
 * Translation, not derivation: [ShizukuGateway] owns the five-state probe and
 * this only decides which severity each state reads as.
 */
private fun ShizukuStatus.level(): PrereqLevel = when {
    logsReadable -> PrereqLevel.Ready
    // Granted this run: held, and useless until the process restarts.
    restartRequired -> PrereqLevel.Degraded
    else -> when (shizuku) {
        ShizukuState.NotInstalled -> PrereqLevel.Absent
        ShizukuState.NotRunning, ShizukuState.Unsupported -> PrereqLevel.Blocked
        is ShizukuState.Denied -> PrereqLevel.Blocked
        // Running and authorised, with the grant not yet made: one tap away.
        ShizukuState.Ready -> PrereqLevel.Degraded
    }
}

/**
 * The wording says "granted", not "readable", on purpose.
 *
 * `logsReadable` means the permission was held when THIS gateway was built, and
 * Settings builds its own the first time the screen opens — which can be after a
 * grant that the Logs surface made in this same process, where the permission is
 * held and `logd` still refuses because it judges a reader by the identity it had
 * at process start. So the line reports the grant, which is certain, and names the
 * restart as the thing to check if the log still looks empty.
 */
private fun ShizukuStatus.line(): Int = when {
    logsReadable -> R.string.settings_shizuku_granted
    restartRequired -> R.string.shizuku_restart_required
    else -> when (val state = shizuku) {
        ShizukuState.NotInstalled -> R.string.settings_shizuku_not_installed
        ShizukuState.NotRunning -> R.string.settings_shizuku_not_running
        ShizukuState.Unsupported -> R.string.settings_shizuku_unsupported
        is ShizukuState.Denied ->
            if (state.canAsk) R.string.settings_shizuku_denied else R.string.settings_shizuku_denied_blocked

        ShizukuState.Ready -> R.string.settings_shizuku_ready
    }
}

// --- about (app-local plus live) ---------------------------------------------

@Composable
private fun AboutSection(identity: Loadable<BackendIdentity>) {
    val value = identity.valueOrNull
    SettingsSection(stringResource(R.string.settings_section_about)) {
        MonoRow(
            label = stringResource(R.string.settings_app_version),
            value = stringResource(
                R.string.settings_app_version_value,
                BuildConfig.VERSION_NAME,
                BuildConfig.VERSION_CODE,
            ),
        )
        MonoRow(
            label = stringResource(R.string.settings_server_version),
            value = value?.codyVersion?.takeIf { it.isNotBlank() }
                ?: stringResource(R.string.settings_unreported),
        )
        MonoRow(
            label = stringResource(R.string.settings_engine),
            value = value?.engineName?.takeIf { it.isNotBlank() }
                ?: stringResource(R.string.settings_unreported),
        )
    }
}

/**
 * The capability list, which is the part of this screen that earns its place:
 * it is the only answer to "where is the model picker" that distinguishes a
 * server that does not offer one from a build that has not drawn one.
 *
 * Its own `items` block rather than a `Column` inside one item, so ten rows
 * compose as ten lazy items instead of one tall one.
 */
private fun LazyListScope.capabilitySection(
    identity: Loadable<BackendIdentity>,
) {
    val value = identity.valueOrNull ?: return
    val rows = capabilityRows(value.capabilities)

    item(key = "capabilities-head") {
        Column(
            modifier = Modifier
                .widthIn(max = CONTENT_MAX_WIDTH)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            SectionTitle(stringResource(R.string.settings_capabilities))
            Note(stringResource(R.string.settings_capabilities_note))
            // An unreadable /api/info is reported as a blank version and clamped
            // capabilities (BackendCapabilities.Core), so the list below is an
            // assumption rather than the server's answer. Saying so is the
            // difference between a diagnostic and a guess.
            if (value.codyVersion.isBlank()) {
                Note(stringResource(R.string.settings_capabilities_unavailable))
            }
        }
    }

    items(items = rows, key = { it.id.name }) { row ->
        CapabilityLine(row)
    }
}

@Composable
private fun CapabilityLine(row: CapabilityRow) {
    val cody = LocalCodyColors.current
    Row(
        modifier = Modifier
            .widthIn(max = CONTENT_MAX_WIDTH)
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(color = if (row.advertised) cody.success else cody.textDim, size = 6.dp)
        Text(
            text = stringResource(row.id.label()),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = stringResource(
                if (row.advertised) R.string.settings_cap_yes else R.string.settings_cap_no,
            ),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (!row.id.hasSurface) {
            Text(
                text = stringResource(R.string.settings_cap_no_surface),
                style = MaterialTheme.typography.labelSmall,
                color = cody.textDim,
            )
        }
    }
}

private fun CapabilityId.label(): Int = when (this) {
    CapabilityId.Sessions -> R.string.settings_cap_sessions
    CapabilityId.LiveEvents -> R.string.settings_cap_live_events
    CapabilityId.Prompts -> R.string.settings_cap_prompts
    CapabilityId.Models -> R.string.settings_cap_models
    CapabilityId.Skills -> R.string.settings_cap_skills
    CapabilityId.Plugins -> R.string.settings_cap_plugins
    CapabilityId.Mcp -> R.string.settings_cap_mcp
    CapabilityId.ChatExtras -> R.string.settings_cap_chat_extras
    CapabilityId.EngineSettings -> R.string.settings_cap_engine_settings
    CapabilityId.Updates -> R.string.settings_cap_updates
}

// --- the shared furniture ----------------------------------------------------

@Composable
private fun SettingsSection(title: String, content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .widthIn(max = CONTENT_MAX_WIDTH)
            .fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SectionTitle(title)
        content()
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(
        text = title,
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.onSurface,
    )
}

@Composable
private fun FieldLabel(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = LocalCodyColors.current.textDim,
    )
}

@Composable
private fun Body(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun Note(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelSmall,
        color = LocalCodyColors.current.textDim,
    )
}

/** A label over a value that is a machine string: an address, a version, a path. */
@Composable
private fun MonoRow(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        FieldLabel(label)
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

/** A dot plus a sentence: the shape every status in this screen takes. */
@Composable
private fun StatusRow(level: PrereqLevel, text: String) {
    val cody = LocalCodyColors.current
    val color = when (level) {
        PrereqLevel.Ready -> cody.success
        PrereqLevel.Degraded -> cody.warning
        PrereqLevel.Blocked -> MaterialTheme.colorScheme.error
        PrereqLevel.Absent, PrereqLevel.Unknown -> cody.textDim
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
        modifier = Modifier.fillMaxWidth(),
    ) {
        // Nudged down to sit on the first line's baseline rather than its box.
        StatusDot(color = color, modifier = Modifier.padding(top = 5.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
private fun Actions(content: @Composable () -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        content()
    }
}

@Composable
private fun RecheckButton(busy: Boolean, onRecheck: () -> Unit) {
    TextButton(onClick = onRecheck, enabled = !busy) {
        Text(
            stringResource(
                if (busy) R.string.settings_prereq_checking else R.string.terminal_check_again,
            ),
        )
    }
}

/** A copyable machine line: a config property, a shell command. */
@Composable
private fun Mono(text: String) {
    Surface(
        color = LocalCodyColors.current.inkWash,
        shape = RoundedCornerShape(ToolCardRadius),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
        )
    }
}

/**
 * One option of an exclusive choice.
 *
 * Literal surface tokens rather than an M3 state layer, which is the §1.2
 * decision: `--bg-selected` and `--bg-hover` are AA-verified against the text
 * that sits on them and an 8% overlay on top of either is not. `selectable`
 * rather than `clickable` so TalkBack announces it as one of a set instead of
 * as three unrelated buttons, and the painted 34dp keeps a 48dp touch target
 * under it (§8.2).
 */
@Composable
private fun ChoiceChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val cody = LocalCodyColors.current
    Surface(
        shape = MaterialTheme.shapes.small,
        color = if (selected) {
            MaterialTheme.colorScheme.surfaceContainerHighest
        } else {
            MaterialTheme.colorScheme.surfaceContainerLow
        },
        contentColor = if (selected) {
            MaterialTheme.colorScheme.onSurface
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
        modifier = Modifier
            .minimumInteractiveComponentSize()
            .border(
                width = 1.dp,
                color = if (selected) MaterialTheme.colorScheme.primary else cody.border,
                shape = MaterialTheme.shapes.small,
            )
            .selectable(selected = selected, onClick = onClick),
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

// --- platform escape hatches -------------------------------------------------
//
// The Terminal surface carries private copies of these three. They stay
// duplicated rather than being hoisted into `ui/common`, because that file is
// append-only shared ground this wave and a one-line wrapper each is cheaper
// than a coordinated move.

private fun Context.copyToClipboard(label: String, text: String) {
    getSystemService(ClipboardManager::class.java)
        ?.setPrimaryClip(ClipData.newPlainText(label, text))
}

private fun Context.openUrl(url: String) {
    // No <queries> entry needed: apps that handle web intents are always
    // visible, by an explicit platform exemption.
    runCatching {
        startActivity(
            Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
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

/** Where the prose and the rows stop widening; §2.3's cap, for a settings measure. */
private val CONTENT_MAX_WIDTH = 720.dp

private const val TERMUX_INSTALL_URL = "https://f-droid.org/en/packages/com.termux"
