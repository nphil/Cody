package dev.cody.android.shizuku

import androidx.compose.runtime.Immutable
import dev.cody.shared.logs.LogLine
import dev.cody.shared.logs.LogQuery
import dev.cody.shared.logs.LogRing
import dev.cody.shared.logs.LogSnapshot
import dev.cody.shared.logs.LogcatParser
import dev.cody.shared.logs.MAX_LIMIT
import dev.cody.shared.logs.logcatCommand
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.IOException

/** Why the log stream is not running. Each maps to its own sentence in the UI. */
@Immutable
data class LogcatFailure(val kind: Kind, val detail: String?) {
    enum class Kind {
        /** `logcat` could not be executed at all. */
        CouldNotStart,

        /** It ran and then exited, which normally means it was refused. */
        StreamEnded,
    }
}

@Immutable
data class LogcatState(
    val snapshot: LogSnapshot = LogSnapshot.Empty,
    val streaming: Boolean = false,
    val failure: LogcatFailure? = null,
)

/**
 * Runs `logcat`, feeds [LogRing], and publishes bounded snapshots.
 *
 * Two coroutines and one channel, which is the smallest arrangement that gets
 * the concurrency right:
 *
 * - a **reader** on `Dispatchers.IO`, blocked in `readLine()`, doing nothing but
 *   parsing and forwarding;
 * - a **pump** on `Dispatchers.Default` that is the ONLY thing ever to touch the
 *   ring, so the per-line hot path needs no lock;
 * - a bounded channel between them, whose `send` suspends. That backpressure is
 *   deliberate: when the pump cannot keep up the reader stops draining the pipe
 *   and `logd` drops on its side, which is a bound the OS already implements
 *   properly. An unbounded queue here would be the one unbounded thing in a
 *   design whose entire point is bounding.
 *
 * Snapshots are emitted on a 10 Hz tick rather than per line. A busy device
 * emits thousands of lines a second and each emission costs a list; ten a second
 * is far below what a reader can follow and far above what looks laggy
 * (docs/android-ux.md §6.9 — nothing heavy on the main thread, and no
 * per-token whole-list work).
 */
class LogcatSource(private val scope: CoroutineScope) {

    private val ring = LogRing()
    private val parser = LogcatParser()
    private val commands = Channel<Command>(capacity = COMMAND_BUFFER)

    private val _state = MutableStateFlow(LogcatState())
    val state: StateFlow<LogcatState> = _state.asStateFlow()

    /**
     * Held outside the coroutine on purpose. A coroutine blocked in `readLine()`
     * cannot observe cancellation, and `Job.invokeOnCompletion` does not fire
     * while it is still blocked, so the only thing that ends the read is closing
     * the pipe from here.
     */
    @Volatile
    private var process: Process? = null
    private var reader: Job? = null

    init {
        scope.launch(Dispatchers.Default) { pump() }
    }

    fun start() {
        if (reader?.isActive == true) return
        parser.reset()
        _state.update { it.copy(streaming = true, failure = null) }
        reader = scope.launch(Dispatchers.IO) { read() }
    }

    fun stop() {
        reader?.cancel()
        reader = null
        runCatching { process?.destroy() }
        process = null
        _state.update { it.copy(streaming = false) }
    }

    fun query(query: LogQuery) {
        commands.trySend(Command.Requery(query))
    }

    fun clear() {
        commands.trySend(Command.Wipe)
    }

    private suspend fun read() {
        val started = try {
            ProcessBuilder(logcatCommand())
                // logcat writes its own refusals to stderr. Folding them into the
                // stream is what turns "permission denied" into a visible line
                // instead of an empty screen.
                .redirectErrorStream(true)
                .start()
        } catch (failure: IOException) {
            commands.send(Command.Ended(LogcatFailure(LogcatFailure.Kind.CouldNotStart, failure.message)))
            return
        } catch (failure: SecurityException) {
            commands.send(Command.Ended(LogcatFailure(LogcatFailure.Kind.CouldNotStart, failure.message)))
            return
        }
        process = started
        try {
            started.inputStream.bufferedReader().use { source ->
                while (currentCoroutineContext().isActive) {
                    val raw = source.readLine() ?: break
                    val line = parser.parse(raw) ?: continue
                    commands.send(Command.Ingest(line))
                }
            }
            if (currentCoroutineContext().isActive) {
                commands.send(Command.Ended(LogcatFailure(LogcatFailure.Kind.StreamEnded, null)))
            }
        } catch (_: IOException) {
            // stop() destroyed the process and closed the pipe under the read.
            // That is the normal shutdown path, not a failure worth reporting.
        } finally {
            runCatching { started.destroy() }
            if (process === started) process = null
        }
    }

    private suspend fun pump(): Unit = coroutineScope {
        val ticker = launch {
            while (isActive) {
                delay(EMIT_INTERVAL_MS)
                // trySend, not send: a dropped tick costs 100 ms of latency and
                // the next one is already on its way, whereas a suspended ticker
                // would sit behind the very backlog it exists to flush.
                commands.trySend(Command.Tick)
            }
        }
        var query = LogQuery(limit = MAX_LIMIT)
        var dirty = false
        try {
            for (command in commands) {
                var immediate = false
                when (command) {
                    is Command.Ingest -> {
                        ring.record(command.line)
                        dirty = true
                    }

                    is Command.Requery -> {
                        query = command.query
                        dirty = true
                        immediate = true
                    }

                    is Command.Ended -> _state.update {
                        it.copy(streaming = false, failure = command.failure)
                    }

                    Command.Wipe -> {
                        ring.clear()
                        dirty = true
                        immediate = true
                    }

                    Command.Tick -> Unit
                }
                // A user action republishes at once, because a filter that takes
                // up to 100 ms to apply feels broken. Ingest waits for the tick.
                if (dirty && (immediate || command === Command.Tick)) {
                    val snapshot = ring.snapshot(query)
                    _state.update { it.copy(snapshot = snapshot) }
                    dirty = false
                }
            }
        } finally {
            ticker.cancel()
        }
    }

    private sealed interface Command {
        class Ingest(val line: LogLine) : Command
        class Requery(val query: LogQuery) : Command
        class Ended(val failure: LogcatFailure) : Command
        data object Wipe : Command
        data object Tick : Command
    }

    private companion object {
        /**
         * Deep enough to absorb a burst without stalling the reader, shallow
         * enough that a stalled pump reaches back to `logd` in well under a
         * second rather than hoarding megabytes of lines nobody has seen.
         */
        const val COMMAND_BUFFER = 512

        const val EMIT_INTERVAL_MS = 100L
    }
}
