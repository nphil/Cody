package dev.cody.shared.presentation

import dev.cody.shared.backend.BackendCapabilities
import dev.cody.shared.termux.TermuxAvailability
import kotlinx.coroutines.flow.Flow

/**
 * Which palette the app paints with.
 *
 * Three values rather than a boolean because "follow the system" is a real
 * third state and not the absence of a choice: a user on automatic dark mode
 * wants the app to move with the device, and collapsing that into "currently
 * light" would freeze it at whatever the device happened to be when they
 * looked.
 */
public enum class ThemeChoice(
    /** Persisted form. Written down so a rename cannot silently reset a device. */
    public val id: String,
) {
    FollowSystem("system"),
    Light("light"),
    Dark("dark"),
    ;

    /** The only question the theme actually needs answered. */
    public fun isDark(systemDark: Boolean): Boolean = when (this) {
        FollowSystem -> systemDark
        Light -> false
        Dark -> true
    }

    public companion object {
        /**
         * Unknown ids resolve to [FollowSystem] rather than throwing: the stored
         * value comes off disk and may have been written by a build that knew a
         * value this one does not.
         */
        public fun fromId(id: String?): ThemeChoice =
            entries.firstOrNull { it.id == id } ?: FollowSystem
    }
}

/**
 * Persistence seam for the device-local preferences.
 *
 * Same split as [dev.cody.shared.backend.CredentialStore]: the interface is in
 * common code and the storage is platform business (`DataStore` on Android), so
 * nothing that has to port knows how a preference is written.
 */
public interface SettingsStore {
    public val theme: Flow<ThemeChoice>

    public suspend fun setTheme(choice: ThemeChoice)
}

/**
 * One capability the backend advertised, and whether this client has anywhere
 * to put it.
 *
 * Both halves are needed to answer the question a user actually asks — "why is
 * there no model picker?" — because there are two different reasons: the server
 * did not advertise it, or this build has no screen for it. A list that showed
 * only the first would send someone hunting for a panel that was never written.
 */
public data class CapabilityRow(
    public val id: CapabilityId,
    /** The server (or the backend itself) says this works. */
    public val advertised: Boolean,
)

/**
 * The capability vocabulary, mirroring [BackendCapabilities]' fields.
 *
 * [hasSurface] is a property of THIS build and is maintained by hand: when a
 * surface for a capability ships, flip its flag here in the same change. It is
 * on the enum entry rather than in a set so that the flip is one word next to
 * the name and cannot drift out of sync with the row order.
 */
public enum class CapabilityId(public val hasSurface: Boolean) {
    Sessions(hasSurface = true),
    LiveEvents(hasSurface = true),
    Prompts(hasSurface = true),
    Models(hasSurface = false),
    Skills(hasSurface = false),
    Plugins(hasSurface = false),
    Mcp(hasSurface = false),
    ChatExtras(hasSurface = false),
    EngineSettings(hasSurface = false),
    Updates(hasSurface = false),
}

/**
 * Flattens [BackendCapabilities] into display rows, in a fixed order.
 *
 * Fixed, and core-first, because this list is read as a diagnostic: a user
 * comparing two servers, or the same server before and after an upgrade, needs
 * the rows to be in the same place both times.
 *
 * Every field of [BackendCapabilities] appears exactly once. When a field is
 * added there, add its row here — an unlisted flag is not a compile error, it is
 * a silently missing line in About.
 */
public fun capabilityRows(capabilities: BackendCapabilities): List<CapabilityRow> = listOf(
    CapabilityRow(CapabilityId.Sessions, capabilities.sessions),
    CapabilityRow(CapabilityId.LiveEvents, capabilities.liveEvents),
    CapabilityRow(CapabilityId.Prompts, capabilities.prompts),
    CapabilityRow(CapabilityId.Models, capabilities.models),
    CapabilityRow(CapabilityId.Skills, capabilities.skills),
    CapabilityRow(CapabilityId.Plugins, capabilities.plugins),
    CapabilityRow(CapabilityId.Mcp, capabilities.mcp),
    CapabilityRow(CapabilityId.ChatExtras, capabilities.chatExtras),
    CapabilityRow(CapabilityId.EngineSettings, capabilities.engineSettings),
    CapabilityRow(CapabilityId.Updates, capabilities.updates),
)

/**
 * How a device prerequisite stands, stripped of which prerequisite it is.
 *
 * The point of the enum is that the row's colour and whether a fix is worth
 * offering are the same decision for Termux and for Shizuku, and both are
 * shades of "not ready" that must not be collapsed:
 *
 * - [Absent] is not a fault. Neither companion app is required to use Cody, and
 *   a red row for "Shizuku is not installed" would nag about an optional power
 *   feature (docs/android-ux.md §5.2).
 * - [Blocked] is installed-but-refusing, which is the state a correct install
 *   lands in and the only one where the user is being asked to do something.
 * - [Degraded] is usable with a caveat, e.g. Termux runs commands but has no
 *   shared storage yet — a separate fix, and not a reason to call it broken.
 */
public enum class PrereqLevel { Unknown, Absent, Blocked, Degraded, Ready }

/** The one fix worth offering for a Termux prerequisite row. */
public enum class TermuxFix {
    /** Nothing to do, or nothing this app can do. */
    None,
    Install,

    /**
     * `com.termux.permission.RUN_COMMAND`. Settings links out to App info
     * rather than raising the dialog: the ask-then-fall-back-to-settings flow
     * belongs to the Terminal surface, and two places asking for one permission
     * is how a user ends up with the dialog that never appears again.
     */
    AppPermissions,
    EnableExternalApps,
    OpenTermux,
    SetUpStorage,
}

/** A prerequisite row, summarised: how bad it is, and the single fix to offer. */
public data class TermuxPrereq(
    public val level: PrereqLevel,
    public val fix: TermuxFix,
)

/**
 * Summarises the Termux availability the Terminal surface already derived.
 *
 * This deliberately does NOT probe or re-derive anything: [TermuxAvailability]
 * is the answer `TerminalModel` computed from a real `RUN_COMMAND` round trip,
 * and Settings only decides how to say it in one line.
 */
public fun TermuxAvailability.asPrereq(): TermuxPrereq = when (this) {
    TermuxAvailability.Unknown -> TermuxPrereq(PrereqLevel.Unknown, TermuxFix.None)

    TermuxAvailability.NotInstalled -> TermuxPrereq(PrereqLevel.Absent, TermuxFix.Install)

    TermuxAvailability.PermissionDenied ->
        TermuxPrereq(PrereqLevel.Blocked, TermuxFix.AppPermissions)

    TermuxAvailability.ExternalAppsDisabled ->
        TermuxPrereq(PrereqLevel.Blocked, TermuxFix.EnableExternalApps)

    is TermuxAvailability.Broken -> TermuxPrereq(PrereqLevel.Blocked, TermuxFix.OpenTermux)

    is TermuxAvailability.Ready -> if (workspaceReady) {
        TermuxPrereq(PrereqLevel.Ready, TermuxFix.None)
    } else {
        // Commands run; they just run in Termux's home directory. Terminal is
        // usable, so this is a caveat and not a blocker.
        TermuxPrereq(PrereqLevel.Degraded, TermuxFix.SetUpStorage)
    }
}
