package dev.cody.android.shizuku

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.IBinder
import android.os.Process
import androidx.compose.runtime.Immutable
import androidx.core.net.toUri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.lsposed.hiddenapibypass.HiddenApiBypass
import rikka.shizuku.Shizuku
import rikka.shizuku.ShizukuBinderWrapper
import rikka.shizuku.ShizukuProvider
import rikka.shizuku.SystemServiceHelper
import java.lang.reflect.InvocationTargetException

/**
 * Where Shizuku is, in the only five states it can be in.
 *
 * Each one has a different cause and a different fix, so each one gets its own
 * message and its own button. Collapsing them into "Shizuku unavailable" would
 * send a user with a stopped service hunting for an install, and a user on a
 * rebooted tablet hunting for a bug.
 */
@Immutable
sealed interface ShizukuState {
    /** No Shizuku manager app, and no Sui either. Offer the download page. */
    data object NotInstalled : ShizukuState

    /**
     * Installed, but no binder. On a non-rooted device Shizuku has to be started
     * again after every reboot, which is far and away the most common cause.
     */
    data object NotRunning : ShizukuState

    /** A pre-v11 server: the permission API this code uses does not exist. */
    data object Unsupported : ShizukuState

    /**
     * Alive, but this app is not authorised.
     *
     * @param canAsk false once the user has chosen "deny and don't ask again",
     *   after which `requestPermission` shows nothing at all and the only route
     *   is Shizuku's own app. Note the inversion: Shizuku's
     *   `shouldShowRequestPermissionRationale` returning TRUE is what means
     *   "permanently denied", which is the opposite of the Android runtime
     *   permission convention and is easy to get backwards.
     */
    data class Denied(val canAsk: Boolean) : ShizukuState

    /** Alive and authorised. */
    data object Ready : ShizukuState
}

/** Everything the Logs screen needs in order to say something true. */
@Immutable
data class ShizukuStatus(
    val shizuku: ShizukuState,
    /**
     * READ_LOGS was held when this gateway was built, which is the condition
     * `logd` actually honours. See [restartRequired] for why holding it *now*
     * is not the same question.
     */
    val logsReadable: Boolean,
    /**
     * A grant landed during this run. The permission is held, and the running
     * process still cannot use it: `logd` decides what a reader may see from the
     * caller's identity as it stood at process start. So the flow is explicitly
     * two-step, grant then restart, rather than a grant that appears to do
     * nothing.
     */
    val restartRequired: Boolean,
    /**
     * The Shizuku server's own uid: 2000 for the adb-backed service, 0 for a
     * root-backed one, -1 when unknown. Nothing here depends on the difference —
     * shell can grant a development permission perfectly well — but it is worth
     * showing, because anything added later that assumes root's reach would be
     * wrong on the common setup.
     */
    val serverUid: Int,
)

/** Why a grant did not happen. Each maps to a distinct sentence in the UI. */
enum class GrantFailure {
    /** The binder died between the check and the call. */
    ShizukuUnavailable,

    /** The framework would not expose `IPackageManager` to this process. */
    HiddenApiBlocked,

    /** `ServiceManager` had no "package" service, which should be impossible. */
    ServiceUnavailable,

    /** The call reached the system and the system said no. */
    Refused,
}

// Annotated, not left to inference: Compose cannot infer stability for a sealed
// interface, so without this the panel's `grant` parameter reads as unstable in
// the stability report even though every implementation below is a value.
// This type lives in :app, so route B of docs/android-ux.md §6.3 is available.
@Immutable
sealed interface GrantOutcome {
    /** Nothing to do: the permission was already held before this run. */
    data object AlreadyHeld : GrantOutcome

    /** Done. Not usable until the process restarts. */
    data object Granted : GrantOutcome

    data class Failed(val reason: GrantFailure, val detail: String?) : GrantOutcome
}

