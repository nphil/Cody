package dev.cody.android.ui.settings

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.cody.android.ui.theme.CodyTheme
import dev.cody.shared.presentation.ThemeChoice

/**
 * [CodyTheme] with the user's stored choice applied.
 *
 * This exists so the theme picker in Settings can actually do something: the
 * palette has to be chosen ABOVE every screen, and the only composable above
 * every screen is the content root. Wrapping `CodyTheme` here keeps the
 * preference, its storage and its one consumer in the same slice instead of
 * spreading a three-value enum across the app shell.
 *
 * Two decisions worth knowing:
 *
 * - **The first frame follows the system.** The stored choice arrives from
 *   DataStore a frame or two after the window opens, so a user who has pinned
 *   the palette against their device setting sees the system's answer very
 *   briefly. The alternative is a blank hold on every launch, which is a
 *   worse trade for a preference most people leave alone.
 * - **The switch is instant, not a 450ms crossfade** (docs/android-ux.md §1.5).
 *   Two prerequisites for the spec'd version are not built yet: §8.1's
 *   `LocalReduceMotion` (an unconditional whole-screen fade is exactly what
 *   `ANIMATOR_DURATION_SCALE == 0` forbids), and a `SaveableStateHolder` around
 *   the content root — a `Crossfade` there composes the app twice and drops
 *   every piece of transient screen state, so switching theme would clear a
 *   half-typed prompt. Both belong to the theme/motion slice; when they land,
 *   this is the one place the fade goes.
 */
@Composable
fun CodyPreferredTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val store = remember(context) { SettingsPreferences(context) }
    val choice by store.theme.collectAsStateWithLifecycle(initialValue = ThemeChoice.FollowSystem)

    CodyTheme(dark = choice.isDark(isSystemInDarkTheme()), content = content)
}
