package dev.cody.shared

import dev.cody.shared.logs.LogLevel
import dev.cody.shared.logs.LogLine
import dev.cody.shared.logs.LogQuery
import dev.cody.shared.logs.LogRing
import dev.cody.shared.logs.MAX_MESSAGE_CHARS
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The bounding policy, which is the whole reason this type exists.
 *
 * A device log is an unbounded firehose pointed at a tablet's heap: a crash
 * loop emits the same line thousands of times a second and a busy system emits
 * thousands of distinct ones. Three bounds hold at once (dedupe, entry cap,
 * byte cap) and the eviction order is oldest-LAST-SEEN, so a line that is still
 * firing is never discarded as if it were history. None of that is visible in a
 * type signature and none of it fails loudly when it regresses — the app just
 * grows until it is killed. Hence these tests.
 */
class LogRingTest {

    private var clock = 0

    private fun line(
        level: LogLevel = LogLevel.Info,
        tag: String = "Tag",
        pid: Int = 100,
        tid: Int = 100,
        message: String = "hello",
    ): LogLine {
        clock += 1
        return LogLine(at = "10-25 14:30:%02d.000".format(clock % 60), pid = pid, tid = tid, level = level, tag = tag, message = message)
    }

    @Test
    fun `a repeat collapses into one entry with a count`() {
        val ring = LogRing()
        repeat(5) { ring.record(line(message = "render loop")) }

        val snapshot = ring.snapshot()
        assertEquals(1, snapshot.entries.size)
        assertEquals(5, snapshot.entries.single().count)
        assertEquals(1, snapshot.held)
        assertEquals(5, snapshot.lines)
        assertEquals(0, snapshot.dropped)
    }

    @Test
    fun `the same text from a different pid or level is a different entry`() {
        val ring = LogRing()
        ring.record(line(message = "boom", pid = 1))
        ring.record(line(message = "boom", pid = 2))
        ring.record(line(message = "boom", pid = 1, level = LogLevel.Error))
        ring.record(line(message = "boom", pid = 1, tag = "Other"))

        assertEquals(4, ring.snapshot().held)
    }

    /** A repeat updates the thread and the clock; the identity is unchanged. */
    @Test
    fun `a repeat refreshes lastSeen and tid but keeps firstSeen and id`() {
        val ring = LogRing()
        ring.record(line(message = "tick", tid = 7))
        val first = ring.snapshot().entries.single()
        ring.record(line(message = "tick", tid = 9))
        val second = ring.snapshot().entries.single()

        assertEquals(first.id, second.id)
        assertEquals(first.firstSeen, second.firstSeen)
        assertNotEquals(first.lastSeen, second.lastSeen)
        assertEquals(9, second.tid)
    }

    @Test
    fun `the entry cap evicts and counts the drop`() {
        val ring = LogRing(maxEntries = 10)
        repeat(25) { ring.record(line(message = "line $it")) }

        val snapshot = ring.snapshot()
        assertEquals(10, snapshot.held)
        assertEquals(15, snapshot.dropped)
        assertEquals(25, snapshot.lines)
        assertEquals("line 24", snapshot.entries.last().message)
        assertEquals("line 15", snapshot.entries.first().message)
    }

    /**
     * THE eviction rule. A line that keeps firing must outlive quieter lines
     * that were recorded after it — otherwise the crash loop the user opened
     * this screen to find is the first thing thrown away.
     */
    @Test
    fun `eviction is oldest-last-seen, so a still-firing line survives newer quiet ones`() {
        val ring = LogRing(maxEntries = 3)
        ring.record(line(message = "crash loop"))
        ring.record(line(message = "quiet a"))
        ring.record(line(message = "quiet b"))
        // Touch the oldest line, then overflow by one.
        ring.record(line(message = "crash loop"))
        ring.record(line(message = "newcomer"))

        val messages = ring.snapshot().entries.map { it.message }
        assertTrue("crash loop" in messages, messages.toString())
        assertTrue("quiet a" !in messages, "the stalest line should have gone: $messages")
        assertEquals(listOf("quiet b", "crash loop", "newcomer"), messages)
    }

    @Test
    fun `the byte cap evicts independently of the entry cap`() {
        val fat = "x".repeat(1_000)
        val ring = LogRing(maxEntries = 10_000, maxBytes = 4_000)
        repeat(20) { ring.record(line(message = "$it$fat")) }

        val snapshot = ring.snapshot()
        assertTrue(snapshot.bytes <= 4_000, "held ${snapshot.bytes} bytes")
        assertTrue(snapshot.held in 1..5, "held ${snapshot.held} entries")
        assertTrue(snapshot.dropped >= 15, "dropped ${snapshot.dropped}")
    }

    @Test
    fun `bytes are returned to the budget on eviction rather than leaking`() {
        val ring = LogRing(maxEntries = 5)
        repeat(50) { ring.record(line(message = "line $it")) }
        val steady = ring.snapshot().bytes
        repeat(50) { ring.record(line(message = "later $it")) }

        assertEquals(5, ring.snapshot().held)
        // Same shape of content, same order of magnitude: the counter tracks the
        // ring rather than the whole history.
        assertTrue(ring.snapshot().bytes in (steady / 2)..(steady * 2), "${ring.snapshot().bytes} vs $steady")
    }

