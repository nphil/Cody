package dev.cody.android.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.cody.android.R
import dev.cody.android.ui.common.StatusPane
import dev.cody.android.ui.home.HomeScreen
import dev.cody.android.ui.onboarding.OnboardingScreen
import dev.cody.android.ui.settings.CodyPreferredTheme
import dev.cody.android.vm.CodyViewModel
import dev.cody.shared.presentation.AppState

/**
 * Routes between the three shells there are.
 *
 * No navigation library: with exactly one branch — onboarded or not — a
 * `NavHost` would add a dependency, a route vocabulary and a back-stack to reason
 * about, in exchange for nothing. Within the home shell, list/detail is a layout
 * decision rather than a destination, which is the other half of why there is no
 * graph here.
 */
@Composable
fun CodyRoot(viewModel: CodyViewModel) {
    CodyPreferredTheme {
        Surface(
            // safeDrawing covers status/navigation bars AND the IME, which is
            // required from targetSdk 35 onward where edge-to-edge is enforced.
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding(),
            color = MaterialTheme.colorScheme.background,
        ) {
            val appState by viewModel.app.state.collectAsStateWithLifecycle()
            when (val state = appState) {
                AppState.Starting -> StatusPane(
                    message = stringResource(R.string.status_connecting),
                    busy = true,
                )

                AppState.Onboarding -> OnboardingScreen(viewModel.onboarding)

                is AppState.Connected -> {
                    val models by viewModel.connected.collectAsStateWithLifecycle()
                    val connected = models
                    if (connected == null) {
                        // One frame at most: the view model builds these from the
                        // same state emission that produced Connected.
                        StatusPane(
                            message = stringResource(R.string.status_connecting),
                            busy = true,
                        )
                    } else {
                        HomeScreen(
                            identity = state.identity,
                            sessions = connected.sessions,
                            chat = connected.chat,
                            onSignOut = viewModel.app::signOut,
                        )
                    }
                }
            }
        }
    }
}