/**
 * Everything this app does with Shizuku, which is exactly one thing: get
 * `READ_LOGS` granted so that on-device logcat becomes readable.
 *
 * Deliberately not a process singleton and deliberately not touched from
 * `CodyApplication`. It is built when the Logs screen is first opened, so a
 * launch that never goes near that screen never loads the Shizuku classes, never
 * pings a binder and never asks the user for anything. `ShizukuProvider` in the
 * manifest is the only part that runs at process start, and only because the
 * library requires it to receive the binder at all.
 */
class ShizukuGateway(
    private val context: Context,
    private val scope: CoroutineScope,
) {

    /**
     * Captured once, before this object can possibly have granted anything, so
     * that "held" and "held and usable" stay distinguishable for the lifetime of
     * the process.
     */
    private val heldAtStart: Boolean = holdsReadLogs()

    private val _status = MutableStateFlow(
        ShizukuStatus(
            shizuku = ShizukuState.NotInstalled,
            logsReadable = heldAtStart,
            restartRequired = false,
            serverUid = -1,
        ),
    )
    val status: StateFlow<ShizukuStatus> = _status.asStateFlow()

    // Held as fields because removal takes the same instance that was added.
    private val onBinderReceived = Shizuku.OnBinderReceivedListener { refresh() }
    private val onBinderDead = Shizuku.OnBinderDeadListener { refresh() }
    private val onPermissionResult =
        Shizuku.OnRequestPermissionResultListener { _, _ -> refresh() }

    /**
     * Start observing. The sticky variant fires straight away when the binder
     * has already arrived, which is the normal case: Shizuku pushes the binder
     * into the provider at process start, long before this screen is opened.
     */
    fun attach() {
        runCatching {
            Shizuku.addBinderReceivedListenerSticky(onBinderReceived)
            Shizuku.addBinderDeadListener(onBinderDead)
            Shizuku.addRequestPermissionResultListener(onPermissionResult)
        }
        refresh()
    }

    fun detach() {
        runCatching {
            Shizuku.removeBinderReceivedListener(onBinderReceived)
            Shizuku.removeBinderDeadListener(onBinderDead)
            Shizuku.removeRequestPermissionResultListener(onPermissionResult)
        }
    }

    /**
     * Re-probe, off the main thread.
     *
     * Every branch of [probe] is an IPC — a binder round trip to Shizuku's own
     * process, or `getPackageInfo` to the package manager. Shizuku's server is a
     * user-space process that can be busy or dying, so a probe on Main is a
     * frame this app does not control. Called from the library's listeners,
     * which deliver on Main, so hopping is not optional.
     */
    fun refresh() {
        scope.launch(Dispatchers.IO) {
            val state = probe()
            val uid = if (state == ShizukuState.Ready) {
                runCatching { Shizuku.getUid() }.getOrDefault(-1)
            } else {
                -1
            }
            _status.update { it.copy(shizuku = state, serverUid = uid) }
        }
    }

    /**
     * Ask Shizuku for authorisation. Only ever called from a tap: nothing here
     * runs on its own.
     */
    fun requestPermission() {
        runCatching { Shizuku.requestPermission(PERMISSION_REQUEST_CODE) }
            .onFailure { refresh() }
    }

    /**
     * Grant this app `READ_LOGS` through Shizuku's privileged binder.
     *
     * `READ_LOGS` is `signature|privileged|development`, and the *development*
     * flag is the only reason a shell-uid caller can hand it over at all — the
     * same mechanism as `adb shell pm grant`.
     *
     * Two things about how this is done are load-bearing:
     *
     * 1. **`ShizukuBinderWrapper`, not `Shizuku.newProcess`.** `newProcess` is
     *    deprecated, has no tty, and is already private in the current API
     *    source. Wrapping the real `package` service binder means the call is an
     *    ordinary binder transaction that happens to be re-signed with shell's
     *    identity.
     *
     * 2. **`IPackageManager`, not `IPermissionManager`.**
     *    `IPackageManager#grantRuntimePermission(String, String, int)` is
     *    byte-for-byte the same signature from API 29 through API 36 (checked
     *    against `core/java/android/content/pm/IPackageManager.aidl` at
     *    android-10.0.0_r1 … android-16.0.0_r1). `IPermissionManager`'s version
     *    of the same method gained a `persistentDeviceId` parameter in API 35,
     *    so binding to it would break on exactly the newest devices.
     *
     * The reflection is unavoidable: AOSP lists
     * `IPackageManager$Stub$Proxy;->grantRuntimePermission` in
     * `boot/hiddenapi/hiddenapi-max-target-o.txt`, i.e. blocked for anything
     * targeting past API 26.
     */
    // The PrivateApi reflection below is the feature, not an oversight: the
    // whole point of routing through Shizuku is to reach a member the platform
    // hides. Suppressed here and nowhere else, so the check keeps working
    // everywhere it would be telling us something.
    @SuppressLint("PrivateApi")
    suspend fun grantReadLogs(): GrantOutcome = withContext(Dispatchers.IO) {
        if (heldAtStart) return@withContext GrantOutcome.AlreadyHeld
        if (!Shizuku.pingBinder()) return@withContext GrantOutcome.Failed(GrantFailure.ShizukuUnavailable, null)

        // Best effort, and NOT fatal on its own: a userdebug build or a device
        // with hidden_api_policy relaxed lets the reflection below through
        // unaided, and there is no reason to refuse to try.
        val exempted = HiddenApi.unlock()

        val service = runCatching { SystemServiceHelper.getSystemService(PACKAGE_SERVICE) }.getOrNull()
            ?: return@withContext GrantOutcome.Failed(GrantFailure.ServiceUnavailable, null)

        try {
            val stub = Class.forName("android.content.pm.IPackageManager\$Stub")
            val packageManager = stub
                .getMethod("asInterface", IBinder::class.java)
                .invoke(null, ShizukuBinderWrapper(service))
            Class.forName("android.content.pm.IPackageManager")
                .getMethod(
                    "grantRuntimePermission",
                    String::class.java,
                    String::class.java,
                    Int::class.javaPrimitiveType,
                )
                .invoke(packageManager, context.packageName, Manifest.permission.READ_LOGS, userId())
            _status.update { it.copy(restartRequired = true) }
            GrantOutcome.Granted
        } catch (invocation: InvocationTargetException) {
            // The call went out over the binder and came back with an error, so
            // the reflection worked and the SYSTEM said no. Distinct from the
            // branch below, where the call was never made.
            val cause = invocation.cause ?: invocation
            GrantOutcome.Failed(GrantFailure.Refused, cause.message ?: cause::class.java.simpleName)
        } catch (blocked: ReflectiveOperationException) {
            // NoSuchMethod / ClassNotFound: the runtime hid the member. Whether
            // the exemption took is the single most useful thing to know here,
            // so it travels with the message rather than being swallowed.
            GrantOutcome.Failed(
                GrantFailure.HiddenApiBlocked,
                "hiddenApiExempt=$exempted; ${blocked.message ?: blocked::class.java.simpleName}",
            )
        } catch (failure: Throwable) {
            // Shizuku raises RuntimeException around RemoteException, and a dead
            // binder mid-call surfaces as IllegalStateException.
            GrantOutcome.Failed(GrantFailure.Refused, failure.message ?: failure::class.java.simpleName)
        }
    }

    /** Open Shizuku's own app, for permission management or to start the service. */
    fun openShizuku(): Boolean = start(
        context.packageManager
            .getLaunchIntentForPackage(ShizukuProvider.MANAGER_APPLICATION_ID)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )

    /** Open the project page, which is where installing it is explained. */
    fun openShizukuHomepage(): Boolean = start(
        Intent(Intent.ACTION_VIEW, SHIZUKU_HOMEPAGE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )

    /**
     * Relaunch the app so a fresh process picks up the grant.
     *
     * `makeRestartActivityTask` is the framework's own recipe for this: it
     * builds a MAIN/LAUNCHER intent with `CLEAR_TASK or NEW_TASK`, so the new
     * process starts at the launcher entry with no stale back stack. The
     * `exit(0)` is what makes it a genuinely new process, which is the entire
     * point — anything softer leaves `logd` still refusing this pid.
     */
    fun restart() {
        val launcher = context.packageManager
            .getLaunchIntentForPackage(context.packageName)
            ?.component
            ?: return
        context.startActivity(Intent.makeRestartActivityTask(launcher))
        Runtime.getRuntime().exit(0)
    }

    private fun probe(): ShizukuState {
        // Order matters. A live binder settles the question on its own: Sui (the
        // root-module flavour) serves the same API with no manager package
        // installed at all, so checking for the package first would report
        // "not installed" to a user for whom it is plainly working.
        if (!Shizuku.pingBinder()) {
            return if (isManagerInstalled()) ShizukuState.NotRunning else ShizukuState.NotInstalled
        }
        if (Shizuku.isPreV11()) return ShizukuState.Unsupported
        return try {
            if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
                ShizukuState.Ready
            } else {
                ShizukuState.Denied(canAsk = !Shizuku.shouldShowRequestPermissionRationale())
            }
        } catch (_: Throwable) {
            // The binder died between the ping and the call; every Shizuku
            // method throws IllegalStateException once that happens.
            if (isManagerInstalled()) ShizukuState.NotRunning else ShizukuState.NotInstalled
        }
    }

    @Suppress("DEPRECATION")
    private fun isManagerInstalled(): Boolean = try {
        context.packageManager.getPackageInfo(ShizukuProvider.MANAGER_APPLICATION_ID, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    private fun holdsReadLogs(): Boolean =
        context.checkSelfPermission(Manifest.permission.READ_LOGS) == PackageManager.PERMISSION_GRANTED

    private fun start(intent: Intent?): Boolean {
        if (intent == null) return false
        return runCatching { context.startActivity(intent) }.isSuccess
    }

    private companion object {
        /** Matched in the permission-result callback; any stable value will do. */
        const val PERMISSION_REQUEST_CODE = 5_309

        /** `ServiceManager`'s name for `IPackageManager`. */
        const val PACKAGE_SERVICE = "package"

        val SHIZUKU_HOMEPAGE: Uri = "https://shizuku.rikka.app/".toUri()

        /**
         * `UserHandle.myUserId()` is itself a hidden API; this is the same
         * arithmetic against `UserHandle.PER_USER_RANGE`, using only public
         * calls. Zero on a device with no work profile or secondary user.
         */
        fun userId(): Int = Process.myUid() / 100_000
    }
}

/**
 * One-shot hidden-API exemption, narrowed to the package actually needed.
 *
 * `VMRuntime.setHiddenApiExemptions` replaces the list rather than adding to it
 * and is documented as callable only once in future Android releases, so this is
 * the single place in the app that calls it, and it is called lazily — the first
 * time the user taps Grant, never at launch.
 *
 * `Landroid/content/pm/` rather than a blanket `L` prefix: the only blocked
 * members this app touches are `IPackageManager$Stub#asInterface` and
 * `IPackageManager#grantRuntimePermission`. `ServiceManager#getService`, which
 * `SystemServiceHelper` reaches by reflection, carries a plain
 * `@UnsupportedAppUsage` with no `maxTargetSdk` in AOSP and is therefore
 * reachable without any exemption at all.
 */
private object HiddenApi {
    @Volatile
    private var unlocked: Boolean? = null

    fun unlock(): Boolean {
        unlocked?.let { return it }
        return synchronized(this) {
            unlocked ?: run {
                // Throwable, not Exception: HiddenApiBypass computes ART struct
                // offsets in a static initialiser, so an unsupported runtime
                // arrives as ExceptionInInitializerError.
                val result = try {
                    HiddenApiBypass.setHiddenApiExemptions("Landroid/content/pm/")
                } catch (_: Throwable) {
                    false
                }
                unlocked = result
                result
            }
        }
    }
}
