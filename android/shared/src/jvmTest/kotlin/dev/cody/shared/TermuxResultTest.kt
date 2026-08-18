package dev.cody.shared

import dev.cody.shared.termux.TermuxAvailability
import dev.cody.shared.termux.TermuxFailure
import dev.cody.shared.termux.TermuxOutcome
import dev.cody.shared.termux.TermuxProbe
import dev.cody.shared.termux.TermuxProtocol
import dev.cody.shared.termux.TermuxResultBundle
import dev.cody.shared.termux.TermuxResults
import dev.cody.shared.termux.TermuxSendFailure
import dev.cody.shared.termux.TermuxStream
import dev.cody.shared.termux.asAvailability
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Reading Termux's result bundle.
 *
 * Every case here is one of Termux's documented quirks, and every one of them
 * fails quietly if it is read naively: lengths that are strings read as zero,
 * a missing exit code reads as success, and an internal refusal reads as a
 * command that ran and printed nothing.
 */
class TermuxResultTest {

    private fun bundle(
        stdout: String? = null,
        stdoutOriginalLength: String? = null,
        stderr: String? = null,
        stderrOriginalLength: String? = null,
        exitCode: Int? = 0,
        err: Int? = TermuxProtocol.ERR_SUCCESS,
        errmsg: String? = null,
    ) = TermuxResultBundle(
        stdout = stdout,
        stdoutOriginalLength = stdoutOriginalLength,
        stderr = stderr,
        stderrOriginalLength = stderrOriginalLength,
        exitCode = exitCode,
        err = err,
        errmsg = errmsg,
    )

    @Test
    fun `stdout and stderr stay separate, which is the whole reason for the background runner`() {
        val outcome = assertIs<TermuxOutcome.Completed>(
            TermuxResults.interpret(
                bundle(stdout = "out\n", stdoutOriginalLength = "4", stderr = "err\n", stderrOriginalLength = "4"),
            ),
        )

        assertEquals("out\n", outcome.stdout.text)
        assertEquals("err\n", outcome.stderr.text)
    }

    @Test
    fun `a non-zero exit code is a command that failed, not an integration that failed`() {
        val outcome = assertIs<TermuxOutcome.Completed>(
            TermuxResults.interpret(bundle(stderr = "no such file", stderrOriginalLength = "12", exitCode = 2)),
        )
        assertEquals(2, outcome.exitCode)
    }

    @Test
    fun `exit code 127 survives as itself rather than collapsing into a generic error`() {
        assertEquals(127, assertIs<TermuxOutcome.Completed>(TermuxResults.interpret(bundle(exitCode = 127))).exitCode)
    }

    @Test
    fun `the original length arrives as a string and is parsed, not read as an int`() {
        // getInt on this key returns 0, which would report a 100 KB truncation
        // as "nothing dropped" on precisely the outputs that lost data.
        val stream = TermuxStream.of("tail of the output", "104857")

        assertTrue(stream.truncated)
        assertEquals(104857 - "tail of the output".length, stream.droppedChars)
    }

    @Test
    fun `truncation counts characters dropped off the FRONT, because Termux keeps the tail`() {
        val kept = "the last part"
        val stream = TermuxStream.of(kept, (kept.length + 5000).toString())

        assertEquals(5000, stream.droppedChars)
        assertEquals(kept, stream.text)
    }

    @Test
    fun `an absent or unparseable length reports no truncation rather than inventing one`() {
        assertFalse(TermuxStream.of("hello", null).truncated)
        assertFalse(TermuxStream.of("hello", "").truncated)
        assertFalse(TermuxStream.of("hello", "not a number").truncated)
        assertEquals(5, TermuxStream.of("hello", null).originalLength)
    }

    @Test
    fun `a length smaller than what arrived is clamped, never reported as negative loss`() {
        val stream = TermuxStream.of("twelve chars", "3")
        assertFalse(stream.truncated)
        assertEquals(0, stream.droppedChars)
    }

    @Test
    fun `a null stream is empty rather than the string null`() {
        assertEquals("", TermuxStream.of(null, null).text)
        assertTrue(TermuxStream.of(null, null).isEmpty)
    }

