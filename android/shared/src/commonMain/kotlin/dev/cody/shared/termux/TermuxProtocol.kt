package dev.cody.shared.termux

/**
 * The wire contract of Termux's `RUN_COMMAND` intent API, mirrored by hand.
 *
 * Every constant below was read off Termux's own `TermuxConstants` and
 * `RunCommandService` rather than guessed, because a typo in an extra key does
 * not fail: Termux ignores the extra and the command runs with a silently
 * different shape. The upstream sources are
 * `termux-shared/.../termux/TermuxConstants.java` and
 * `app/.../app/RunCommandService.java`, and the prose contract is the
 * `RUN_COMMAND-Intent` wiki page.
 *
 * Termux publishes `termux-shared` as a library and recommends importing these
 * symbols instead of copying them. We copy anyway, deliberately: `termux-shared`
 * is GPLv3, and `docs/android.md` is explicit that the licence boundary is a
 * decision to make **before** GPL code enters this build, not after. These are
 * interface facts — package names and extra keys — not expression, and the
 * companion path exists precisely so that nothing of Termux's is linked in.
 */
public object TermuxProtocol {

    /** Termux's application id. Its `$PREFIX` binaries hard-code this path. */
    public const val PACKAGE_NAME: String = "com.termux"

    /** The exported service that accepts `RUN_COMMAND`, guarded by [PERMISSION]. */
    public const val RUN_COMMAND_SERVICE: String = "com.termux.app.RunCommandService"

    /** The intent action [RUN_COMMAND_SERVICE] requires; anything else is rejected. */
    public const val ACTION_RUN_COMMAND: String = "com.termux.RUN_COMMAND"

    /**
     * Termux's own dangerous permission, declared by Termux and granted to us.
     *
     * The service is `exported="true" permission="com.termux.permission.RUN_COMMAND"`,
     * so an ungranted caller gets a `SecurityException` from `startService`
     * rather than a result — which is what makes "denied" cleanly detectable.
     */
    public const val PERMISSION: String = "com.termux.permission.RUN_COMMAND"

    /** `~/.termux/termux.properties` key Termux checks *in addition* to [PERMISSION]. */
    public const val PROPERTY_ALLOW_EXTERNAL_APPS: String = "allow-external-apps"

    /** The exact line the user has to add to `termux.properties`. */
    public const val PROPERTY_ALLOW_EXTERNAL_APPS_LINE: String = "allow-external-apps=true"

    /** Absolute path of `termux.properties`, as Termux's shell writes it. */
    public const val PROPERTIES_FILE: String = "~/.termux/termux.properties"

    /** `$PREFIX`. Termux also expands a literal `$PREFIX/` prefix in path extras. */
    public const val PREFIX_DIR: String = "/data/data/com.termux/files/usr"

    /** `$HOME`, the default working directory when [EXTRA_WORKDIR] is unset. */
    public const val HOME_DIR: String = "/data/data/com.termux/files/home"

    /** The login shell every command is run through. */
    public const val BASH: String = "$PREFIX_DIR/bin/bash"

    // --- request extras ------------------------------------------------------

    /** `String`, mandatory: absolute path of the executable. */
    public const val EXTRA_COMMAND_PATH: String = "com.termux.RUN_COMMAND_PATH"

    /** `String[]`: argv *after* the executable. */
    public const val EXTRA_ARGUMENTS: String = "com.termux.RUN_COMMAND_ARGUMENTS"

    /** `String`: working directory. */
    public const val EXTRA_WORKDIR: String = "com.termux.RUN_COMMAND_WORKDIR"

    /**
     * `boolean`: run as a background app-shell rather than a terminal session.
     *
     * Marked `@Deprecated` upstream in favour of [EXTRA_RUNNER], but still read,
     * and still the only extra older Termux builds understand. We send both:
     * [EXTRA_RUNNER] wins where it is supported and this is the fallback.
     */
    public const val EXTRA_BACKGROUND: String = "com.termux.RUN_COMMAND_BACKGROUND"

    /** `String`: [RUNNER_APP_SHELL] or [RUNNER_TERMINAL_SESSION]. */
    public const val EXTRA_RUNNER: String = "com.termux.RUN_COMMAND_RUNNER"

    /** `String`: shown in Termux's own error popup, so keep it short and human. */
    public const val EXTRA_COMMAND_LABEL: String = "com.termux.RUN_COMMAND_COMMAND_LABEL"

    /** `Parcelable`: the `PendingIntent` Termux sends the result back through. */
    public const val EXTRA_PENDING_INTENT: String = "com.termux.RUN_COMMAND_PENDING_INTENT"

    /** `String`: session action for terminal-session runs. */
    public const val EXTRA_SESSION_ACTION: String = "com.termux.RUN_COMMAND_SESSION_ACTION"

    /** Background runner: the only one that returns stdout and stderr separately. */
    public const val RUNNER_APP_SHELL: String = "app-shell"

    /** Foreground runner: returns a combined session transcript, not two streams. */
    public const val RUNNER_TERMINAL_SESSION: String = "terminal-session"

    /** Open the Termux activity on a new session and bring it to the front. */
    public const val SESSION_ACTION_NEW_SESSION_AND_OPEN: String = "0"

    // --- result extras -------------------------------------------------------

    /** The `Bundle` the result arrives in, on the intent sent to our PendingIntent. */
    public const val EXTRA_RESULT_BUNDLE: String = "result"

    /** `String`. Truncated from the START, so what arrives is the tail. */
    public const val RESULT_STDOUT: String = "stdout"

