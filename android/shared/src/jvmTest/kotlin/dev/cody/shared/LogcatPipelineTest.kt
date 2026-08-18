package dev.cody.shared

import dev.cody.shared.logs.LogLevel
import dev.cody.shared.logs.LogQuery
import dev.cody.shared.logs.LogRing
import dev.cody.shared.logs.LogcatParser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Parser and ring together, against a transcript in the exact shape a device
 * emits.
 *
 * This is as close to a device smoke test as this slice can get without
 * hardware: everything above it — the Shizuku grant, the `logcat` process, the
 * Compose surface — is either platform glue or pixels, but THIS is where a real
 * byte stream becomes the rows the screen renders. The sample below deliberately
 * contains every shape that has ever broken a logcat parser: a buffer
 * separator, a message full of colons, a multi-line stack trace, a repeat
 * storm, and logcat's own refusal text.
 */
class LogcatPipelineTest {

    private val transcript = """
        --------- beginning of main
        10-25 14:30:01.101  1234  1234 I ActivityManager: Start proc 5678:dev.cody.android/u0a231 for activity
        10-25 14:30:01.140  5678  5678 D CodyApp: onCreate
        10-25 14:30:01.221  5678  5701 V OkHttp: --> GET http://cody.example:30177/api/sessions
        10-25 14:30:01.402  5678  5701 W Choreographer: Skipped 31 frames!  The application may be doing too much work on its main thread.
        10-25 14:30:01.501  5678  5701 W Choreographer: Skipped 31 frames!  The application may be doing too much work on its main thread.
        10-25 14:30:01.604  5678  5701 W Choreographer: Skipped 31 frames!  The application may be doing too much work on its main thread.
        --------- beginning of crash
        10-25 14:30:02.010  5678  5678 E AndroidRuntime: FATAL EXCEPTION: main
        10-25 14:30:02.010  5678  5678 E AndroidRuntime: Process: dev.cody.android, PID: 5678
        10-25 14:30:02.010  5678  5678 E AndroidRuntime: java.lang.IllegalStateException: nope
        10-25 14:30:02.010  5678  5678 E AndroidRuntime: ${'\t'}at dev.cody.android.MainActivity.onCreate(MainActivity.kt:42)
        10-25 14:30:02.088  1234  1234 I ActivityManager: Process dev.cody.android (pid 5678) has died: fg  TOP
    """.trimIndent().lines()

    private fun drain(): LogRing {
        val parser = LogcatParser()
        val ring = LogRing()
        for (line in transcript) parser.parse(line)?.let(ring::record)
        return ring
    }

    @Test
    fun `a realistic transcript becomes the rows the screen renders`() {
        val snapshot = drain().snapshot()

        // 13 transcript lines, minus 2 separators, minus 2 deduped repeats.
        assertEquals(9, snapshot.held)
        assertEquals(11, snapshot.lines)
        assertEquals(0, snapshot.dropped)
        assertEquals(4, snapshot.errors, "the four AndroidRuntime lines")
        assertEquals(1, snapshot.warnings, "three Choreographer lines, one entry")
    }

    @Test
    fun `a repeat storm collapses to one row carrying its count`() {
        val skipped = drain().snapshot().entries.single { it.tag == "Choreographer" }

        assertEquals(3, skipped.count)
        assertEquals("10-25 14:30:01.402", skipped.firstSeen)
        assertEquals("10-25 14:30:01.604", skipped.lastSeen)
        assertTrue(skipped.message.startsWith("Skipped 31 frames!"), skipped.message)
    }

    @Test
    fun `the crash trace survives intact, frames and all`() {
        val crash = drain().snapshot(LogQuery(minLevel = LogLevel.Error)).entries

        assertEquals(4, crash.size)
        assertTrue(crash.all { it.tag == "AndroidRuntime" && it.pid == 5678 })
        assertEquals("FATAL EXCEPTION: main", crash.first().message)
        assertEquals(
            "\tat dev.cody.android.MainActivity.onCreate(MainActivity.kt:42)",
            crash.last().message,
        )
    }

    /**
     * The package filter is a substring over tag and message precisely because
     * of these two lines: the system logs Cody's package name inside the text of
     * an `ActivityManager` entry, never in a field. A filter that only looked at
     * tags would miss the two lines that say when the app started and why it
     * died.
     */
    @Test
    fun `filtering by package name finds the lines that only mention it in passing`() {
        val hits = drain().snapshot(LogQuery(filter = "dev.cody.android")).entries

        // Four, not six: the substring filter matches text, so the two crash
        // lines that never name the package ("FATAL EXCEPTION: main",
        // "java.lang.IllegalStateException: nope") are correctly excluded. That
        // is the honest cost of a text filter, and it is why the level chips
        // exist beside it — Error alone shows the whole trace.
        assertEquals(4, hits.size, hits.map { "${it.tag}: ${it.message}" }.toString())
        assertTrue(hits.any { it.tag == "ActivityManager" && it.message.startsWith("Start proc") })
        assertTrue(hits.any { it.tag == "ActivityManager" && it.message.contains("has died") })
    }

    @Test
    fun `filtering by pid keeps one process and drops the system`() {
        val hits = drain().snapshot(LogQuery(filter = "1234")).entries

        assertEquals(2, hits.size)
        assertTrue(hits.all { it.pid == 1234 && it.tag == "ActivityManager" })
    }

    /**
     * The failure this whole screen exists to make visible. logcat prints its
     * refusal to stderr, the reader folds stderr into the stream, and the parser
     * has no header to attach it to — so if this were dropped, "Cody cannot read
     * the log" would render as a blank, quiet-looking screen.
     */
    @Test
    fun `logcat's own refusal reaches the ring instead of vanishing`() {
        val parser = LogcatParser()
        val ring = LogRing()
        val refusal = "logcat read failure: Operation not permitted"
        parser.parse(refusal)?.let(ring::record)

        val entry = ring.snapshot().entries.single()
        assertEquals(refusal, entry.message)
        assertEquals("", entry.tag)
    }
}
