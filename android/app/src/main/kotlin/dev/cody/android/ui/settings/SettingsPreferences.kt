package dev.cody.android.ui.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.cody.shared.presentation.SettingsStore
import dev.cody.shared.presentation.ThemeChoice
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Device preferences. Deliberately a SEPARATE DataStore file from the
 * credential one: nothing here is a secret, none of it goes through the
 * Keystore, and clearing the credential on a 401 must not take the user's theme
 * with it.
 *
 * The property delegate creates exactly one instance per process against the
 * application context, so every reader — the theme host at the content root and
 * the settings screen's view model — collects the same store rather than opening
 * the same file twice (which DataStore treats as an error).
 */
private val Context.settingsPreferences: DataStore<Preferences> by preferencesDataStore(
    name = "cody-settings",
)

/**
 * The Android half of [SettingsStore].
 *
 * Key names mirror `lib/storage-keys.ts` on the web side (docs/android-ux.md
 * §2.3), so a preference means the same thing on both clients even though
 * neither reads the other's storage.
 */
class SettingsPreferences(context: Context) : SettingsStore {

    private val store = context.settingsPreferences

    /**
     * A `val`, not a function: `collectAsStateWithLifecycle` keys its collection
     * on the flow instance, so a fresh `map` per call would restart the
     * collection on every recomposition of the content root.
     */
    override val theme: Flow<ThemeChoice> = store.data.map { ThemeChoice.fromId(it[THEME]) }

    override suspend fun setTheme(choice: ThemeChoice) {
        store.edit { it[THEME] = choice.id }
    }

    private companion object {
        val THEME: Preferences.Key<String> = stringPreferencesKey("theme")
    }
}
