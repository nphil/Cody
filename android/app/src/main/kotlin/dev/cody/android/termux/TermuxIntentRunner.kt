package dev.cody.android.termux

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import androidx.core.content.ContextCompat
import dev.cody.shared.presentation.TermuxRunner
import dev.cody.shared.termux.TermuxAvailability
import dev.cody.shared.termux.TermuxOutcome
import dev.cody.shared.termux.TermuxProtocol
import dev.cody.shared.termux.TermuxRequest
import dev.cody.shared.termux.TermuxResultBundle
import dev.cody.shared.termux.TermuxResults
import dev.cody.shared.termux.TermuxSendFailure
import dev.cody.shared.termux.TermuxWorkspace
import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/**
 * Drives Termux over its `RUN_COMMAND` intent API.
 *
 * This is the whole Android surface of the companion integration: build an
 * intent, hand it to a service in another app, and wait for a `PendingIntent`
 * to come back. Everything about *what* is run and *what the answer means*
 * lives in `:shared` where it can be tested without a device.
 */
class TermuxIntentRunner(context: Context) : TermuxRunner {

    private val appContext: Context = context.applicationContext

    /**
     * Resolved from the device rather than hard-coded to `/storage/emulated/0`,
     * which is only user 0 — see [TermuxWorkspace].
     */
    @Suppress("DEPRECATION")
    override val workspace: String =
        TermuxWorkspace.resolve(Environment.getExternalStorageDirectory().absolutePath)

    override fun inspect(): TermuxAvailability? = when {
        !isTermuxUsable() -> TermuxAvailability.NotInstalled
        ContextCompat.checkSelfPermission(appContext, TermuxProtocol.PERMISSION) !=
            PackageManager.PERMISSION_GRANTED -> TermuxAvailability.PermissionDenied
        // Everything answerable locally passes. Whether Termux will actually
        // obey is only knowable by asking it.
        else -> null
    }

    override suspend fun run(request: TermuxRequest): TermuxOutcome {
        val slot = TermuxResultRelay.open(appContext)
        try {
            val intent = buildIntent(request, TermuxResultRelay.pendingIntent(appContext, slot.id))
            try {
                // startService, not startForegroundService, because that is the
                // call every working RUN_COMMAND integration makes and this one
                // cannot be tested from here. RunCommandService promotes itself
                // with startForeground() in onCreate either way, Termux targets
                // an SDK exempt from the background-FGS-launch restriction, and
                // both calls are refused identically when Cody is backgrounded —
                // so the documented path costs nothing and risks less.
                appContext.startService(intent)
            } catch (_: SecurityException) {
                // com.termux.permission.RUN_COMMAND guards the service, so an
                // ungranted or just-revoked permission lands exactly here.
                return TermuxOutcome.NotSent(TermuxSendFailure.PermissionDenied)
            } catch (_: IllegalStateException) {
                // Covers ForegroundServiceStartNotAllowedException (API 31+),
                // which is a subclass, and the pre-31 background-start refusal.
                return TermuxOutcome.NotSent(TermuxSendFailure.AppInBackground)
            } catch (_: IllegalArgumentException) {
                // Termux uninstalled between inspect() and here.
                return TermuxOutcome.NotSent(TermuxSendFailure.NotInstalled)
            } catch (error: RuntimeException) {
                return TermuxOutcome.NotSent(TermuxSendFailure.Unknown(error.message))
            }

            return TermuxResults.interpret(slot.result.await())
        } finally {
            // The caller times out by cancelling this coroutine; the slot must
            // not outlive it or the map grows one entry per abandoned command.
            TermuxResultRelay.close(slot.id)
        }
    }

    /**
     * Installed *and* enabled. A disabled Termux still answers `getPackageInfo`
     * and then silently never runs anything.
     */
    private fun isTermuxUsable(): Boolean = try {
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            appContext.packageManager.getApplicationInfo(
                TermuxProtocol.PACKAGE_NAME,
                PackageManager.ApplicationInfoFlags.of(0),
            )
        } else {
            @Suppress("DEPRECATION")
            appContext.packageManager.getApplicationInfo(TermuxProtocol.PACKAGE_NAME, 0)
        }
        info.enabled
    } catch (_: PackageManager.NameNotFoundException) {
        // Also what is thrown when the <queries> entry is missing, which is why
        // that entry is in the manifest with a comment on it.
        false
    }

    private fun buildIntent(request: TermuxRequest, resultTarget: PendingIntent): Intent =
        Intent().apply {
            setClassName(TermuxProtocol.PACKAGE_NAME, TermuxProtocol.RUN_COMMAND_SERVICE)
            action = TermuxProtocol.ACTION_RUN_COMMAND
            putExtra(TermuxProtocol.EXTRA_COMMAND_PATH, request.executable)
            putExtra(TermuxProtocol.EXTRA_ARGUMENTS, request.arguments.toTypedArray())
            putExtra(TermuxProtocol.EXTRA_WORKDIR, request.workingDirectory)
            putExtra(TermuxProtocol.EXTRA_COMMAND_LABEL, request.label)
            // RUNNER is the current extra and BACKGROUND is the one older Termux
            // builds read. Sending both costs nothing and means the command does
            // not silently open a terminal session on an older install.
            putExtra(
                TermuxProtocol.EXTRA_RUNNER,
                if (request.background) TermuxProtocol.RUNNER_APP_SHELL
                else TermuxProtocol.RUNNER_TERMINAL_SESSION,
            )
            putExtra(TermuxProtocol.EXTRA_BACKGROUND, request.background)
            putExtra(TermuxProtocol.EXTRA_PENDING_INTENT, resultTarget)
        }

    companion object {
        /**
         * Hands the user to Termux itself. Used by the "open Termux" escape
         * hatch, which expects no result and is the only place a foreground
         * session is appropriate.
         */
        fun launchTermux(context: Context): Boolean {
            val intent = context.packageManager
                .getLaunchIntentForPackage(TermuxProtocol.PACKAGE_NAME)
                ?: return false
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            return try {
                context.startActivity(intent)
                true
            } catch (_: RuntimeException) {
                false
            }
        }
    }
}

