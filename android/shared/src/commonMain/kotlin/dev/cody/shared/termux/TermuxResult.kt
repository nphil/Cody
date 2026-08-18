package dev.cody.shared.termux

/**
 * The result bundle exactly as Termux fills it, lifted out of Android's
 * `Bundle` by `:app` and otherwise untouched.
 *
 * The two `*OriginalLength` fields are `String`s and not `Int`s because that is
 * genuinely how Termux sends them — `resultBundle.putString(key, String.valueOf(length))`.
 * Reading them with `getInt` returns 0, which reads as "nothing was truncated"
 * on exactly the outputs that were. Keeping them raw here puts the parse in the
 * one place there is a test for it.
 */
public data class TermuxResultBundle(
    public val stdout: String?,
    public val stdoutOriginalLength: String?,
    public val stderr: String?,
    public val stderrOriginalLength: String?,
    /** Absent when Termux never got as far as running the command. */
    public val exitCode: Int?,
    /** [TermuxProtocol.ERR_SUCCESS] when Termux itself was fine. */
    public val err: Int?,
    public val errmsg: String?,
)

/**
 * One captured stream, and how much of it was thrown away.
 *
 * Termux truncates **from the start**, so [text] is the *tail* of what the
 * command wrote. Any UI that says "first N characters" is lying; it is the last
 * N.
 */
public data class TermuxStream(
    public val text: String,
    /** Characters the command produced before Termux truncated. */
    public val originalLength: Int,
) {
    public val truncated: Boolean get() = originalLength > text.length

    /** Characters dropped off the FRONT. */
    public val droppedChars: Int get() = (originalLength - text.length).coerceAtLeast(0)

    public val isEmpty: Boolean get() = text.isEmpty()

    public companion object {
        public val Empty: TermuxStream = TermuxStream("", 0)

        /**
         * @param originalLength Termux's own count, as the string it sends.
         *   Missing or unparseable falls back to the length we actually have,
         *   i.e. it reports no truncation rather than inventing one — an
         *   invented "12 KB dropped" banner is worse than a missing one.
         */
        public fun of(text: String?, originalLength: String?): TermuxStream {
            val body = text.orEmpty()
            val claimed = originalLength?.trim()?.toIntOrNull()
            return TermuxStream(body, claimed?.coerceAtLeast(body.length) ?: body.length)
        }
    }
}

/** How Termux failed, when it was Termux that failed rather than the command. */
public enum class TermuxFailure {
    /**
     * `allow-external-apps` is not `true` in `~/.termux/termux.properties`.
     *
     * The permission being granted is not enough and never was: Termux checks
     * the property as a second, independent gate, and refuses the execution
     * before looking at the command. This is the state that looks like a bug.
     */
    ExternalAppsDisabled,

    /**
     * Anything else Termux reported — a missing executable, a working directory
     * it would not accept, the service being killed mid-run. [TermuxOutcome.Failed.detail]
     * carries Termux's own message, which is specific and worth showing verbatim.
     */
    Internal,
}

/** Why an execution never reached Termux at all. */
public sealed interface TermuxSendFailure {
    /** No `com.termux` package. Nothing to talk to. */
    public data object NotInstalled : TermuxSendFailure

    /** `com.termux.permission.RUN_COMMAND` is not granted to this app. */
    public data object PermissionDenied : TermuxSendFailure

    /**
     * Android refused to start Termux's service because Cody is in the
     * background. Only reachable if a command is dispatched while the app is
     * not visible.
     */
    public data object AppInBackground : TermuxSendFailure

    /** The command was refused before it was built. */
    public data class Rejected(public val rejection: TermuxRejection) : TermuxSendFailure

    public data class Unknown(public val message: String?) : TermuxSendFailure
}

/** What became of one execution. */
public sealed interface TermuxOutcome {

    /** Termux ran the command and the shell exited with [exitCode]. */
    public data class Completed(
        public val exitCode: Int,
        public val stdout: TermuxStream,
        public val stderr: TermuxStream,
    ) : TermuxOutcome

    /**
     * Termux accepted the intent and then failed. Any partial output Termux
     * still sent is kept: a command killed halfway has usually said something
     * useful first.
     */
    public data class Failed(
        public val failure: TermuxFailure,
        public val detail: String?,
        public val stdout: TermuxStream = TermuxStream.Empty,
        public val stderr: TermuxStream = TermuxStream.Empty,
    ) : TermuxOutcome

    /** Never handed over. */
    public data class NotSent(public val reason: TermuxSendFailure) : TermuxOutcome

    /**
     * Handed over, and nothing came back inside the window.
     *
     * Not the same as a hang: Android 12+ reaps phantom processes past a
     * system-wide cap and kills sustained-CPU ones, so a long command can
     * disappear without Termux ever getting to send a result.
     */
    public data object TimedOut : TermuxOutcome
}

