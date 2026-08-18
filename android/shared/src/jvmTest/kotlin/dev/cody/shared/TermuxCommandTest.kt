package dev.cody.shared

import dev.cody.shared.termux.TermuxCommandPlan
import dev.cody.shared.termux.TermuxCommands
import dev.cody.shared.termux.TermuxLimits
import dev.cody.shared.termux.TermuxProbe
import dev.cody.shared.termux.TermuxProtocol
import dev.cody.shared.termux.TermuxRejection
import dev.cody.shared.termux.TermuxRequest
import dev.cody.shared.termux.TermuxWorkspace
import dev.cody.shared.termux.utf8Size
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * What Cody actually hands Termux.
 *
 * None of this can be checked on a device from here, and all of it fails
 * silently in the field: a wrong argv shape runs a different command, an
 * over-long command line is dropped by the OS with no callback, and a working
 * directory that does not exist fails the execution for a reason the user
 * cannot see. So it is asserted on the JVM instead.
 */
class TermuxCommandTest {

    private val workspace = TermuxWorkspace.resolve("/storage/emulated/0")

    private fun runnable(line: String, cwd: String = workspace) =
        assertIs<TermuxCommandPlan.Runnable>(TermuxCommands.shell(line, cwd)).request

    @Test
    fun `a typed line is passed to a login shell as one whole argument`() {
        val request = runnable("ls -la | grep '.kt' && echo \"done\"")

        assertEquals(TermuxProtocol.BASH, request.executable)
        // -l so the user's own Termux profile and PATH apply; -c so the line is
        // interpreted rather than treated as a program name.
        assertEquals(listOf("-lc", "ls -la | grep '.kt' && echo \"done\""), request.arguments)
        assertEquals(workspace, request.workingDirectory)
        assertTrue(request.background, "must be app-shell: it is the only runner that separates stdout and stderr")
    }

    @Test
    fun `surrounding whitespace is trimmed but the command is otherwise untouched`() {
        assertEquals(listOf("-lc", "echo  two   spaces"), runnable("  echo  two   spaces \n").arguments)
    }

    @Test
    fun `a multi-line script stays one argument and only its first line reaches the label`() {
        val script = "cd src\nfor f in *.kt; do wc -l \"\$f\"; done"
        val request = runnable(script)

        assertEquals(2, request.arguments.size)
        assertEquals(script, request.arguments[1])
        assertEquals("Cody: cd src", request.label)
    }

    @Test
    fun `a long command line is clipped in the label, which Termux shows in its own popups`() {
        val line = "echo " + "x".repeat(200)
        val label = runnable(line).label

        assertTrue(label.startsWith("Cody: echo xxx"), label)
        assertTrue(label.length < 60, "label was $label")
        assertTrue(label.endsWith("…"))
    }

    @Test
    fun `blank input never becomes an intent`() {
        val plan = TermuxCommands.shell("   \n\t ", workspace)
        assertEquals(TermuxRejection.Empty, assertIs<TermuxCommandPlan.Rejected>(plan).rejection)
    }

    @Test
    fun `a command line past the argv ceiling is refused, carrying the ceiling it broke`() {
        // ~128 KB is the real limit on the command line itself. Past it the
        // execution does not fail loudly; it does not happen.
        val huge = "echo " + "a".repeat(TermuxLimits.ARGUMENTS_BYTES)
        val rejection = assertIs<TermuxCommandPlan.Rejected>(TermuxCommands.shell(huge, workspace)).rejection
        val tooLarge = assertIs<TermuxRejection.TooLarge>(rejection)

        assertEquals(TermuxLimits.ARGUMENTS_BYTES, tooLarge.limit)
        assertTrue(tooLarge.bytes > tooLarge.limit)
    }

    @Test
    fun `a command line just under the ceiling is still sent`() {
        val line = "e".repeat(TermuxLimits.ARGUMENTS_BYTES - "-lc".utf8Size() - 1)
        assertIs<TermuxCommandPlan.Runnable>(TermuxCommands.shell(line, workspace))
    }

