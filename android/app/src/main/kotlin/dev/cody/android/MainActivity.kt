package dev.cody.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.cody.android.ui.CodyRoot
import dev.cody.android.vm.CodyViewModel

/**
 * The single activity.
 *
 * `android:configChanges` in the manifest keeps the activity alive across
 * rotation and window resizing, which on a tablet (and in a desktop-mode window)
 * happens often enough that recreating the whole Compose tree would be visible.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            CodyRoot(viewModel = viewModel(factory = CodyViewModel.Factory))
        }
    }
}
