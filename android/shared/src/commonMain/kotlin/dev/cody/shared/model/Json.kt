package dev.cody.shared.model

import kotlinx.serialization.json.Json

/**
 * The one JSON configuration the client uses.
 *
 * `ignoreUnknownKeys` is not laziness: the Android app ships on its own release
 * train and will routinely talk to a NEWER Cody server than it was built
 * against. A server that adds a field must never break an installed client, so
 * unknown keys are dropped rather than fatal. The inverse -- a field the app
 * needs going missing -- is handled by giving every property a default, so a
 * response from an OLDER server decodes too.
 */
public val CodyJson: Json = Json {
    ignoreUnknownKeys = true
    // Server routes hand-build some payloads; tolerate unquoted/loose shapes
    // rather than fail a whole transcript over one field.
    isLenient = true
    // `null` for a property that has a default means "use the default", which is
    // how the server's optional-vs-absent fields actually behave.
    explicitNulls = false
    coerceInputValues = true
}
