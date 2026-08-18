package dev.cody.android

import android.app.Application
import android.os.Build
import dev.cody.android.data.SecureCredentialStore
import dev.cody.shared.backend.CredentialStore

/**
 * Holds the two process-scoped things the app needs.
 *
 * A plain Application rather than a DI framework: there are exactly two
 * singletons, and a graph would be more machinery than the thing it wires.
 * Introduce one when there is a third.
 */
class CodyApplication : Application() {

    /** Encrypted token storage, shared by every screen and view model. */
    val credentials: CredentialStore by lazy { SecureCredentialStore(this) }

    /**
     * What a minted token is called in the account's token list. The point is
     * revocability: "Pixel Tablet" in that list is actionable, "android" is not.
     */
    val deviceName: String by lazy {
        val model = Build.MODEL?.takeIf { it.isNotBlank() }
        val manufacturer = Build.MANUFACTURER?.takeIf { it.isNotBlank() }
        when {
            model == null -> "Cody Android"
            manufacturer == null || model.startsWith(manufacturer, ignoreCase = true) -> model
            else -> "$manufacturer $model"
        }
    }
}
