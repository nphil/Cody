package dev.cody.android.vm

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.Companion.APPLICATION_KEY
import dev.cody.android.CodyApplication
import dev.cody.shared.backend.CodyBackend
import dev.cody.shared.presentation.AppModel
import dev.cody.shared.presentation.AppState
import dev.cody.shared.presentation.ChatModel
import dev.cody.shared.presentation.OnboardingModel
import dev.cody.shared.presentation.SessionsModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** The models that only exist while a backend does. */
class ConnectedModels(
    val backend: CodyBackend,
    val sessions: SessionsModel,
    val chat: ChatModel,
)

/**
 * The Android lifecycle wrapper around the presentation models in `:shared`.
 *
 * All this type contributes is a scope that survives configuration changes —
 * rotating a tablet must not reload the session list. The logic lives in
 * `:shared` so it ports; this class is the ~40 lines that will NOT port, and
 * that is exactly the split the architecture asks for.
 */
class CodyViewModel(application: CodyApplication) : ViewModel() {

    val app: AppModel = AppModel(viewModelScope, application.credentials)

    val onboarding: OnboardingModel = OnboardingModel(
        scope = viewModelScope,
        credentials = application.credentials,
        deviceName = application.deviceName,
    )

    private val _connected = MutableStateFlow<ConnectedModels?>(null)
    val connected: StateFlow<ConnectedModels?> = _connected.asStateFlow()

    init {
        viewModelScope.launch {
            app.state.collect { state ->
                val backend = (state as? AppState.Connected)?.backend
                when {
                    backend == null -> _connected.value = null
                    // Identity reloading emits a new AppState for the SAME
                    // backend; rebuilding here would throw away a loaded session
                    // list for nothing.
                    _connected.value?.backend === backend -> Unit
                    else -> _connected.value = ConnectedModels(
                        backend = backend,
                        sessions = SessionsModel(backend, viewModelScope, app::signOut),
                        chat = ChatModel(backend, viewModelScope, app::signOut),
                    )
                }
            }
        }
    }

    companion object {
        val Factory: ViewModelProvider.Factory = viewModelFactory {
            initializer { CodyViewModel(this[APPLICATION_KEY] as CodyApplication) }
        }
    }
}
