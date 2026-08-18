package dev.cody.android.ui.settings

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.Companion.APPLICATION_KEY
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import dev.cody.android.CodyApplication
import dev.cody.android.shizuku.ShizukuGateway
import dev.cody.android.shizuku.ShizukuStatus
import dev.cody.android.termux.TermuxIntentRunner
import dev.cody.shared.presentation.SettingsStore
import dev.cody.shared.presentation.TerminalModel
import dev.cody.shared.presentation.TerminalState
import dev.cody.shared.presentation.ThemeChoice
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * State for the settings screen.
 *
 * Its own `ViewModel` for the same reason [dev.cody.android.shizuku.LogsViewModel]
 * is: everything expensive it touches — the Shizuku binder, a Termux round trip —
 * is constructed when the screen is first opened and never at launch. A user who
 * never opens Settings pays nothing for it.
 *
 * It owns no availability logic. The Shizuku state comes from the gateway that
 * the Logs surface already uses and the Termux state from the shared
 * [TerminalModel] that the Terminal surface uses, so Settings cannot disagree
 * with either screen about whether a prerequisite is met.
 */
class SettingsViewModel(application: Application) : ViewModel() {

    private val store: SettingsStore = SettingsPreferences(application)
    private val shizuku = ShizukuGateway(application, viewModelScope)
    private val terminal = TerminalModel(
        runner = TermuxIntentRunner(application),
        scope = viewModelScope,
    )

    val theme: StateFlow<ThemeChoice> = store.theme.stateIn(
        scope = viewModelScope,
        // Eagerly: the value is one string off disk and the screen reads it in
        // its first composition. Lazily would render the default first and then
        // move the selection under the user's finger.
        started = SharingStarted.Eagerly,
        initialValue = ThemeChoice.FollowSystem,
    )

    /**
     * The address the app is actually talking to, read from the credential store
     * rather than taken from the identity probe: this must stay truthful while
     * the server is unreachable, which is exactly when someone opens Settings to
     * check what they typed.
     *
     * Only the URL is read. The token is never lifted out of the store by this
     * screen — see the token section's copy for why.
     */
    val serverUrl: StateFlow<String?> =
        ((application as? CodyApplication)?.credentials?.current?.map { it?.baseUrl } ?: flowOf(null))
            .stateIn(viewModelScope, SharingStarted.Eagerly, null)

    val shizukuStatus: StateFlow<ShizukuStatus> = shizuku.status

    val termux: StateFlow<TerminalState> = terminal.state

    init {
        shizuku.attach()
        terminal.refresh()
    }

    fun setTheme(choice: ThemeChoice) {
        if (theme.value == choice) return
        viewModelScope.launch { store.setTheme(choice) }
    }

    /**
     * Re-probe both prerequisites.
     *
     * Worth doing on every resume: every fix for every state in either of them
     * happens in another app, so the user comes back expecting the rows to have
     * noticed.
     */
    fun recheck() {
        shizuku.refresh()
        terminal.refresh()
    }

    fun requestShizukuPermission() = shizuku.requestPermission()

    fun openShizuku(): Boolean = shizuku.openShizuku()

    fun openShizukuHomepage(): Boolean = shizuku.openShizukuHomepage()

    override fun onCleared() {
        shizuku.detach()
    }

    companion object {
        val Factory: ViewModelProvider.Factory = viewModelFactory {
            initializer { SettingsViewModel(this[APPLICATION_KEY] as Application) }
        }
    }
}
