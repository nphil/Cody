package dev.cody.shared

import dev.cody.shared.backend.BackendCapabilities
import dev.cody.shared.model.ServerCapabilities
import dev.cody.shared.presentation.CapabilityId
import dev.cody.shared.presentation.PrereqLevel
import dev.cody.shared.presentation.TermuxFix
import dev.cody.shared.presentation.ThemeChoice
import dev.cody.shared.presentation.asPrereq
import dev.cody.shared.presentation.capabilityRows
import dev.cody.shared.termux.TermuxAvailability
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The pure half of the settings surface: the theme choice, the capability
 * flattening that About renders, and the one-line summary of a device
 * prerequisite.
 *
 * All three are things a screenshot cannot check and a device is not needed for.
 * The capability test in particular is the guard on a promise the screen makes:
 * that the list explains why a surface is missing, which is only true while
 * every flag the backend can report has a row.
 */
class SettingsModelTest {

    // --- theme ---------------------------------------------------------------

    @Test
    fun `follow system tracks the device and the explicit choices do not`() {
        assertTrue(ThemeChoice.FollowSystem.isDark(systemDark = true))
        assertFalse(ThemeChoice.FollowSystem.isDark(systemDark = false))

        assertTrue(ThemeChoice.Dark.isDark(systemDark = false))
        assertFalse(ThemeChoice.Light.isDark(systemDark = true))
    }

    @Test
    fun `stored ids round-trip and an unknown id falls back to following the system`() {
        for (choice in ThemeChoice.entries) {
            assertEquals(choice, ThemeChoice.fromId(choice.id))
        }
        // Both real cases: a value from a build that knew more, and no value yet.
        assertEquals(ThemeChoice.FollowSystem, ThemeChoice.fromId("solarized-noon"))
        assertEquals(ThemeChoice.FollowSystem, ThemeChoice.fromId(null))
    }

    // --- capability list -----------------------------------------------------

    @Test
    fun `every capability id gets exactly one row, in a stable order`() {
        val rows = capabilityRows(BackendCapabilities.Core)

        assertEquals(CapabilityId.entries, rows.map { it.id })
        assertEquals(CapabilityId.entries.size, rows.distinctBy { it.id }.size)
    }

    @Test
    fun `rows report what the backend advertised, not what the client wants`() {
        // Everything a server can say yes to, said yes to.
        val everything = BackendCapabilities.fromServer(
            ServerCapabilities(
                liveSessions = true,
                models = true,
                skills = true,
                plugins = true,
                mcp = true,
                nativeSettings = true,
                updates = true,
                chatExtras = true,
            ),
        )
        assertTrue(capabilityRows(everything).all { it.advertised })

        // An older server that reports nothing: the two routes the client needs
        // in order to work at all are still true, because RemoteBackend asserts
        // them, and everything the server owns is false.
        val bare = BackendCapabilities.fromServer(ServerCapabilities())
        val advertised = capabilityRows(bare).filter { it.advertised }.map { it.id }
        assertEquals(listOf(CapabilityId.Sessions, CapabilityId.Prompts), advertised)
    }

    @Test
    fun `a surfaced capability that is not advertised is what hides a surface`() {
        val rows = capabilityRows(BackendCapabilities.fromServer(ServerCapabilities()))
        val liveEvents = rows.single { it.id == CapabilityId.LiveEvents }

        // liveEvents has a surface in this build (streaming) and this server did
        // not advertise it: exactly the pair the About list exists to explain.
        assertTrue(liveEvents.id.hasSurface)
        assertFalse(liveEvents.advertised)

        // And the converse: a flag with no screen behind it, so an advertised
        // `true` must not be read as "there is a panel for this".
        assertFalse(CapabilityId.Models.hasSurface)
    }

    // --- device prerequisites ------------------------------------------------

    @Test
    fun `a missing companion app is absent, not broken`() {
        val prereq = TermuxAvailability.NotInstalled.asPrereq()

        assertEquals(PrereqLevel.Absent, prereq.level)
        assertEquals(TermuxFix.Install, prereq.fix)
    }

    @Test
    fun `installed but refusing is blocked, and each refusal names its own fix`() {
        assertEquals(
            listOf(TermuxFix.AppPermissions, TermuxFix.EnableExternalApps, TermuxFix.OpenTermux),
            listOf(
                TermuxAvailability.PermissionDenied,
                TermuxAvailability.ExternalAppsDisabled,
                TermuxAvailability.Broken("bootstrap missing"),
            ).map {
                assertEquals(PrereqLevel.Blocked, it.asPrereq().level, "level for $it")
                it.asPrereq().fix
            },
        )
    }

    @Test
    fun `a workspace-less Termux is degraded, because commands still run`() {
        val ready = TermuxAvailability.Ready(workspaceReady = true).asPrereq()
        assertEquals(PrereqLevel.Ready, ready.level)
        assertEquals(TermuxFix.None, ready.fix)

        val noStorage = TermuxAvailability.Ready(workspaceReady = false).asPrereq()
        assertEquals(PrereqLevel.Degraded, noStorage.level)
        assertEquals(TermuxFix.SetUpStorage, noStorage.fix)
        // The distinction that matters: the Terminal surface stays open.
        assertTrue(TermuxAvailability.Ready(workspaceReady = false).canRun)
    }

    @Test
    fun `an unprobed prerequisite offers no fix`() {
        val prereq = TermuxAvailability.Unknown.asPrereq()

        assertEquals(PrereqLevel.Unknown, prereq.level)
        assertEquals(TermuxFix.None, prereq.fix)
    }
}
