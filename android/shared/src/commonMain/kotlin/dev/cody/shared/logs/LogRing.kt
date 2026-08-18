package dev.cody.shared.logs

/**
 * Bounded, deduped ring for device log lines — the Android side of
 * `lib/logs/ring.ts`, deliberately the same policy rather than a second one.
 *
 * The design risk is identical to the server's and so is the answer. A crashing
 * app emits thousands of IDENTICAL lines a second and a chatty system emits
 * thousands of distinct ones, so three independent bounds hold at once:
 *
 *   - dedupe, which turns a crash loop into ONE entry with a count;
 *   - [MAX_ENTRIES], which bounds distinct lines;
 *   - [MAX_BYTES], which bounds their total size, because 2000 stack frames are
 *     not the same weight as 2000 "onResume".
 *
 * Eviction is oldest-LAST-SEEN first, not oldest-first: a line that is still
 * firing must not be discarded as if it were history. A `LinkedHashMap` gives
 * that for free — a repeat is removed and re-inserted, so iteration order is
 * ascending `lastSeen` and the victim is always the first entry.
 *
 * The one deviation from the server, and why: the server's caps (300 entries /
 * 128 KiB) are sized for a model's context window, which is the scarce resource
 * there. Here the consumer is a scrolling list on a tablet, and
 * `docs/android-ux.md` §5.2 names ~2000 lines as the target depth, so the caps
 * are raised to match that and the byte cap raised with them.
 *
 * NOT thread-safe, on purpose. The caller owns the confinement: one coroutine
 * feeds it and snapshots it, so there is no lock on the per-line hot path.
 */

/** Distinct entries held. `docs/android-ux.md` §5.2: "last ~2000 lines". */
public const val MAX_ENTRIES: Int = 2_000

/**
 * Tag+message bytes held. Also the reason eviction always terminates: one entry
 * (message + tag, worst case 4 bytes per char) cannot approach this on its own,
 * so the ring can never empty itself trying to satisfy the cap.
 */
public const val MAX_BYTES: Int = 512 * 1024

/** Per-entry message ceiling. A single log line longer than this is a dump. */
public const val MAX_MESSAGE_CHARS: Int = 1_200

/** Per-entry tag ceiling. Real tags are far shorter; this catches a rogue one. */
public const val MAX_TAG_CHARS: Int = 64

/** Entries returned by one [LogRing.snapshot] when the query does not say. */
public const val DEFAULT_LIMIT: Int = 500

/** Ceiling on one snapshot, whatever the query asks for. */
public const val MAX_LIMIT: Int = MAX_ENTRIES

/**
 * One distinct log line and how many times it has been seen.
 *
 * Construct-only, and the ring hands out fresh instances rather than mutating
 * these — the obligation that rides with declaring `dev.cody.shared.logs.*`
 * stable in `app/compose-stability.conf` (docs/android-ux.md §6.3).
 */
public data class LogEntry(
    /** Stable across repeats and across snapshots: the `LazyColumn` item key. */
    public val id: Long,
    public val level: LogLevel,
    public val tag: String,
    public val pid: Int,
    /** The thread of the most recent occurrence. */
    public val tid: Int,
    public val message: String,
    public val firstSeen: String,
    public val lastSeen: String,
    /** 1 for a line seen once; higher collapses a repeat storm into one row. */
    public val count: Int,
)

/** What to show. Applied over everything held, never at capture time. */
public data class LogQuery(
    /** Keeps entries at least this severe. [LogLevel.Verbose] keeps everything. */
    public val minLevel: LogLevel = LogLevel.Verbose,
    /**
     * All digits: an exact pid match. Anything else: a case-insensitive
     * substring of the tag or the message, which is how a package name is
     * matched — the system logs it inside the text (`Start proc
     * 5678:dev.cody.android/u0a123`) rather than in a field of its own.
     * Blank matches everything.
     */
    public val filter: String = "",
    public val limit: Int = DEFAULT_LIMIT,
)

/** The newest matching entries, plus what was held and dropped to get them. */
public data class LogSnapshot(
    /** Oldest-last-seen first, so the newest row is the last one — tail order. */
    public val entries: List<LogEntry>,
    /** Distinct entries in the ring, before the query. */
    public val held: Int,
    /** Entries passing the query, before [LogQuery.limit]. */
    public val matched: Int,
    public val errors: Int,
    public val warnings: Int,
    /** Lines observed since the last clear, repeats included. */
    public val lines: Long,
    /** Distinct entries evicted by a cap. */
    public val dropped: Long,
    public val bytes: Int,
) {
    public companion object {
        public val Empty: LogSnapshot = LogSnapshot(
            entries = emptyList(),
            held = 0,
            matched = 0,
            errors = 0,
            warnings = 0,
            lines = 0,
            dropped = 0,
            bytes = 0,
        )
    }
}

