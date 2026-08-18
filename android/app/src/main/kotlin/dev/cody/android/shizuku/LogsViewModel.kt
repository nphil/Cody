package dev.cody.android.shizuku

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.Companion.APPLICATION_KEY
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.cody.shared.logs.LogLevel
import dev.cody.shared.logs.LogQuery
import dev.cody.shared.logs.MAX_LIMIT
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * State for the Logs screen.
 *
 * Its own `ViewModel` rather than a branch of `CodyViewModel`: this screen has
 * no backend, no session and no token, and it must work while the app is signed
 * out. Building it separately also means the whole Shizuku surface — classes,
 * binder listeners, hidden-API machinery — is constructed the first time the
 * screen is opened and never before, so a launch that never visits it pays
 * nothing.
 */
class LogsViewModel(application: Application) : ViewModel() {

    private val gateway = ShizukuGateway(application, viewModelScope)
    private val source = LogcatSource(viewModelScope)

    val status: StateFlow<ShizukuStatus> = gateway.status
    val logs: StateFlow<LogcatState> = source.state

    private val _query = MutableStateFlow(LogQuery(limit = MAX_LIMIT))
    val query: StateFlow<LogQuery> = _query.asStateFlow()

    private val _granting = MutableStateFlow(false)
    val granting: StateFlow<Boolean> = _granting.asStateFlow()

    /** The last grant attempt, or null before one has been made. */
    private val _grant = MutableStateFlow<GrantOutcome?>(null)
    val grant: StateFlow<GrantOutcome?> = _grant.asStateFlow()

    init {
        gateway.attach()
        // Only when the permission was already effective at process start. This
        // is the whole "never at launch, never unprompted" rule: opening the
        // screen reads logs it is already allowed to read, and asks for nothing.
        if (gateway.status.value.logsReadable) source.start()
    }

    /**
     * Re-probe Shizuku. Cheap, and worth doing whenever the screen resumes: the
     * user may have just started the service in another app.
     */
    fun refresh() = gateway.refresh()

    fun setLevel(level: LogLevel) {
        _query.update { it.copy(minLevel = level) }
        source.query(_query.value)
    }

    fun setFilter(filter: String) {
        _query.update { it.copy(filter = filter) }
        source.query(_query.value)
    }

    fun clear() = source.clear()

    /**
     * Re-attach the reader after `logcat` has exited.
     *
     * It does exit: Android 12+ kills phantom child processes past a system-wide
     * cap, which is exactly what this reader is while the app sits in the
     * background reproducing a bug. Without this the only cure would be leaving
     * the screen and coming back, which also throws the ring away.
     */
    fun restartStream() = source.start()

    fun requestPermission() = gateway.requestPermission()

    fun openShizuku(): Boolean = gateway.openShizuku()

    fun openShizukuHomepage(): Boolean = gateway.openShizukuHomepage()

    fun restart() = gateway.restart()

    fun grantReadLogs() {
        if (_granting.value) return
        viewModelScope.launch {
            // Drop the previous outcome before starting: the banner then only
            // ever shows the attempt in front of the user, which is why it needs
            // no dismiss gesture.
            _grant.value = null
            _granting.value = true
            try {
                _grant.value = gateway.grantReadLogs()
            } finally {
                _granting.value = false
            }
            gateway.refresh()
        }
    }

    /**
     * The visible entries as plain text, for the clipboard.
     *
     * Off the main thread: at the ring's ceiling this joins two thousand lines
     * into a few hundred kilobytes, which is not work to do between two frames.
     * Deliberately untranslated — it is a log excerpt destined for a bug report
     * or a terminal, not UI copy, and a localised header would only get in the
     * way of whoever reads it next.
     */
    suspend fun copyText(): String = withContext(Dispatchers.Default) {
        val entries = logs.value.snapshot.entries
        buildString(entries.size * 96) {
            for (entry in entries) {
                append(entry.lastSeen).append(' ')
                append(entry.level.letter).append('/')
                append(entry.tag).append('(').append(entry.pid).append(')')
                if (entry.count > 1) append(" x").append(entry.count)
                append(": ").append(entry.message).append('\n')
            }
        }
    }

    override fun onCleared() {
        // Explicit, not left to scope cancellation: the reader is blocked in a
        // native read that cancellation cannot interrupt, so the child process
        // has to be destroyed by hand or it outlives the screen.
        source.stop()
        gateway.detach()
    }

    companion object {
        val Factory: ViewModelProvider.Factory = viewModelFactory {
            initializer { LogsViewModel(this[APPLICATION_KEY] as Application) }
        }
    }
}
