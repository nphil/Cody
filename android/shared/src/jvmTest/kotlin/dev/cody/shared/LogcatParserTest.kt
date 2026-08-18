package dev.cody.shared

import dev.cody.shared.logs.LogLevel
import dev.cody.shared.logs.LogcatParser
import dev.cody.shared.logs.logcatCommand
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The parser is the one part of the Shizuku slice that can be proven without a
 * device: it turns bytes a real tablet produces into the model the UI renders.
 * Every sample below is written in the exact column layout
 * `logcat -v threadtime` emits, so a regression shows up here rather than as an
 * empty Logs screen on hardware nobody can attach a debugger to.
 */
class LogcatParserTest {

    private val parser = LogcatParser()

    @Test
    fun `a threadtime line yields every field`() {
        val line = parser.parse("10-25 14:30:01.123  1234  1256 I ActivityManager: Start proc")
        checkNotNull(line)
        assertEquals("10-25 14:30:01.123", line.at)
        assertEquals(1234, line.pid)
        assertEquals(1256, line.tid)
        assertEquals(LogLevel.Info, line.level)
        assertEquals("ActivityManager", line.tag)
        assertEquals("Start proc", line.message)
    }

    /**
     * The single most likely way to get the tag/message split wrong: a greedy
     * capture would take "ActivityManager: Start proc 5678" as the tag.
     */
    @Test
    fun `a colon inside the message does not move the tag boundary`() {
        val line = parser.parse(
            "10-25 14:30:01.123  1234  1256 I ActivityManager: Start proc 5678:dev.cody.android/u0a123",
        )
        checkNotNull(line)
        assertEquals("ActivityManager", line.tag)
        assertEquals("Start proc 5678:dev.cody.android/u0a123", line.message)
    }

    @Test
    fun `the -v year prefix is kept in the clock text and does not break the split`() {
        val line = parser.parse("2026-10-25 14:30:01.123  1234  1256 W dalvikvm: GC_CONCURRENT")
        checkNotNull(line)
        assertEquals("2026-10-25 14:30:01.123", line.at)
        assertEquals(LogLevel.Warn, line.level)
        assertEquals("dalvikvm", line.tag)
    }

    @Test
    fun `every priority letter maps, and the assert spelling maps to fatal`() {
        val expected = mapOf(
            'V' to LogLevel.Verbose,
            'D' to LogLevel.Debug,
            'I' to LogLevel.Info,
            'W' to LogLevel.Warn,
            'E' to LogLevel.Error,
            'F' to LogLevel.Fatal,
            'A' to LogLevel.Fatal,
        )
        for ((letter, level) in expected) {
            val line = parser.parse("10-25 14:30:01.123  1  2 $letter Tag: body")
            assertEquals(level, checkNotNull(line).level, "priority $letter")
        }
    }

    @Test
    fun `an empty message parses rather than falling through to the carry path`() {
        val line = parser.parse("10-25 14:30:01.123  1234  1256 D Tag:")
        checkNotNull(line)
        assertEquals("Tag", line.tag)
        assertEquals("", line.message)
    }

    @Test
    fun `buffer separators and blank lines carry nothing`() {
        assertNull(parser.parse("--------- beginning of main"))
        assertNull(parser.parse("--------- switch to system"))
        assertNull(parser.parse(""))
        assertNull(parser.parse("   "))
    }

    /**
     * threadtime normally repeats the header on every line of a stack trace, so
     * this path is a safety net for a vendor logcat that does not. What must
     * hold either way: the trace body keeps the level, tag and pid of its first
     * line, so a filter that shows the exception also shows its frames.
     */
    @Test
    fun `a bare continuation inherits the previous header`() {
        parser.parse("10-25 14:30:01.123  1234  1256 E AndroidRuntime: FATAL EXCEPTION: main")
        val frame = parser.parse("\tat dev.cody.android.MainActivity.onCreate(MainActivity.kt:42)")
        checkNotNull(frame)
        assertEquals(LogLevel.Error, frame.level)
        assertEquals("AndroidRuntime", frame.tag)
        assertEquals(1234, frame.pid)
        assertEquals("\tat dev.cody.android.MainActivity.onCreate(MainActivity.kt:42)", frame.message)
    }

    @Test
    fun `a separator ends the carry so the next buffer does not inherit a tag`() {
        parser.parse("10-25 14:30:01.123  1234  1256 E AndroidRuntime: FATAL EXCEPTION: main")
        parser.parse("--------- beginning of crash")
        val orphan = parser.parse("something unparseable")
        checkNotNull(orphan)
        assertEquals("", orphan.tag)
        assertEquals(LogLevel.Info, orphan.level)
    }

    /**
     * logcat's own refusals arrive as unparseable text before any entry. If
     * those were dropped, "logcat could not open the log device" would render
     * as an empty screen, which is the single worst outcome for this feature.
     */
    @Test
    fun `unparseable output before any header is surfaced, not swallowed`() {
        val line = parser.parse("Unable to open log device '/dev/log/main': Permission denied")
        checkNotNull(line)
        assertEquals("", line.tag)
        assertEquals(0, line.pid)
        assertEquals(
            "Unable to open log device '/dev/log/main': Permission denied",
            line.message,
        )
    }

    @Test
    fun `reset drops the carried header`() {
        parser.parse("10-25 14:30:01.123  1234  1256 E AndroidRuntime: boom")
        parser.reset()
        val orphan = checkNotNull(parser.parse("stray"))
        assertEquals("", orphan.tag)
    }

    /**
     * `-t` implies dump-and-exit, so using it here would silently turn a live
     * tail into a single snapshot — a bug that looks like "the stream stopped".
     */
    @Test
    fun `the reader command follows the tail instead of dumping and exiting`() {
        val argv = logcatCommand(tailLines = 400)
        assertEquals("logcat", argv.first())
        assertTrue(argv.containsAll(listOf("-v", "threadtime")), argv.toString())
        assertTrue(argv.containsAll(listOf("-b", "main,system,crash")), argv.toString())
        assertEquals("400", argv[argv.indexOf("-T") + 1])
        assertTrue("-t" !in argv, "-t implies -d and would end the stream: $argv")
        assertTrue("-d" !in argv, "-d dumps and exits: $argv")
    }

    @Test
    fun `an absurd tail request is clamped rather than passed through`() {
        assertEquals("10000", logcatCommand(tailLines = 10_000_000).let { it[it.indexOf("-T") + 1] })
        assertEquals("1", logcatCommand(tailLines = 0).let { it[it.indexOf("-T") + 1] })
    }
}
