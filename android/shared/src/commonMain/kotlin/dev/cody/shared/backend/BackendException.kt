package dev.cody.shared.backend

/**
 * Why a backend call failed, in the vocabulary the UI switches on.
 *
 * An enum rather than a sealed exception hierarchy because every consumer wants
 * exactly one thing from it — which message to show — and the server's own
 * `code` string (carried separately) covers the cases that need finer grain.
 */
public enum class BackendFailure {
    /** 401. The token is dead; the only cure is re-onboarding. */
    Unauthorized,

    /** 403. Authenticated but not allowed — e.g. a bearer trying to mint a token. */
    Forbidden,

    /** 404. Session or route gone. */
    NotFound,

    /** 429. */
    RateLimited,

    /** Any other non-2xx. */
    Server,

    /** DNS, TCP, TLS, or timeout — the request never got an answer. */
    Unreachable,

    /** A 2xx whose body did not decode. */
    Malformed,
}

/**
 * The single exception type every [CodyBackend] method throws.
 *
 * [code] is the server's own machine-readable error code when it sent one
 * (`auth_required`, `bearer_forbidden`, `token_limit`, …); [detail] is its human
 * message. Neither is ever shown raw to the user — screens localise off
 * [failure] and [code] — but both are what makes a bug report actionable.
 */
public class BackendException(
    public val failure: BackendFailure,
    public val status: Int? = null,
    public val code: String? = null,
    public val detail: String? = null,
    cause: Throwable? = null,
) : Exception(
    buildString {
        append(failure.name)
        if (status != null) append(" (HTTP ").append(status).append(')')
        if (code != null) append(" [").append(code).append(']')
        if (detail != null) append(": ").append(detail)
    },
    cause,
)