    @Test
    fun `the ceilings are measured in UTF-8 bytes, not characters`() {
        // 3 bytes each: a limit checked in characters would let three times as
        // much through as the transaction can carry.
        val request = runnable("echo 日本語")
        assertEquals("-lc".utf8Size() + "echo 日本語".utf8Size(), request.argumentBytes)
        assertEquals(3 + 5 + 9, request.argumentBytes)
    }

    @Test
    fun `an emoji outside the BMP counts as four bytes`() {
        assertEquals(4, "\uD83D\uDE80".utf8Size())
    }

    @Test
    fun `payload size covers every string extra, not just argv`() {
        val request = runnable("id")
        assertEquals(
            request.argumentBytes + TermuxProtocol.BASH.utf8Size() +
                workspace.utf8Size() + request.label.utf8Size(),
            request.payloadBytes,
        )
        assertTrue(request.payloadBytes < TermuxLimits.INTENT_EXTRAS_BYTES)
    }

    @Test
    fun `the probe does not run in the directory it is trying to create`() {
        val probe = TermuxCommands.probe(workspace)

        // Termux validates the working directory before running anything, so
        // probing with a workspace that does not exist yet would fail for
        // exactly the reason the probe exists to detect and fix.
        assertEquals(TermuxProtocol.HOME_DIR, probe.workingDirectory)
        assertTrue(probe.arguments.last() == workspace)
    }

    @Test
    fun `the probe reports the workspace through markers rather than an exit code`() {
        val script = TermuxCommands.probe(workspace).arguments[1]

        assertTrue(script.contains(TermuxProbe.WORKSPACE_OK))
        assertTrue(script.contains(TermuxProbe.WORKSPACE_UNAVAILABLE))
        // The markers must be distinguishable by substring search: if one
        // contained the other, "unavailable" would read as "ok".
        assertTrue(!TermuxProbe.WORKSPACE_UNAVAILABLE.contains(TermuxProbe.WORKSPACE_OK))
    }

    /**
     * The probe is the only shell script this app ships, and everything the
     * setup screen says depends on it branching correctly. A real bash on the
     * build host is not Termux's bash, but it is the same argv and the same
     * `$1` expansion, which is the part that can be wrong.
     */
    @Test
    fun `the probe script creates the workspace and prints the ok marker`() {
        val bash = hostBash() ?: return
        val root = Files.createTempDirectory("cody-probe").toFile()
        val target = File(root, "Documents/Cody")

        val run = runProbe(bash, TermuxCommands.probe(target.absolutePath))

        assertTrue(target.isDirectory, "the probe must create the workspace, not just report on it")
        assertTrue(run.output.contains(TermuxProbe.WORKSPACE_OK), run.output)
        assertEquals(0, run.exitCode)
    }

    @Test
    fun `the probe prints the unavailable marker and STILL exits zero when mkdir fails`() {
        val bash = hostBash() ?: return
        // A path under a regular file: mkdir -p cannot succeed, the same shape
        // of failure as shared storage that Termux has no permission for.
        val blocked = File(Files.createTempFile("cody-not-a-dir", "").toFile(), "Documents/Cody")

        val run = runProbe(bash, TermuxCommands.probe(blocked.absolutePath))

        assertTrue(run.output.contains(TermuxProbe.WORKSPACE_UNAVAILABLE), run.output)
        // Zero on purpose: the probe answers "can Cody drive the shell at all",
        // and a non-zero exit would blur that into "did mkdir work".
        assertEquals(0, run.exitCode)
    }

    private class Run(val exitCode: Int, val output: String)

    private fun hostBash(): String? =
        listOf("/bin/bash", "/usr/bin/bash").firstOrNull { File(it).canExecute() }

    private fun runProbe(bash: String, request: TermuxRequest): Run {
        val process = ProcessBuilder(listOf(bash) + request.arguments)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText()
        return Run(process.waitFor(), output)
    }

    @Test
    fun `the workspace resolves under the device's own shared storage root`() {
        assertEquals("/storage/emulated/0/Documents/Cody", TermuxWorkspace.resolve("/storage/emulated/0"))
        // A work profile is not user 0; a hard-coded path would point at
        // another user's files.
        assertEquals("/storage/emulated/10/Documents/Cody", TermuxWorkspace.resolve("/storage/emulated/10/"))
    }
}
