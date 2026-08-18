package dev.cody.android.ui.logs

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.cody.android.R
import dev.cody.android.shizuku.GrantFailure
import dev.cody.android.shizuku.GrantOutcome
import dev.cody.android.shizuku.LogcatFailure
import dev.cody.android.shizuku.LogsViewModel
import dev.cody.android.shizuku.ShizukuState
import dev.cody.android.shizuku.ShizukuStatus
import dev.cody.android.ui.common.CodyTopBar
import dev.cody.android.ui.common.Hairline
import dev.cody.android.ui.common.StatusDot
import dev.cody.android.ui.common.StatusPane
import dev.cody.android.ui.theme.LocalCodyColors
import dev.cody.shared.logs.LogEntry
import dev.cody.shared.logs.LogLevel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The device log viewer.
 *
 * ENTRY POINT: `LogsScreen(onBack = …)`. It owns its own [LogsViewModel] and
 * takes nothing from the app's session state, so it can hang off any navigation
 * the shell grows — including while signed out. Pass `onBack = null` when it is
 * shown in a pane that already has a back affordance, which is the same contract
 * `ChatPane` uses.
 *
 * The screen has two faces and never a third. Either this process holds
 * `READ_LOGS`, in which case it shows the log; or it does not, in which case it
 * says in one sentence what it would do and what the next step is for the exact
 * state Shizuku is in. There is no half-working version: no empty list implying
 * a quiet device, no disabled controls implying a bug.
 */
