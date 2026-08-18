package dev.cody.shared.presentation

import dev.cody.shared.termux.TermuxAvailability
import dev.cody.shared.termux.TermuxCommandPlan
import dev.cody.shared.termux.TermuxCommands
import dev.cody.shared.termux.TermuxFailure
import dev.cody.shared.termux.TermuxOutcome
import dev.cody.shared.termux.TermuxProtocol
import dev.cody.shared.termux.TermuxRejection
import dev.cody.shared.termux.TermuxRequest
import dev.cody.shared.termux.TermuxSendFailure
import dev.cody.shared.termux.asAvailability
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The Android side of the Termux companion, reduced to two calls so that
 * everything above it is testable on a plain JVM.
 *
 * Implemented in `:app` by the `RUN_COMMAND` intent sender.
 */
public interface TermuxRunner {

    /** Absolute path of the shared workspace on this device. */
    public val workspace: String

    /**
     * The availability facts that can be answered without talking to Termux:
     * is the package there, is the permission granted.
     *
     * Returns `null` when both pass, which is the only case where a probe can
     * tell us anything new.
     */
    public fun inspect(): TermuxAvailability?

    /** Sends one request and suspends until Termux answers. Never throws. */
    public suspend fun run(request: TermuxRequest): TermuxOutcome
}

/** One command and what came of it. */
public data class TerminalEntry(
    /**
     * Stable identity for the row. A monotonic counter rather than the command
     * text, because running `ls` twice must produce two rows that a `LazyColumn`
     * does not confuse with each other (docs/android-ux.md §6.2).
     */
    public val key: Long,
    public val commandLine: String,
    /** Where it actually ran, which is not always the workspace. */
    public val workingDirectory: String,
    public val outcome: TermuxOutcome?,
) {
    /** No outcome yet: Termux has it and has not answered. */
    public val running: Boolean get() = outcome == null
}

public data class TerminalState(
    public val availability: TermuxAvailability = TermuxAvailability.Unknown,
    /** A probe is in flight. */
    public val checking: Boolean = false,
    /** Oldest first, which is the order they are drawn in. */
    public val entries: List<TerminalEntry> = emptyList(),
    /** A command is in flight. */
    public val busy: Boolean = false,
    public val workspace: String = "",
)

/**
 * The Termux command runner's state machine.
 *
 * **This is not a terminal.** `RUN_COMMAND` is a one-shot RPC: Cody hands
 * Termux a command line, Termux runs it to completion in a background shell and
 * sends back stdout, stderr and an exit code. There is no PTY, so there is no
 * interactivity, no job control, no `vi`, and no shell state carried from one
 * command to the next — each run is a fresh login shell. Every part of the UI
 * that could imply otherwise says so instead; see `docs/android.md` for why the
 * embedded-PTY path (Termux's GPLv3 `terminal-view`/`terminal-emulator`) is a
 * later phase with a licence decision in front of it.
 *
 * Commands run **one at a time**. Nothing in the protocol requires it — each
 * execution carries its own `PendingIntent` and results cannot collide — but a
 * shell box whose commands can interleave against a shared working directory is
 * a shell box that lies about ordering.
 */
