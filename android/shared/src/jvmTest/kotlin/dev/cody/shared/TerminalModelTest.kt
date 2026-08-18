package dev.cody.shared

import dev.cody.shared.presentation.TerminalModel
import dev.cody.shared.presentation.TermuxRunner
import dev.cody.shared.termux.TermuxAvailability
import dev.cody.shared.termux.TermuxFailure
import dev.cody.shared.termux.TermuxOutcome
import dev.cody.shared.termux.TermuxProbe
import dev.cody.shared.termux.TermuxProtocol
import dev.cody.shared.termux.TermuxRejection
import dev.cody.shared.termux.TermuxRequest
import dev.cody.shared.termux.TermuxSendFailure
import dev.cody.shared.termux.TermuxStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The command runner's state machine: the three failure states, the
 * single-in-flight rule, and the working-directory decision.
 */
class TerminalModelTest {

    private val workspacePath = "/storage/emulated/0/Documents/Cody"

    private class FakeRunner(override val workspace: String) : TermuxRunner {
        var local: TermuxAvailability? = null
        val requests: MutableList<TermuxRequest> = mutableListOf()
        var respond: suspend (TermuxRequest) -> TermuxOutcome = { ok() }

        override fun inspect(): TermuxAvailability? = local

        override suspend fun run(request: TermuxRequest): TermuxOutcome {
            requests += request
            return respond(request)
        }
    }

