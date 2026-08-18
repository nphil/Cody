package dev.cody.shared.presentation

import dev.cody.shared.backend.BackendException
import dev.cody.shared.backend.BackendFailure

/**
 * An async value in one of four honest states.
 *
 * [Failed] carries the failure vocabulary rather than a message string: the
 * string has to come from Android resources so it can be shown in the user's
 * language, and a presentation model in common code has no business knowing
 * about resources.
 */
public sealed interface Loadable<out T> {
    public data object Idle : Loadable<Nothing>

    public data object Loading : Loadable<Nothing>

    public data class Ready<out T>(public val value: T) : Loadable<T>

    public data class Failed(
        public val failure: BackendFailure,
        /** The server's machine-readable code, when it sent one. */
        public val code: String? = null,
    ) : Loadable<Nothing>

    public val valueOrNull: T? get() = (this as? Ready)?.value
}

internal fun BackendException.asFailed(): Loadable.Failed = Loadable.Failed(failure, code)