    @Test
    fun `an over-long message is clipped so one entry can never approach the byte cap`() {
        val ring = LogRing()
        ring.record(line(message = "y".repeat(MAX_MESSAGE_CHARS * 4)))

        val entry = ring.snapshot().entries.single()
        assertEquals(MAX_MESSAGE_CHARS, entry.message.length)
        assertTrue(entry.message.endsWith("…"))
    }

    @Test
    fun `a blank message is not an entry`() {
        val ring = LogRing()
        ring.record(line(message = "   "))
        ring.record(line(message = ""))

        assertEquals(0, ring.snapshot().held)
    }

    @Test
    fun `the level filter is severity-inclusive`() {
        val ring = LogRing()
        for (level in LogLevel.entries) ring.record(line(level = level, message = level.name))

        val warnAndWorse = ring.snapshot(LogQuery(minLevel = LogLevel.Warn))
        assertEquals(
            setOf("Fatal", "Error", "Warn"),
            warnAndWorse.entries.map { it.message }.toSet(),
        )
        assertEquals(2, warnAndWorse.errors, "fatal counts as an error for the header chip")
        assertEquals(1, warnAndWorse.warnings)
        assertEquals(LogLevel.entries.size, warnAndWorse.held, "filtering must not evict")
    }

    @Test
    fun `an all-digit filter is an exact pid match, not a substring`() {
        val ring = LogRing()
        ring.record(line(pid = 42, message = "from 42"))
        ring.record(line(pid = 420, message = "from 420"))
        ring.record(line(pid = 7, message = "mentions 42 in the text"))

        val hits = ring.snapshot(LogQuery(filter = "42")).entries
        assertEquals(listOf("from 42"), hits.map { it.message })
    }

    @Test
    fun `a text filter matches tag or message, case-insensitively`() {
        val ring = LogRing()
        ring.record(line(tag = "ActivityManager", message = "Start proc dev.cody.android"))
        ring.record(line(tag = "dev.cody.android", message = "unrelated body"))
        ring.record(line(tag = "Other", message = "nothing to see"))

        val hits = ring.snapshot(LogQuery(filter = "DEV.CODY")).entries
        assertEquals(2, hits.size, hits.toString())
        assertEquals(3, ring.snapshot().matched, "the unfiltered view still sees everything")
    }

    @Test
    fun `the limit returns the newest matches, not the oldest`() {
        val ring = LogRing()
        repeat(100) { ring.record(line(message = "line $it")) }

        val snapshot = ring.snapshot(LogQuery(limit = 10))
        assertEquals(10, snapshot.entries.size)
        assertEquals(100, snapshot.matched, "matched reports the true total, before the limit")
        assertEquals("line 90", snapshot.entries.first().message)
        assertEquals("line 99", snapshot.entries.last().message)
    }

    @Test
    fun `the limit is applied after filtering, so a filter still fills the window`() {
        val ring = LogRing()
        repeat(100) {
            ring.record(line(level = if (it % 10 == 0) LogLevel.Error else LogLevel.Debug, message = "line $it"))
        }

        val errors = ring.snapshot(LogQuery(minLevel = LogLevel.Error, limit = 5))
        assertEquals(5, errors.entries.size)
        assertEquals(10, errors.matched)
        assertEquals("line 90", errors.entries.last().message)
    }

    @Test
    fun `a limit of zero or a silly limit is clamped instead of crashing`() {
        val ring = LogRing()
        repeat(3) { ring.record(line(message = "line $it")) }

        assertEquals(1, ring.snapshot(LogQuery(limit = 0)).entries.size)
        assertEquals(1, ring.snapshot(LogQuery(limit = -5)).entries.size)
        assertEquals(3, ring.snapshot(LogQuery(limit = Int.MAX_VALUE)).entries.size)
    }

    /**
     * Load-bearing for the frame budget: an unchanged row must come back as the
     * SAME object so Compose skips the item outright (docs/android-ux.md §6.3).
     * A fresh-but-equal copy per emission would recompose the whole visible
     * window ten times a second while the stream runs.
     */
    @Test
    fun `an unchanged row keeps its identity across snapshots`() {
        val ring = LogRing()
        ring.record(line(message = "stable"))
        val first = ring.snapshot().entries.single()

        ring.record(line(message = "something else"))
        val second = ring.snapshot().entries.first { it.message == "stable" }
        assertSame(first, second)

        ring.record(line(message = "stable"))
        val third = ring.snapshot().entries.first { it.message == "stable" }
        assertNotEquals(first.count, third.count, "a repeat must invalidate the cached row")
    }

    @Test
    fun `clear empties the ring and its counters but never reuses an id`() {
        val ring = LogRing()
        repeat(3) { ring.record(line(message = "line $it")) }
        val lastId = ring.snapshot().entries.last().id
        ring.clear()

        val empty = ring.snapshot()
        assertEquals(0, empty.held)
        assertEquals(0, empty.lines)
        assertEquals(0, empty.dropped)
        assertEquals(0, empty.bytes)
        assertTrue(empty.entries.isEmpty())

        ring.record(line(message = "after clear"))
        assertTrue(ring.snapshot().entries.single().id > lastId, "an id may not be recycled under a LazyColumn key")
    }

    @Test
    fun `an empty ring snapshots to zeroes rather than throwing`() {
        val snapshot = LogRing().snapshot(LogQuery(minLevel = LogLevel.Error, filter = "anything"))
        assertEquals(0, snapshot.held)
        assertEquals(0, snapshot.matched)
        assertTrue(snapshot.entries.isEmpty())
    }
}