    /** `String` holding an integer: `stdout` length in chars *before* truncation. */
    public const val RESULT_STDOUT_ORIGINAL_LENGTH: String = "stdout_original_length"

    /** `String`. Truncated from the START, so what arrives is the tail. */
    public const val RESULT_STDERR: String = "stderr"

    /** `String` holding an integer: `stderr` length in chars *before* truncation. */
    public const val RESULT_STDERR_ORIGINAL_LENGTH: String = "stderr_original_length"

    /** `int`. ABSENT when Termux never got as far as running the command. */
    public const val RESULT_EXIT_CODE: String = "exitCode"

    /** `int`: Termux-internal error code, [ERR_SUCCESS] when there was none. */
    public const val RESULT_ERR: String = "err"

    /** `String`: Termux-internal error text, truncated from the end to 25 KB. */
    public const val RESULT_ERRMSG: String = "errmsg"

    /**
     * `Activity.RESULT_OK` (`-1`), which is what Termux's `ERRNO_SUCCESS` is
     * defined as. Any other value in [RESULT_ERR] means Termux itself failed —
     * `0` is `ERRNO_CANCELLED`, `1` is minor failures, `2` is a hard failure.
     */
    public const val ERR_SUCCESS: Int = -1
}

/**
 * The limits that shape the UI, not just the code. All four are real and all
 * four are silent when crossed, which is why they are named here rather than
 * discovered in the field.
 */
public object TermuxLimits {

    /**
     * Android's Binder transaction ceiling for the whole intent, ~500 KB.
     *
     * The consequence is a design rule, not a bounds check: **never pass file
     * contents as an argument.** Write the file into the shared workspace and
     * pass a path.
     */
    public const val INTENT_EXTRAS_BYTES: Int = 500 * 1024

    /**
     * `ARG_MAX`-ish ceiling on the command line itself, ~128 KB on Android.
     * Comfortable for a script, hopeless for data.
     */
    public const val ARGUMENTS_BYTES: Int = 128 * 1024

    /**
     * Termux's `DataUtils.TRANSACTION_SIZE_LIMIT_IN_BYTES`: stdout and stderr
     * are truncated to this **combined** before the result is sent, because
     * exceeding it raises a `TransactionTooLargeException` inside the OS that
     * the caller cannot catch and that makes the result vanish silently.
     *
     * Units are *characters*, not bytes — Termux measures with `String.length()`.
     */
    public const val RESULT_OUTPUT_CHARS: Int = 100 * 1024

    /**
     * When both streams carry data, Termux halves the budget and gives each
     * stream [RESULT_OUTPUT_CHARS] / 2. A command that writes to both therefore
     * starts losing output at 50 KB per stream, not 100 KB.
     */
    public const val RESULT_OUTPUT_CHARS_PER_STREAM: Int = RESULT_OUTPUT_CHARS / 2

    /** `errmsg` is truncated from the END, to preserve the start of stack traces. */
    public const val ERRMSG_CHARS: Int = RESULT_OUTPUT_CHARS / 4
}

/**
 * The one directory both apps can name.
 *
 * **`<primary shared storage>/Documents/Cody`**, i.e. `/storage/emulated/0/Documents/Cody`
 * on a single-user device. It survives Android's storage rules for three
 * reasons, and every other candidate fails at least one of them:
 *
 * - It is **not** either app's private data directory. `/data/data/com.termux/files/home`
 *   is unreadable by us and `/data/data/dev.cody.android` is unreadable by
 *   Termux; app-private storage is the one place a companion integration can
 *   never meet.
 * - It is **not** under `Android/data`. Since Android 11 that subtree is hidden
 *   from every other app *including* holders of `MANAGE_EXTERNAL_STORAGE`, so
 *   `getExternalFilesDir()` — the obvious choice — is exactly the wrong one.
 * - It is a **public** shared-storage directory, so it outlives an uninstall of
 *   either app and the user can reach it from a file manager, a USB cable or
 *   another editor.
 *
 * Termux reaches it as [TERMUX_SHELL_PATH] once the user has run
 * `termux-setup-storage` (which is what creates `~/storage` and triggers the
 * storage permission grant); before that, Termux has no shared-storage access
 * at all and `mkdir` there fails.
 *
 * Cody's own side is honest about the asymmetry: on Android 11+ this app
 * **cannot** open these files with plain `File` I/O either, for the same scoped
 * storage reasons. Today it reaches the workspace only *through* Termux, by
 * running commands with it as the working directory. When a file browser lands,
 * the sanctioned mechanism is a one-time `ACTION_OPEN_DOCUMENT_TREE` grant on
 * this directory, persisted — not a storage permission.
 */
public object TermuxWorkspace {

    /** Path relative to the root of primary shared storage. */
    public const val RELATIVE_PATH: String = "Documents/Cody"

    /** How the directory appears to a Termux shell after `termux-setup-storage`. */
    public const val TERMUX_SHELL_PATH: String = "~/storage/shared/Documents/Cody"

    /** The command that creates `~/storage`, without which the workspace cannot exist. */
    public const val SETUP_STORAGE_COMMAND: String = "termux-setup-storage"

    /**
     * @param sharedStorageRoot primary external storage as this device reports
     *   it. Resolved on the Android side rather than hard-coded, because
     *   `/storage/emulated/0` is only user 0 — a work profile or a second user
     *   is `/storage/emulated/10` and a hard-coded path would point at another
     *   user's files.
     */
    public fun resolve(sharedStorageRoot: String): String =
        sharedStorageRoot.trimEnd('/') + "/" + RELATIVE_PATH
}