/**
 * Routes Termux's results back to the coroutine that is waiting for one.
 *
 * A process-wide singleton with one receiver, because the alternative — a
 * receiver per execution — is a registration and a leak per command.
 *
 * The receiver is registered at runtime rather than declared in the manifest.
 * A manifest receiver would survive process death, but the coroutine and the
 * model it would deliver to do not, so it would buy nothing and cost an
 * exported component.
 */
internal object TermuxResultRelay {

    /** Our own action; the broadcast is sent under our uid by the PendingIntent. */
    private const val ACTION = "dev.cody.android.action.TERMUX_RESULT"
    private const val EXTRA_EXECUTION_ID = "dev.cody.android.extra.EXECUTION_ID"

    /**
     * Request codes must be unique per execution or results collide silently:
     * `PendingIntent` identity is (requestCode, intent) and `Intent.filterEquals`
     * **ignores extras**, so two live executions sharing a request code share
     * one `PendingIntent` and only the first result is ever delivered.
     *
     * Monotonic within a process, and seeded randomly rather than from 1 so
     * that a restart cannot collide with a `PendingIntent` left dangling by the
     * previous process — one whose baked-in execution id belongs to a coroutine
     * that no longer exists.
     */
    private val nextId = AtomicInteger(Random.nextInt(1, Int.MAX_VALUE / 2))

    private val waiting = ConcurrentHashMap<Int, CompletableDeferred<TermuxResultBundle>>()

    @Volatile
    private var registered = false

    class Slot(val id: Int, val result: CompletableDeferred<TermuxResultBundle>)

    fun open(context: Context): Slot {
        ensureReceiver(context)
        val id = nextId.getAndIncrement()
        val result = CompletableDeferred<TermuxResultBundle>()
        waiting[id] = result
        return Slot(id, result)
    }

    fun close(id: Int) {
        waiting.remove(id)
    }

    fun pendingIntent(context: Context, id: Int): PendingIntent {
        val target = Intent(ACTION)
            .setPackage(context.packageName)
            .putExtra(EXTRA_EXECUTION_ID, id)
        // FLAG_MUTABLE is mandatory from API 31: Termux fills the result bundle
        // into this intent, and an immutable PendingIntent silently arrives
        // empty. FLAG_ONE_SHOT because a result is delivered exactly once.
        val flags = PendingIntent.FLAG_ONE_SHOT or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getBroadcast(context, id, target, flags)
    }

    private fun ensureReceiver(context: Context) {
        if (registered) return
        synchronized(this) {
            if (registered) return
            ContextCompat.registerReceiver(
                context.applicationContext,
                Receiver,
                IntentFilter(ACTION),
                // The sender is this app, via the PendingIntent, so nothing
                // external ever needs to reach this.
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
            registered = true
        }
    }

    private object Receiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val id = intent.getIntExtra(EXTRA_EXECUTION_ID, NO_ID)
            val slot = waiting.remove(id) ?: return
            slot.complete(intent.readResultBundle())
        }
    }

    private const val NO_ID = -1

    /**
     * Termux sends everything inside one nested bundle. An absent bundle means
     * the result never made it — most likely a `TransactionTooLargeException`
     * raised inside the OS, which the sender cannot catch.
     */
    private fun Intent.readResultBundle(): TermuxResultBundle {
        val bundle = getBundleExtra(TermuxProtocol.EXTRA_RESULT_BUNDLE)
            ?: return TermuxResultBundle(
                stdout = null,
                stdoutOriginalLength = null,
                stderr = null,
                stderrOriginalLength = null,
                exitCode = null,
                err = null,
                errmsg = null,
            )
        return TermuxResultBundle(
            stdout = bundle.getString(TermuxProtocol.RESULT_STDOUT),
            // Deliberately getString: Termux stores these lengths as strings,
            // and getInt on them returns 0 — "nothing was truncated" on exactly
            // the outputs that were.
            stdoutOriginalLength = bundle.getString(TermuxProtocol.RESULT_STDOUT_ORIGINAL_LENGTH),
            stderr = bundle.getString(TermuxProtocol.RESULT_STDERR),
            stderrOriginalLength = bundle.getString(TermuxProtocol.RESULT_STDERR_ORIGINAL_LENGTH),
            // containsKey, not a sentinel: an absent exit code means Termux
            // never ran the command, and 0 would read as success.
            exitCode = bundle.optInt(TermuxProtocol.RESULT_EXIT_CODE),
            err = bundle.optInt(TermuxProtocol.RESULT_ERR),
            errmsg = bundle.getString(TermuxProtocol.RESULT_ERRMSG),
        )
    }

    private fun Bundle.optInt(key: String): Int? = if (containsKey(key)) getInt(key) else null
}
