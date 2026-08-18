package dev.cody.shared.termux

/**
 * One `RUN_COMMAND` execution, fully described and free of Android types.
 *
 * `:app` turns this into an `Intent`; everything about *what* runs is decided
 * here so it can be asserted on a plain JVM.
 */
public data class TermuxRequest(
    /** Absolute path of the executable. Termux canonicalises it and refuses it if it is not executable. */
    public val executable: String,
    /** argv after the executable. */
    public val arguments: List<String>,
    /**
     * Working directory. Termux validates it and fails the whole execution if
     * it is not an existing readable+writable directory, so this is never
     * optimistically set to a workspace that has not been proven to exist.
     */
    public val workingDirectory: String,
    /** Shown in Termux's own error popups and notifications. Short and human. */
    public val label: String,
    /**
     * `app-shell` rather than `terminal-session`.
     *
     * Always true for anything Cody drives, for two reasons: background is the
     * only runner that returns stdout and stderr *separately* (a terminal
     * session returns one combined transcript including the prompt), and a
     * foreground session needs Termux to hold Draw-Over-Apps or the user must
     * tap a notification before anything runs at all.
     */
    public val background: Boolean = true,
) {
    /**
     * UTF-8 size of argv alone, which is what [TermuxLimits.ARGUMENTS_BYTES]
     * bounds.
     */
    public val argumentBytes: Int
        get() = arguments.sumOf { it.utf8Size() }

    /**
     * UTF-8 size of every string extra, which is what
     * [TermuxLimits.INTENT_EXTRAS_BYTES] bounds. The `PendingIntent` and the
     * boolean/flag extras are a few hundred bytes of Parcel overhead on top and
     * are not worth modelling — the margin here is 370 KB.
     */
    public val payloadBytes: Int
        get() = argumentBytes + executable.utf8Size() + workingDirectory.utf8Size() + label.utf8Size()
}

/** Why a command was never sent to Termux. */
public sealed interface TermuxRejection {
    /** Nothing but whitespace was typed. */
    public data object Empty : TermuxRejection

    /**
     * The command line is larger than Termux can be handed.
     *
     * The fix is never "send it anyway": write the payload into the shared
     * workspace as a file and run a command that reads it.
     */
    public data class TooLarge(
        public val bytes: Int,
        public val limit: Int,
    ) : TermuxRejection
}

/** Either a runnable request, or the reason there isn't one. */
public sealed interface TermuxCommandPlan {
    public data class Runnable(public val request: TermuxRequest) : TermuxCommandPlan
    public data class Rejected(public val rejection: TermuxRejection) : TermuxCommandPlan
}

/** Markers the availability probe prints so its stdout can be read unambiguously. */
public object TermuxProbe {
    public const val WORKSPACE_OK: String = "cody-probe:workspace-ok"
    public const val WORKSPACE_UNAVAILABLE: String = "cody-probe:workspace-unavailable"
    public const val LABEL: String = "Cody: availability probe"
}

/** Builds the two kinds of request Cody sends. */
public object TermuxCommands {

    /** Longest command prefix that goes into the Termux-facing label. */
    private const val LABEL_COMMAND_CHARS = 48

    /**
     * A user-typed command line, run through a login shell.
     *
     * `bash -lc <line>` and not a parsed argv: the point of a shell box is that
     * pipes, redirects, globs and `&&` work, and re-implementing word splitting
     * to avoid a shell would be both more code and less correct. The line is
     * passed as a single argument, so quoting inside it is bash's problem and
     * nothing here needs escaping.
     *
     * `-l` makes it a login shell so `$PREFIX/etc/profile` and the user's own
     * profile are sourced — otherwise `PATH` and every alias the owner set up in
     * Termux would be missing, and the box would behave unlike the Termux they
     * know.
     */
    public fun shell(commandLine: String, workingDirectory: String): TermuxCommandPlan {
        val line = commandLine.trim()
        if (line.isEmpty()) return TermuxCommandPlan.Rejected(TermuxRejection.Empty)

        val request = TermuxRequest(
            executable = TermuxProtocol.BASH,
            arguments = listOf("-lc", line),
            workingDirectory = workingDirectory,
            label = label(line),
        )

        // Two independent real ceilings. argv is the tighter one for a shell
        // command, but both are checked because they bound different things and
        // a future caller might add a large extra rather than a large argument.
        val argumentBytes = request.argumentBytes
        if (argumentBytes > TermuxLimits.ARGUMENTS_BYTES) {
            return TermuxCommandPlan.Rejected(
                TermuxRejection.TooLarge(argumentBytes, TermuxLimits.ARGUMENTS_BYTES),
            )
        }
        val payloadBytes = request.payloadBytes
        if (payloadBytes > TermuxLimits.INTENT_EXTRAS_BYTES) {
            return TermuxCommandPlan.Rejected(
                TermuxRejection.TooLarge(payloadBytes, TermuxLimits.INTENT_EXTRAS_BYTES),
            )
        }
        return TermuxCommandPlan.Runnable(request)
    }

    /**
     * The availability probe: the only way to find out whether
     * `allow-external-apps` is set, because Termux exposes no query for it and
     * refuses the execution instead.
     *
     * It also creates the workspace, and reports in stdout whether that worked —
     * `mkdir` in shared storage fails until the user has run
     * `termux-setup-storage`, and that is a different problem from Termux being
     * unavailable, so it must not look like one.
     *
     * The working directory is Termux's `$HOME` and deliberately **not** the
     * workspace: Termux validates the working directory before running anything,
     * so probing with a directory that may not exist yet would fail the probe
     * for the one reason the probe is meant to fix.
     *
     * Exit code is always 0. The probe answers "can Cody drive Termux at all",
     * and a non-zero exit would blur that into "did mkdir work".
     */
    public fun probe(workspace: String): TermuxRequest = TermuxRequest(
        executable = TermuxProtocol.BASH,
        arguments = listOf(
            "-lc",
            "if mkdir -p \"\$1\" 2>/dev/null; then " +
                "echo '${TermuxProbe.WORKSPACE_OK}'; " +
                "else echo '${TermuxProbe.WORKSPACE_UNAVAILABLE}'; fi",
            "cody-probe",
            workspace,
        ),
        workingDirectory = TermuxProtocol.HOME_DIR,
        label = TermuxProbe.LABEL,
    )

    private fun label(commandLine: String): String {
        val firstLine = commandLine.lineSequence().first()
        val clipped = if (firstLine.length > LABEL_COMMAND_CHARS) {
            firstLine.take(LABEL_COMMAND_CHARS) + "…"
        } else {
            firstLine
        }
        return "Cody: $clipped"
    }
}

/**
 * UTF-8 length without materialising the encoded array.
 *
 * A command line can legitimately be tens of kilobytes and this runs on every
 * keystroke-free submit path; `encodeToByteArray().size` would allocate the
 * whole buffer just to read its length.
 */
internal fun String.utf8Size(): Int {
    var size = 0
    var index = 0
    while (index < length) {
        val code = this[index].code
        size += when {
            code < 0x80 -> 1
            code < 0x800 -> 2
            // A surrogate pair is one 4-byte code point; count 2 per half so the
            // pair sums to 4 without needing to look ahead. An unpaired
            // surrogate encodes as the 3-byte replacement character, which this
            // under-counts by one byte -- irrelevant against a 128 KB ceiling.
            code in 0xD800..0xDFFF -> 2
            else -> 3
        }
        index++
    }
    return size
}
