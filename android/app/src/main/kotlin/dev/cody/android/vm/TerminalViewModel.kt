package dev.cody.android.vm

import android.app.Application
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.Companion.APPLICATION_KEY
import dev.cody.android.termux.TermuxIntentRunner
import dev.cody.shared.presentation.TerminalModel

/**
 * Lifecycle home for the Termux command runner's state.
 *
 * Same job as [CodyViewModel]'s: hold a scope that survives configuration
 * changes, so the scrollback and an in-flight command are not lost to a
 * rotation. It owns nothing else — the logic is [TerminalModel] in `:shared`.
 */
class TerminalViewModel(application: Application) : ViewModel() {

    val terminal: TerminalModel = TerminalModel(
        runner = TermuxIntentRunner(application),
        scope = viewModelScope,
    )

    init {
        // Probing on construction rather than on every composition: the answer
        // only changes when the user goes and changes something outside the app,
        // and every failure card offers an explicit re-check for that.
        terminal.refresh()
    }

    companion object {
        val Factory: ViewModelProvider.Factory = viewModelFactory {
            initializer { TerminalViewModel(this[APPLICATION_KEY] as Application) }
        }
    }
}