    /**
     * Same scope discipline as the chat tests: an `UnconfinedTestDispatcher`
     * scope rather than `backgroundScope`, because `backgroundScope.launch { }`
     * plus `advanceUntilIdle()` does not run the coroutine on this coroutines
     * version and every assertion would pass against a model that did nothing.
     */
    private fun terminalTest(body: suspend TestScope.(FakeRunner, TerminalModel) -> Unit) = runTest {
        val runner = FakeRunner(workspacePath)
        val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
        val model = TerminalModel(runner, scope)
        try {
            body(runner, model)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `an uninstalled Termux is reported without ever sending an intent`() = terminalTest { runner, model ->
        runner.local = TermuxAvailability.NotInstalled

        model.refresh()
        advanceUntilIdle()

        assertEquals(TermuxAvailability.NotInstalled, model.state.value.availability)
        assertTrue(runner.requests.isEmpty(), "nothing to send an intent to")
    }

    @Test
    fun `an ungranted permission is reported without ever sending an intent`() = terminalTest { runner, model ->
        runner.local = TermuxAvailability.PermissionDenied

        model.refresh()
        advanceUntilIdle()

        assertEquals(TermuxAvailability.PermissionDenied, model.state.value.availability)
        assertTrue(runner.requests.isEmpty())
    }

    @Test
    fun `installed and granted but allow-external-apps unset is its own state`() = terminalTest { runner, model ->
        // The trap: both local checks pass, and Termux still refuses. Only the
        // probe can find this out.
        runner.local = null
        runner.respond = {
            TermuxOutcome.Failed(
                TermuxFailure.ExternalAppsDisabled,
                "requires `allow-external-apps` property to be set to `true`",
            )
        }

        model.refresh()
        advanceUntilIdle()

        assertEquals(TermuxAvailability.ExternalAppsDisabled, model.state.value.availability)
        assertEquals(1, runner.requests.size)
    }

    @Test
    fun `a probe that never answers does not leave the screen checking forever`() = terminalTest { runner, model ->
        runner.respond = { awaitCancellation() }

        model.refresh()
        advanceTimeBy(TerminalModel.PROBE_TIMEOUT_MS + 1)
        advanceUntilIdle()

        assertIs<TermuxAvailability.Broken>(model.state.value.availability)
        assertTrue(!model.state.value.checking)
    }

    @Test
    fun `a good probe reports ready, and whether the workspace exists`() = terminalTest { runner, model ->
        runner.respond = { ok(TermuxProbe.WORKSPACE_OK) }

        model.refresh()
        advanceUntilIdle()

        assertEquals(TermuxAvailability.Ready(workspaceReady = true), model.state.value.availability)
    }

    @Test
    fun `Termux without shared storage is still usable, just without the workspace`() =
        terminalTest { runner, model ->
            runner.respond = { ok(TermuxProbe.WORKSPACE_UNAVAILABLE) }

            model.refresh()
            advanceUntilIdle()

            assertEquals(TermuxAvailability.Ready(workspaceReady = false), model.state.value.availability)
            assertTrue(model.state.value.availability.canRun)
        }

    @Test
    fun `commands run in the workspace once it exists`() = terminalTest { runner, model ->
        runner.respond = { ok(TermuxProbe.WORKSPACE_OK) }
        model.refresh()
        advanceUntilIdle()

        runner.respond = { ok("total 0") }
        model.run("ls")
        advanceUntilIdle()

        assertEquals(workspacePath, runner.requests.last().workingDirectory)
        assertEquals(workspacePath, model.state.value.entries.single().workingDirectory)
    }

    @Test
    fun `commands fall back to Termux HOME when the workspace could not be created`() =
        terminalTest { runner, model ->
            // Termux validates the working directory before running anything, so
            // pointing at a workspace that does not exist would fail every
            // command with the same opaque error.
            runner.respond = { ok(TermuxProbe.WORKSPACE_UNAVAILABLE) }
            model.refresh()
            advanceUntilIdle()

            model.run("pwd")
            advanceUntilIdle()

            assertEquals(TermuxProtocol.HOME_DIR, runner.requests.last().workingDirectory)
        }

    @Test
    fun `a command is ignored while another is in flight`() = terminalTest { runner, model ->
        makeReady(runner, model)
        runner.respond = { awaitCancellation() }

        model.run("sleep 30")
        model.run("echo second")
        // runCurrent, NOT advanceUntilIdle: the latter would run virtual time
        // forward past the five-minute command timeout and settle the very
        // command this test needs to still be in flight.
        runCurrent()

        assertEquals(1, model.state.value.entries.size)
        assertTrue(model.state.value.busy)
        assertTrue(model.state.value.entries.single().running)
    }

    @Test
    fun `nothing runs at all until Termux is available`() = terminalTest { runner, model ->
        runner.local = TermuxAvailability.ExternalAppsDisabled
        model.refresh()
        advanceUntilIdle()
        val probes = runner.requests.size

        model.run("echo hi")
        advanceUntilIdle()

        assertTrue(model.state.value.entries.isEmpty())
        assertEquals(probes, runner.requests.size)
    }

    @Test
    fun `a command with no answer times out without claiming the command failed`() =
        terminalTest { runner, model ->
            makeReady(runner, model)
            runner.respond = { awaitCancellation() }

            model.run("sleep 600")
            advanceTimeBy(TerminalModel.COMMAND_TIMEOUT_MS + 1)
            advanceUntilIdle()

            // TimedOut, not Failed: RUN_COMMAND cannot cancel anything, so the
            // command may well still be running over in Termux.
            assertEquals(TermuxOutcome.TimedOut, model.state.value.entries.single().outcome)
            assertTrue(!model.state.value.busy)
        }

    @Test
    fun `an oversized command becomes a visible refusal, not a silent no-op`() =
        terminalTest { runner, model ->
            makeReady(runner, model)
            val before = runner.requests.size

            model.run("echo " + "a".repeat(200_000))
            advanceUntilIdle()

            val outcome = assertIs<TermuxOutcome.NotSent>(model.state.value.entries.single().outcome)
            assertIs<TermuxRejection.TooLarge>(assertIs<TermuxSendFailure.Rejected>(outcome.reason).rejection)
            assertEquals(before, runner.requests.size, "an oversized intent must never be handed over")
        }

    @Test
    fun `an empty submit leaves no trace`() = terminalTest { runner, model ->
        makeReady(runner, model)

        model.run("   ")
        advanceUntilIdle()

        assertTrue(model.state.value.entries.isEmpty())
    }

    @Test
    fun `a permission revoked since the last probe downgrades availability on the spot`() =
        terminalTest { runner, model ->
            makeReady(runner, model)
            runner.respond = { TermuxOutcome.NotSent(TermuxSendFailure.PermissionDenied) }

            model.run("id")
            advanceUntilIdle()

            assertEquals(TermuxAvailability.PermissionDenied, model.state.value.availability)
        }

    @Test
    fun `allow-external-apps turned off mid-session downgrades availability too`() =
        terminalTest { runner, model ->
            makeReady(runner, model)
            runner.respond = { TermuxOutcome.Failed(TermuxFailure.ExternalAppsDisabled, "allow-external-apps") }

            model.run("id")
            advanceUntilIdle()

            assertEquals(TermuxAvailability.ExternalAppsDisabled, model.state.value.availability)
        }

    @Test
    fun `an ordinary non-zero exit does not downgrade availability`() = terminalTest { runner, model ->
        makeReady(runner, model)
        runner.respond = { TermuxOutcome.Completed(1, TermuxStream.Empty, TermuxStream.of("nope", null)) }

        model.run("false")
        advanceUntilIdle()

        assertEquals(TermuxAvailability.Ready(workspaceReady = true), model.state.value.availability)
    }

    @Test
    fun `rows get distinct keys even when the same command is run twice`() = terminalTest { runner, model ->
        makeReady(runner, model)

        model.run("ls")
        advanceUntilIdle()
        model.run("ls")
        advanceUntilIdle()

        val keys = model.state.value.entries.map { it.key }
        assertEquals(2, keys.size)
        assertEquals(keys.toSet().size, keys.size)
    }

    @Test
    fun `rerun re-plans rather than replays, so it picks up a workspace that now exists`() =
        terminalTest { runner, model ->
            runner.respond = { ok(TermuxProbe.WORKSPACE_UNAVAILABLE) }
            model.refresh()
            advanceUntilIdle()
            runner.respond = { ok() }
            model.run("pwd")
            advanceUntilIdle()
            assertEquals(TermuxProtocol.HOME_DIR, runner.requests.last().workingDirectory)

            runner.respond = { ok(TermuxProbe.WORKSPACE_OK) }
            model.refresh()
            advanceUntilIdle()
            runner.respond = { ok() }
            model.rerun(model.state.value.entries.first().key)
            advanceUntilIdle()

            assertEquals(workspacePath, runner.requests.last().workingDirectory)
        }

    @Test
    fun `scrollback is capped so 100 KB of output per row cannot grow without bound`() =
        terminalTest { runner, model ->
            makeReady(runner, model)

            repeat(TerminalModel.MAX_SCROLLBACK + 5) {
                model.run("echo $it")
                advanceUntilIdle()
            }

            val entries = model.state.value.entries
            assertEquals(TerminalModel.MAX_SCROLLBACK, entries.size)
            assertEquals("echo 5", entries.first().commandLine, "the OLDEST rows are the ones dropped")
        }

    @Test
    fun `clear empties the scrollback and nothing else`() = terminalTest { runner, model ->
        makeReady(runner, model)
        model.run("ls")
        advanceUntilIdle()

        model.clear()

        assertTrue(model.state.value.entries.isEmpty())
        assertEquals(TermuxAvailability.Ready(workspaceReady = true), model.state.value.availability)
    }

    @Test
    fun `the state exposes the workspace path the screen has to show the user`() =
        terminalTest { _, model ->
            assertEquals(workspacePath, model.state.value.workspace)
            assertNull(model.state.value.entries.firstOrNull())
        }

    private fun TestScope.makeReady(runner: FakeRunner, model: TerminalModel) {
        runner.respond = { ok(TermuxProbe.WORKSPACE_OK) }
        model.refresh()
        advanceUntilIdle()
        runner.requests.clear()
        runner.respond = { ok() }
    }
}

/** A command that ran and succeeded, printing [stdout]. */
private fun ok(stdout: String = ""): TermuxOutcome = TermuxOutcome.Completed(
    exitCode = 0,
    stdout = TermuxStream.of(stdout, null),
    stderr = TermuxStream.Empty,
)