public class TerminalModel(
    private val runner: TermuxRunner,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(TerminalState(workspace = runner.workspace))
    public val state: StateFlow<TerminalState> = _state.asStateFlow()

    private var nextKey: Long = 1
    private var inFlight: Job? = null

    /**
     * Re-run the availability probe.
     *
     * Called on first composition and by every "check again" affordance, because
     * all three failure states are fixed *outside* this app and the user comes
     * back expecting the screen to notice.
     */
    public fun refresh() {
        if (_state.value.checking) return
        _state.update { it.copy(checking = true) }
        scope.launch {
            val local = runner.inspect()
            val availability = if (local != null) {
                local
            } else {
                val outcome = withTimeoutOrNull(PROBE_TIMEOUT_MS) {
                    runner.run(TermuxCommands.probe(runner.workspace))
                } ?: TermuxOutcome.TimedOut
                outcome.asAvailability()
            }
            _state.update { it.copy(checking = false, availability = availability) }
        }
    }

    /** Submit a typed command line. Ignored while one is already running. */
    public fun run(commandLine: String) {
        val current = _state.value
        if (current.busy || !current.availability.canRun) return

        when (val plan = TermuxCommands.shell(commandLine, workingDirectory())) {
            is TermuxCommandPlan.Rejected -> {
                // An empty line is a mis-tap, not a transcript entry.
                if (plan.rejection is TermuxRejection.Empty) return
                append(
                    commandLine = commandLine.trim(),
                    workingDirectory = workingDirectory(),
                    outcome = TermuxOutcome.NotSent(TermuxSendFailure.Rejected(plan.rejection)),
                )
            }

            is TermuxCommandPlan.Runnable -> dispatch(commandLine.trim(), plan.request)
        }
    }

    /**
     * Run a previous entry's command line again.
     *
     * It is re-planned rather than replayed, so it picks up the working
     * directory that is correct *now* — the workspace may have become reachable
     * since.
     */
    public fun rerun(key: Long) {
        val entry = _state.value.entries.firstOrNull { it.key == key } ?: return
        run(entry.commandLine)
    }

    /** Drop the scrollback. Does not cancel anything Termux is already running. */
    public fun clear() {
        _state.update { it.copy(entries = emptyList()) }
    }

    private fun dispatch(commandLine: String, request: TermuxRequest) {
        val key = append(commandLine, request.workingDirectory, outcome = null)
        _state.update { it.copy(busy = true) }
        inFlight = scope.launch {
            val outcome = withTimeoutOrNull(COMMAND_TIMEOUT_MS) { runner.run(request) }
                ?: TermuxOutcome.TimedOut
            _state.update { state ->
                state.copy(
                    busy = false,
                    availability = state.availability.reconciledWith(outcome),
                    entries = state.entries.map { entry ->
                        if (entry.key == key) entry.copy(outcome = outcome) else entry
                    },
                )
            }
        }
    }

    private fun append(
        commandLine: String,
        workingDirectory: String,
        outcome: TermuxOutcome?,
    ): Long {
        val key = nextKey++
        _state.update { state ->
            val entries = state.entries + TerminalEntry(
                key = key,
                commandLine = commandLine,
                workingDirectory = workingDirectory,
                outcome = outcome,
            )
            state.copy(
                entries = if (entries.size > MAX_SCROLLBACK) {
                    entries.takeLast(MAX_SCROLLBACK)
                } else {
                    entries
                },
            )
        }
        return key
    }

    /**
     * The workspace when it is real, Termux's `$HOME` otherwise.
     *
     * Termux validates the working directory *before* running anything and
     * fails the whole execution if it does not exist, so pointing at an
     * unreachable workspace would turn every command into the same opaque
     * error.
     */
    private fun workingDirectory(): String {
        val availability = _state.value.availability
        return if (availability is TermuxAvailability.Ready && availability.workspaceReady) {
            runner.workspace
        } else {
            TermuxProtocol.HOME_DIR
        }
    }

    /**
     * A command's own failure is the freshest evidence there is about
     * availability: a permission revoked, or Termux uninstalled, since the last
     * probe shows up here first. Downgrading on it means the screen explains
     * itself instead of silently failing every subsequent command.
     */
    private fun TermuxAvailability.reconciledWith(outcome: TermuxOutcome): TermuxAvailability =
        when {
            outcome is TermuxOutcome.NotSent &&
                outcome.reason == TermuxSendFailure.NotInstalled -> TermuxAvailability.NotInstalled

            outcome is TermuxOutcome.NotSent &&
                outcome.reason == TermuxSendFailure.PermissionDenied ->
                TermuxAvailability.PermissionDenied

            outcome is TermuxOutcome.Failed &&
                outcome.failure == TermuxFailure.ExternalAppsDisabled ->
                TermuxAvailability.ExternalAppsDisabled

            else -> this
        }

    public companion object {
        /**
         * How long the probe may take. It is a `mkdir` and an `echo`; if Termux
         * has not answered by now its service is not coming up.
         */
        public const val PROBE_TIMEOUT_MS: Long = 15_000

        /**
         * How long a user command may take before the row stops claiming to be
         * running. The command is not cancelled — nothing in `RUN_COMMAND` can
         * cancel one — so the UI must say "may still be running", not "failed".
         */
        public const val COMMAND_TIMEOUT_MS: Long = 5 * 60_000

        /**
         * Rows kept. Each can hold up to 100 KB of captured output, so an
         * unbounded scrollback is an unbounded heap; 50 is far more history than
         * a request/response box is ever read back through.
         */
        public const val MAX_SCROLLBACK: Int = 50
    }
}