@Composable
fun LogsScreen(
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
    viewModel: LogsViewModel = viewModel(factory = LogsViewModel.Factory),
) {
    val status by viewModel.status.collectAsStateWithLifecycle()
    val logs by viewModel.logs.collectAsStateWithLifecycle()
    val query by viewModel.query.collectAsStateWithLifecycle()
    val granting by viewModel.granting.collectAsStateWithLifecycle()
    val grant by viewModel.grant.collectAsStateWithLifecycle()

    // The user may have started Shizuku, or authorised Cody in Shizuku's own UI,
    // while this screen sat in the background. Re-probing on resume is what stops
    // the screen insisting Shizuku is dead after the user has just fixed it.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { viewModel.refresh() }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipLabel = stringResource(R.string.logs_title)
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(COPIED_HINT_MS)
            copied = false
        }
    }

    var follow by rememberSaveable { mutableStateOf(true) }
    val listState = rememberLazyListState()
    val entries = logs.snapshot.entries

    // Following is turned off by a DRAG, not by the list's scroll position. The
    // position would be ambiguous: this screen scrolls itself ten times a second
    // while the tail moves, and every one of those would read as "the user
    // scrolled away". A drag interaction is unambiguously the user's finger.
    //
    // It is also why nothing here reads `layoutInfo` or `firstVisibleItemIndex`
    // during composition, which docs/android-ux.md §6.4 forbids: those are
    // written on every scrolled pixel.
    LaunchedEffect(listState) {
        listState.interactionSource.interactions.collect { interaction ->
            if (interaction is DragInteraction.Start) follow = false
        }
    }

    // Keyed on the ring's total line count, not on entries.size: once the ring is
    // full the size stops changing while the content keeps moving, and a
    // size-keyed effect would silently stop following at exactly that point.
    LaunchedEffect(logs.snapshot.lines, follow) {
        if (follow && entries.isNotEmpty()) {
            // Instant, not animated. At ten emissions a second an animation never
            // finishes before the next one starts, and it reads as jitter.
            listState.scrollToItem(entries.lastIndex)
        }
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
                text = stringResource(R.string.logs_title),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .padding(start = if (onBack == null) 8.dp else 0.dp)
                    .weight(1f),
            )
            if (status.logsReadable) {
                if (copied) {
                    Text(
                        text = stringResource(R.string.logs_copied),
                        style = MaterialTheme.typography.labelSmall,
                        color = LocalCodyColors.current.success,
                    )
                }
                FollowChip(following = follow, onToggle = { follow = !follow })
                TextButton(
                    onClick = {
                        scope.launch {
                            val text = viewModel.copyText()
                            context.getSystemService(ClipboardManager::class.java)
                                ?.setPrimaryClip(ClipData.newPlainText(clipLabel, text))
                            copied = true
                        }
                    },
                ) { Text(stringResource(R.string.logs_copy)) }
                TextButton(onClick = viewModel::clear) {
                    Text(stringResource(R.string.logs_clear))
                }
            }
        }

        if (!status.logsReadable) {
            ShizukuPanel(
                status = status,
                granting = granting,
                grant = grant,
                packageName = context.packageName,
                onRequestPermission = viewModel::requestPermission,
                onGrant = viewModel::grantReadLogs,
                onOpenShizuku = { viewModel.openShizuku() },
                onOpenHomepage = { viewModel.openShizukuHomepage() },
                onRestart = viewModel::restart,
                modifier = Modifier.weight(1f),
            )
            return@Column
        }

        FilterBar(
            level = query.minLevel,
            filter = query.filter,
            shown = entries.size,
            held = logs.snapshot.held,
            dropped = logs.snapshot.dropped,
            onLevel = viewModel::setLevel,
            onFilter = viewModel::setFilter,
        )
        Hairline()

        logs.failure?.let { failure ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = when (failure.kind) {
                        LogcatFailure.Kind.CouldNotStart ->
                            stringResource(R.string.logs_failed_start, failure.detail.orEmpty())

                        LogcatFailure.Kind.StreamEnded -> stringResource(R.string.logs_failed_ended)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = viewModel::restartStream) {
                    Text(stringResource(R.string.action_retry))
                }
            }
        }

        when {
            entries.isNotEmpty() -> LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
                contentPadding = PaddingValues(vertical = 6.dp),
            ) {
                // Keyed by the ring's own entry id, which is stable across
                // snapshots and is never recycled after a clear. An index key
                // here would rebuild every visible row on every emission.
                items(items = entries, key = { it.id }) { entry ->
                    LogRow(entry)
                }
            }

            logs.snapshot.held > 0 -> StatusPane(
                message = stringResource(R.string.logs_empty),
                modifier = Modifier.weight(1f),
            )

            logs.streaming -> StatusPane(
                message = stringResource(R.string.logs_waiting),
                busy = true,
                modifier = Modifier.weight(1f),
            )

            else -> StatusPane(
                message = stringResource(R.string.logs_stopped),
                actionLabel = stringResource(R.string.action_retry),
                onAction = viewModel::restartStream,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/**
 * The five states Shizuku can be in, each with its own sentence and its own next
 * action.
 *
 * The purpose line is always shown: someone who has never heard of Shizuku needs
 * to know what they would be getting before being told to go and install it.
 */
@Composable
private fun ShizukuPanel(
    status: ShizukuStatus,
    granting: Boolean,
    grant: GrantOutcome?,
    packageName: String,
    onRequestPermission: () -> Unit,
    onGrant: () -> Unit,
    onOpenShizuku: () -> Unit,
    onOpenHomepage: () -> Unit,
    onRestart: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = stringResource(R.string.shizuku_purpose),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.widthIn(max = PROSE_MAX_WIDTH),
        )

        // A completed grant outranks the state row: the user has just acted, and
        // the only thing that matters now is the restart that makes it real.
        if (status.restartRequired) {
            Text(
                text = stringResource(R.string.shizuku_restart_required),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.widthIn(max = PROSE_MAX_WIDTH),
            )
            Button(onClick = onRestart) { Text(stringResource(R.string.shizuku_restart_action)) }
            return@Column
        }

        val explanation: Int
        val actionLabel: Int
        val action: () -> Unit
        when (val state = status.shizuku) {
            ShizukuState.NotInstalled -> {
                explanation = R.string.shizuku_not_installed
                actionLabel = R.string.shizuku_not_installed_action
                action = onOpenHomepage
            }

            ShizukuState.NotRunning -> {
                explanation = R.string.shizuku_not_running
                actionLabel = R.string.shizuku_open
                action = onOpenShizuku
            }

            ShizukuState.Unsupported -> {
                explanation = R.string.shizuku_unsupported
                actionLabel = R.string.shizuku_open
                action = onOpenShizuku
            }

            is ShizukuState.Denied -> if (state.canAsk) {
                explanation = R.string.shizuku_denied
                actionLabel = R.string.shizuku_denied_action
                action = onRequestPermission
            } else {
                explanation = R.string.shizuku_denied_blocked
                actionLabel = R.string.shizuku_open
                action = onOpenShizuku
            }

            ShizukuState.Ready -> {
                explanation = R.string.shizuku_ready
                actionLabel = R.string.shizuku_grant_action
                action = onGrant
            }
        }

        Text(
            text = stringResource(explanation),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.widthIn(max = PROSE_MAX_WIDTH),
        )

        if (status.serverUid >= 0) {
            Text(
                text = stringResource(
                    if (status.serverUid == 0) R.string.shizuku_via_root else R.string.shizuku_via_adb,
                ),
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = LocalCodyColors.current.textDim,
            )
        }

        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Button(onClick = action, enabled = !granting) { Text(stringResource(actionLabel)) }
            if (granting) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    color = MaterialTheme.colorScheme.primary,
                )
                Text(
                    text = stringResource(R.string.shizuku_granting),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // Only ever the most recent attempt: the view model drops the previous
        // outcome before starting a new one, so there is no stale banner to
        // dismiss and therefore no undiscoverable dismiss gesture to learn.
        val outcome = grant
        if (outcome != null && !granting) {
            val failed = outcome is GrantOutcome.Failed
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainer,
                shape = MaterialTheme.shapes.medium,
            ) {
                Text(
                    text = when (outcome) {
                        GrantOutcome.AlreadyHeld -> stringResource(R.string.shizuku_already_held)
                        GrantOutcome.Granted -> stringResource(R.string.shizuku_restart_required)
                        is GrantOutcome.Failed -> when (outcome.reason) {
                            GrantFailure.ShizukuUnavailable ->
                                stringResource(R.string.shizuku_grant_failed_unavailable)

                            GrantFailure.HiddenApiBlocked -> stringResource(
                                R.string.shizuku_grant_failed_hidden_api,
                                packageName,
                                outcome.detail.orEmpty(),
                            )

                            GrantFailure.ServiceUnavailable ->
                                stringResource(R.string.shizuku_grant_failed_service)

                            GrantFailure.Refused -> stringResource(
                                R.string.shizuku_grant_failed_refused,
                                outcome.detail.orEmpty(),
                            )
                        }
                    },
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = if (failed) FontFamily.Monospace else FontFamily.Default,
                    color = if (failed) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                    modifier = Modifier
                        .widthIn(max = PROSE_MAX_WIDTH)
                        .padding(12.dp),
                )
            }
        }
    }
}