public class LogRing(
    private val maxEntries: Int = MAX_ENTRIES,
    private val maxBytes: Int = MAX_BYTES,
) {
    private class Slot(
        val id: Long,
        val level: LogLevel,
        val tag: String,
        val pid: Int,
        val message: String,
        val firstSeen: String,
        val bytes: Int,
        var tid: Int,
        var lastSeen: String,
        var count: Int,
    ) {
        /**
         * The last [LogEntry] handed out for this slot, invalidated on a repeat.
         *
         * Steady state is a stream of new lines while most of the ring is
         * unchanged, so without this every snapshot would allocate an entry per
         * held line at the emission rate. With it, an unchanged row keeps its
         * identity, which also lets Compose skip the item outright instead of
         * comparing a fresh-but-equal copy.
         */
        var cached: LogEntry? = null

        fun entry(): LogEntry = cached ?: LogEntry(
            id = id,
            level = level,
            tag = tag,
            pid = pid,
            tid = tid,
            message = message,
            firstSeen = firstSeen,
            lastSeen = lastSeen,
            count = count,
        ).also { cached = it }

        fun matches(needle: String): Boolean =
            message.contains(needle, ignoreCase = true) || tag.contains(needle, ignoreCase = true)
    }

    private val slots = LinkedHashMap<String, Slot>()
    private var nextId = 0L
    private var bytes = 0
    private var lines = 0L
    private var dropped = 0L

    /** Distinct entries held. Cheap; safe to read per frame. */
    public val held: Int get() = slots.size

    public fun record(line: LogLine) {
        val message = clip(line.message.trimEnd(), MAX_MESSAGE_CHARS)
        if (message.isEmpty()) return
        val tag = clip(line.tag, MAX_TAG_CHARS)
        lines += 1

        // One key allocation per line, same shape as the server's. Avoiding it
        // would mean a hand-rolled open-addressed table keyed on four fields,
        // which is not worth it at logcat's line rate.
        val key = buildString(tag.length + message.length + 16) {
            append(line.level.letter)
            append('\u0000')
            append(line.pid)
            append('\u0000')
            append(tag)
            append('\u0000')
            append(message)
        }

        val existing = slots[key]
        if (existing != null) {
            existing.count += 1
            existing.lastSeen = line.at
            existing.tid = line.tid
            existing.cached = null
            // Re-insert so iteration stays ascending by lastSeen (see the note at
            // the top). Two map operations on the hot repeat path, and in
            // exchange the stalest line is always the first one.
            slots.remove(key)
            slots[key] = existing
            return
        }

        val slot = Slot(
            id = ++nextId,
            level = line.level,
            tag = tag,
            pid = line.pid,
            message = message,
            firstSeen = line.at,
            bytes = utf8Length(tag) + utf8Length(message),
            tid = line.tid,
            lastSeen = line.at,
            count = 1,
        )
        slots[key] = slot
        bytes += slot.bytes
        evict()
    }

    public fun snapshot(query: LogQuery = LogQuery()): LogSnapshot {
        val floor = query.minLevel.rank
        val filter = query.filter.trim()
        val pid = if (filter.isNotEmpty() && filter.all { it in '0'..'9' }) filter.toIntOrNull() else null
        val needle = if (pid == null && filter.isNotEmpty()) filter else null
        val limit = query.limit.coerceIn(1, MAX_LIMIT)

        // A fixed window of the last `limit` matches, so a 2000-entry ring
        // queried for 500 rows materialises 500 LogEntry objects, not 2000.
        val window = arrayOfNulls<Slot>(limit)
        var matched = 0
        var errors = 0
        var warnings = 0
        for (slot in slots.values) {
            if (slot.level.rank > floor) continue
            if (pid != null && slot.pid != pid) continue
            if (needle != null && !slot.matches(needle)) continue
            when (slot.level) {
                LogLevel.Fatal, LogLevel.Error -> errors += 1
                LogLevel.Warn -> warnings += 1
                else -> Unit
            }
            window[matched % limit] = slot
            matched += 1
        }

        val kept = if (matched < limit) matched else limit
        val start = if (matched < limit) 0 else matched % limit
        val entries = ArrayList<LogEntry>(kept)
        for (i in 0 until kept) {
            entries.add(window[(start + i) % limit]!!.entry())
        }
        return LogSnapshot(
            entries = entries,
            held = slots.size,
            matched = matched,
            errors = errors,
            warnings = warnings,
            lines = lines,
            dropped = dropped,
            bytes = bytes,
        )
    }

    public fun clear() {
        slots.clear()
        bytes = 0
        lines = 0
        dropped = 0
        // nextId deliberately keeps counting: a cleared-then-refilled ring must
        // not reuse an id a LazyColumn is still holding as an item key.
    }

    private fun evict() {
        if (slots.size <= maxEntries && bytes <= maxBytes) return
        val iterator = slots.entries.iterator()
        while ((slots.size > maxEntries || bytes > maxBytes) && iterator.hasNext()) {
            bytes -= iterator.next().value.bytes
            iterator.remove()
            dropped += 1
        }
    }
}

private fun clip(text: String, max: Int): String =
    if (text.length <= max) text else text.substring(0, max - 1) + "…"

/**
 * UTF-8 length without encoding the string. `encodeToByteArray().size` would
 * allocate a byte array per line purely to measure it.
 */
private fun utf8Length(text: String): Int {
    var total = 0
    var i = 0
    while (i < text.length) {
        val code = text[i].code
        when {
            code < 0x80 -> total += 1
            code < 0x800 -> total += 2
            text[i].isHighSurrogate() && i + 1 < text.length && text[i + 1].isLowSurrogate() -> {
                total += 4
                i += 1
            }
            else -> total += 3
        }
        i += 1
    }
    return total
}
