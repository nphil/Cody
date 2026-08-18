package dev.cody.shared.logs

/**
 * Android log priorities.
 *
 * `rank` ascends as severity DESCENDS, mirroring `LEVEL_RANK` in
 * `lib/logs/ring.ts`, so a filter is a single comparison: an entry is kept when
 * `entry.level.rank <= floor.rank`. Picking [Warn] therefore keeps warnings,
 * errors and fatals, which is what every log viewer means by "level >= warn".
 */
public enum class LogLevel(public val letter: Char, public val rank: Int) {
    Fatal('F', 0),
    Error('E', 1),
    Warn('W', 2),
    Info('I', 3),
    Debug('D', 4),
    Verbose('V', 5),
    ;

    public companion object {
        /**
         * `logcat` prints `F` for `Log.ASSERT`, but `A` shows up in a few
         * vendor logcat builds and in `-v brief` output from older releases.
         * Both mean the same thing, so both map to [Fatal] rather than being
         * dropped as unparseable.
         *
         * `S` (silent) is a filterspec level, never an emitted entry priority,
         * so it has no member here and reads as unparseable if it ever appears.
         */
        public fun ofLetter(letter: Char): LogLevel? = when (letter) {
            'F', 'A' -> Fatal
            'E' -> Error
            'W' -> Warn
            'I' -> Info
            'D' -> Debug
            'V' -> Verbose
            else -> null
        }
    }
}

/** One parsed `logcat` line, before the ring dedupes it. */
public data class LogLine(
    /**
     * logcat's own clock text, carried verbatim (`10-25 14:30:01.123`, or
     * `2026-10-25 14:30:01.123` under `-v year`).
     *
     * Deliberately NOT parsed into an epoch: logcat omits the year by default,
     * so reconstructing an instant means guessing across a new-year boundary and
     * pulling a date library into a module that has none. The ring orders by
     * arrival, not by this field, so nothing depends on it being comparable —
     * it is display text and is shown exactly as the device wrote it.
     */
    public val at: String,
    public val pid: Int,
    public val tid: Int,
    public val level: LogLevel,
    public val tag: String,
    public val message: String,
)

/**
 * `logcat -v threadtime`, with an optional `-v year` prefix:
 *
 * ```
 * 10-25 14:30:01.123  1234  1256 I ActivityManager: Start proc 5678:dev.cody.android/u0a123
 * ```
 *
 * The tag capture is non-greedy up to the first `:` so that a message
 * containing further colons (`Start proc 5678:dev.cody.android`) stays intact,
 * and the space after that colon is optional because an empty message prints
 * without one.
 */
private val THREADTIME =
    Regex("""^((?:\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([A-Z])\s(.*?):\s?(.*)$""")

/** `--------- beginning of main`, `--------- switch to system`, and friends. */
private val SEPARATOR = Regex("""^-{3,}\s""")

/**
 * Turns the `logcat` byte stream into [LogLine]s.
 *
 * Stateful by design, for one reason: a multi-line message. `threadtime`
 * repeats the full header on every line of a stack trace, so in the normal case
 * this class is a pure function. Not every vendor logcat does, though, and a
 * bare continuation line that failed to parse must not be dropped — it is the
 * body of the exception the user opened this screen to read. So the last header
 * is remembered and re-applied, which keeps the trace attached to the right tag
 * and pid and therefore visible under the same filter as its first line.
 *
 * Unparseable output BEFORE any header is surfaced too, with an empty tag,
 * because that is what logcat's own diagnostics look like (`Unable to open log
 * device`). Swallowing them would render "permission denied" as an empty screen.
 *
 * Not thread-safe: one parser per reader.
 */
public class LogcatParser {
    private var header: LogLine? = null

    /** Returns null for blank lines and buffer separators, which carry nothing. */
    public fun parse(line: String): LogLine? {
        if (line.isBlank()) return null
        if (SEPARATOR.containsMatchIn(line)) {
            // A buffer switch ends whatever message was in flight; letting a
            // trace continue across it would attribute the next buffer's first
            // line to the previous buffer's tag.
            header = null
            return null
        }
        val match = THREADTIME.matchEntire(line)
        if (match == null) {
            val previous = header
            return if (previous != null) {
                previous.copy(message = line)
            } else {
                LogLine(at = "", pid = 0, tid = 0, level = LogLevel.Info, tag = "", message = line)
            }
        }
        val (at, pid, tid, letter, tag, message) = match.destructured
        val level = LogLevel.ofLetter(letter[0]) ?: LogLevel.Info
        val parsed = LogLine(
            at = at,
            // toIntOrNull, not toInt: a pid wider than Int is impossible on
            // Android but a corrupted line must not take the reader down.
            pid = pid.toIntOrNull() ?: 0,
            tid = tid.toIntOrNull() ?: 0,
            level = level,
            tag = tag,
            message = message,
        )
        header = parsed
        return parsed
    }

    /** Forget the carried header. Call when the underlying process is replaced. */
    public fun reset() {
        header = null
    }
}

/** Lines of scrollback logcat replays when the stream is attached. */
public const val LOGCAT_TAIL_LINES: Int = 400

/**
 * The argv for the reader process.
 *
 * `-T`, not `-t`: `-t` implies `-d` (dump and exit), so it would give one
 * snapshot and no follow. `-T` replays the same scrollback and then keeps
 * streaming, which is what a follow-tail view needs.
 *
 * No `--pid` and no filterspec: level and package filtering happen in
 * [LogRing], against everything already captured. Pushing them into the process
 * would mean respawning logcat on every filter change and losing the scrollback
 * the user is looking at, to save a comparison per line.
 */
public fun logcatCommand(tailLines: Int = LOGCAT_TAIL_LINES): List<String> = listOf(
    "logcat",
    "-v", "threadtime",
    "-b", "main,system,crash",
    "-T", tailLines.coerceIn(1, 10_000).toString(),
)