    @Test
    fun `err set to anything but RESULT_OK is Termux failing, not the command`() {
        // ERRNO_FAILED is RESULT_FIRST_USER + 1.
        val outcome = assertIs<TermuxOutcome.Failed>(
            TermuxResults.interpret(bundle(exitCode = null, err = 2, errmsg = "Executable not found")),
        )
        assertEquals(TermuxFailure.Internal, outcome.failure)
        assertEquals("Executable not found", outcome.detail)
    }

    @Test
    fun `ERRNO_CANCELLED is zero and must not be mistaken for success`() {
        // Activity.RESULT_CANCELED == 0. Only -1 means "no internal error".
        assertIs<TermuxOutcome.Failed>(TermuxResults.interpret(bundle(err = 0, errmsg = "Execution cancelled")))
    }

    @Test
    fun `the allow-external-apps refusal is recognised from Termux's own wording`() {
        // Termux's error_allow_external_apps_ungranted string, verbatim shape.
        val errmsg = "RunCommandService requires `allow-external-apps` property to be set to " +
            "`true` in `~/.termux/termux.properties` file."
        val outcome = assertIs<TermuxOutcome.Failed>(
            TermuxResults.interpret(bundle(exitCode = null, err = 2, errmsg = errmsg)),
        )

        assertEquals(TermuxFailure.ExternalAppsDisabled, outcome.failure)
    }

    @Test
    fun `partial output survives a Termux failure`() {
        val outcome = assertIs<TermuxOutcome.Failed>(
            TermuxResults.interpret(
                bundle(stdout = "made it this far", stdoutOriginalLength = "16", exitCode = null, err = 2, errmsg = "killed"),
            ),
        )
        assertEquals("made it this far", outcome.stdout.text)
    }

    @Test
    fun `success with no exit code is never reported as exit zero`() {
        // Termux says it is fine but never ran anything. Claiming exit 0 here
        // would show a green successful command that did not happen.
        assertIs<TermuxOutcome.Failed>(TermuxResults.interpret(bundle(exitCode = null)))
    }

    @Test
    fun `a blank errmsg does not become a blank detail line in the UI`() {
        assertEquals(null, assertIs<TermuxOutcome.Failed>(TermuxResults.interpret(bundle(err = 1, errmsg = "  "))).detail)
    }

    @Test
    fun `the probe's markers decide whether the workspace exists`() {
        val ready = TermuxOutcome.Completed(
            exitCode = 0,
            stdout = TermuxStream.of(TermuxProbe.WORKSPACE_OK + "\n", null),
            stderr = TermuxStream.Empty,
        ).asAvailability()
        assertEquals(TermuxAvailability.Ready(workspaceReady = true), ready)

        val noWorkspace = TermuxOutcome.Completed(
            exitCode = 0,
            stdout = TermuxStream.of(TermuxProbe.WORKSPACE_UNAVAILABLE + "\n", null),
            stderr = TermuxStream.Empty,
        ).asAvailability()
        assertEquals(TermuxAvailability.Ready(workspaceReady = false), noWorkspace)
    }

    @Test
    fun `each way of being unavailable maps to its own state, because each has its own fix`() {
        assertEquals(
            TermuxAvailability.NotInstalled,
            TermuxOutcome.NotSent(TermuxSendFailure.NotInstalled).asAvailability(),
        )
        assertEquals(
            TermuxAvailability.PermissionDenied,
            TermuxOutcome.NotSent(TermuxSendFailure.PermissionDenied).asAvailability(),
        )
        assertEquals(
            TermuxAvailability.ExternalAppsDisabled,
            TermuxOutcome.Failed(TermuxFailure.ExternalAppsDisabled, "…allow-external-apps…").asAvailability(),
        )
        assertIs<TermuxAvailability.Broken>(TermuxOutcome.TimedOut.asAvailability())
    }

    @Test
    fun `only Ready can run`() {
        assertTrue(TermuxAvailability.Ready(workspaceReady = false).canRun)
        assertFalse(TermuxAvailability.Unknown.canRun)
        assertFalse(TermuxAvailability.NotInstalled.canRun)
        assertFalse(TermuxAvailability.PermissionDenied.canRun)
        assertFalse(TermuxAvailability.ExternalAppsDisabled.canRun)
        assertFalse(TermuxAvailability.Broken(null).canRun)
    }
}