@Composable
private fun FilterBar(
    level: LogLevel,
    filter: String,
    shown: Int,
    held: Int,
    dropped: Long,
    onLevel: (LogLevel) -> Unit,
    onFilter: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            for (choice in LEVEL_CHOICES) {
                LevelChip(
                    level = choice,
                    selected = choice == level,
                    onClick = { onLevel(choice) },
                )
            }
            Text(
                text = stringResource(R.string.logs_counts, shown, held),
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = LocalCodyColors.current.textDim,
                modifier = Modifier.padding(start = 8.dp),
            )
            if (dropped > 0) {
                Text(
                    text = stringResource(R.string.logs_dropped, dropped),
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = LocalCodyColors.current.textDim,
                )
            }
        }
        OutlinedTextField(
            value = filter,
            onValueChange = onFilter,
            singleLine = true,
            placeholder = { Text(stringResource(R.string.logs_filter_hint)) },
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

/**
 * Cody names literal surface tokens for selection rather than drawing an M3
 * state layer over them, so this is a `Surface` in an explicit colour and not a
 * `FilterChip` (docs/android-ux.md §1.2).
 */
@Composable
private fun LevelChip(level: LogLevel, selected: Boolean, onClick: () -> Unit) {
    val description = stringResource(levelDescription(level))
    Surface(
        color = if (selected) {
            MaterialTheme.colorScheme.surfaceContainerHighest
        } else {
            MaterialTheme.colorScheme.surfaceContainer
        },
        shape = RoundedCornerShape(6.dp),
        modifier = Modifier
            .clickable(onClick = onClick)
            .semantics { contentDescription = description },
    ) {
        Text(
            text = level.letter.toString(),
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.SemiBold,
            color = if (selected) {
                MaterialTheme.colorScheme.onSurface
            } else {
                LocalCodyColors.current.textDim
            },
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 11.dp),
        )
    }
}