/** Reading a result bundle. This is where every Termux quirk is absorbed. */
public object TermuxResults {

    public fun interpret(bundle: TermuxResultBundle): TermuxOutcome {
        val stdout = TermuxStream.of(bundle.stdout, bundle.stdoutOriginalLength)
        val stderr = TermuxStream.of(bundle.stderr, bundle.stderrOriginalLength)

        val err = bundle.err
        if (err != null && err != TermuxProtocol.ERR_SUCCESS) {
            return TermuxOutcome.Failed(
                failure = classify(bundle.errmsg),
                detail = bundle.errmsg?.takeIf { it.isNotBlank() },
                stdout = stdout,
                stderr = stderr,
            )
        }

        // err says success but there is no exit code: Termux never reached the
        // shell. Reporting this as "exit 0" would be the worst possible lie.
        val exitCode = bundle.exitCode
            ?: return TermuxOutcome.Failed(
                failure = classify(bundle.errmsg),
                detail = bundle.errmsg?.takeIf { it.isNotBlank() },
                stdout = stdout,
                stderr = stderr,
            )

        return TermuxOutcome.Completed(exitCode = exitCode, stdout = stdout, stderr = stderr)
    }

    /**
     * Termux's `allow-external-apps` refusal is only distinguishable by its
     * message. The upstream string is
     * "%1$s requires `allow-external-apps` property to be set to `true` in `%2$s` file."
     * and it is the only Termux error text containing that property name, so a
     * substring match is exact rather than hopeful.
     */
    private fun classify(errmsg: String?): TermuxFailure = when {
        errmsg != null &&
            errmsg.contains(TermuxProtocol.PROPERTY_ALLOW_EXTERNAL_APPS, ignoreCase = true) ->
            TermuxFailure.ExternalAppsDisabled

        else -> TermuxFailure.Internal
    }
}

/**
 * The three ways this integration is broken, plus the two ways it is not.
 *
 * They are separate states because they have three separate fixes and only one
 * of them is a thing the app can do anything about.
 */
public sealed interface TermuxAvailability {

    /** Not probed yet. */
    public data object Unknown : TermuxAvailability

    /** **State 1.** No Termux. Fix: install it — from one source, consistently. */
    public data object NotInstalled : TermuxAvailability

    /**
     * **State 2.** Termux is installed; `com.termux.permission.RUN_COMMAND` is
     * not granted. Fix: grant it in Cody's App info → Permissions → Additional
     * permissions.
     */
    public data object PermissionDenied : TermuxAvailability

    /**
     * **State 3, the trap.** Installed and granted, and Termux still refuses,
     * because `allow-external-apps` is unset. Store and release builds ship it
     * unset — that is the default, not a misconfiguration — so this is the
     * state a correctly-installed Termux lands in. Fix: add
     * `allow-external-apps=true` to `~/.termux/termux.properties`.
     */
    public data object ExternalAppsDisabled : TermuxAvailability

    /** Termux answered with something else entirely; [detail] is its own words. */
    public data class Broken(public val detail: String?) : TermuxAvailability

    /**
     * Usable. [workspaceReady] is false when the shared workspace could not be
     * created, which means Termux has no shared-storage access yet — a separate
     * problem with a separate fix (`termux-setup-storage`), and not a reason to
     * disable the box.
     */
    public data class Ready(public val workspaceReady: Boolean) : TermuxAvailability

    public val canRun: Boolean get() = this is Ready
}

/**
 * Turn the probe's outcome into an availability state.
 *
 * Installed-ness and the permission are checked before the probe is ever sent
 * (they are answerable locally); this only handles what Termux itself says.
 */
public fun TermuxOutcome.asAvailability(): TermuxAvailability = when (this) {
    is TermuxOutcome.Completed -> TermuxAvailability.Ready(
        workspaceReady = stdout.text.contains(TermuxProbe.WORKSPACE_OK),
    )

    is TermuxOutcome.Failed -> when (failure) {
        TermuxFailure.ExternalAppsDisabled -> TermuxAvailability.ExternalAppsDisabled
        TermuxFailure.Internal -> TermuxAvailability.Broken(detail)
    }

    is TermuxOutcome.NotSent -> when (reason) {
        TermuxSendFailure.NotInstalled -> TermuxAvailability.NotInstalled
        TermuxSendFailure.PermissionDenied -> TermuxAvailability.PermissionDenied
        TermuxSendFailure.AppInBackground -> TermuxAvailability.Broken(null)
        is TermuxSendFailure.Rejected -> TermuxAvailability.Broken(null)
        is TermuxSendFailure.Unknown -> TermuxAvailability.Broken(reason.message)
    }

    TermuxOutcome.TimedOut -> TermuxAvailability.Broken(null)
}