@Composable
private fun FollowChip(following: Boolean, onToggle: () -> Unit) {
    val palette = LocalCodyColors.current
    val label = stringResource(
        if (following) R.string.logs_follow_on else R.string.logs_follow_off,
    )
    val tone = if (following) palette.success else palette.textDim
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier
            .clickable(onClick = onToggle)
            .padding(horizontal = 10.dp, vertical = 12.dp),
    ) {
        StatusDot(color = tone)
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = tone,
            maxLines = 1,
        )
    }
}

/**
 * One log line: a dim header and the message beneath it, both monospaced.
 *
 * The theme supplies no `Typography`, so M3's Roboto defaults are in force and
 * the mono family has to be named here. It is not decoration: a proportional
 * font makes column-aligned log output unreadable, and it makes a repeat counter
 * jitter horizontally as it climbs (docs/android-ux.md §1.6).
 */
@Composable
private fun LogRow(entry: LogEntry) {
    val palette = LocalCodyColors.current
    val severe = entry.level.rank <= LogLevel.Error.rank
    val tone = when (entry.level) {
        LogLevel.Fatal, LogLevel.Error -> MaterialTheme.colorScheme.error
        LogLevel.Warn -> palette.warning
        LogLevel.Info -> MaterialTheme.colorScheme.onSurface
        LogLevel.Debug -> MaterialTheme.colorScheme.onSurfaceVariant
        LogLevel.Verbose -> palette.textDim
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                if (severe) MaterialTheme.colorScheme.errorContainer else Color.Transparent,
            )
            .padding(horizontal = 12.dp, vertical = 3.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = entry.level.letter.toString(),
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold,
                color = tone,
            )
            Text(
                text = entry.lastSeen,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = palette.textDim,
                maxLines = 1,
            )
            Text(
                text = entry.tag,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (entry.count > 1) {
                Text(
                    text = stringResource(R.string.logs_repeat, entry.count),
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.SemiBold,
                    color = palette.warning,
                )
            }
        }
        Text(
            text = entry.message,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
            color = tone,
            // A single entry can carry 1200 characters. Bounded so that one dump
            // cannot own the viewport; the full text is still what Copy yields.
            maxLines = MAX_ROW_LINES,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private fun levelDescription(level: LogLevel): Int = when (level) {
    LogLevel.Fatal, LogLevel.Error -> R.string.logs_level_error
    LogLevel.Warn -> R.string.logs_level_warn
    LogLevel.Info -> R.string.logs_level_info
    LogLevel.Debug -> R.string.logs_level_debug
    LogLevel.Verbose -> R.string.logs_level_verbose
}

/**
 * The five thresholds worth a chip. Fatal gets none of its own: it is rarer than
 * a crash and always arrives beside the Error lines that explain it, so folding
 * it into Error is what a reader wants and gives back a chip's worth of width.
 */
private val LEVEL_CHOICES = listOf(
    LogLevel.Verbose,
    LogLevel.Debug,
    LogLevel.Info,
    LogLevel.Warn,
    LogLevel.Error,
)

private val PROSE_MAX_WIDTH = 560.dp
private const val MAX_ROW_LINES = 20
private const val COPIED_HINT_MS = 1_600L
