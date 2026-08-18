package dev.cody.shared.backend

import io.ktor.http.Url

/** Where the remote backend lives and the credential it presents. */
public data class ServerConfig(
    /** Absolute origin, no trailing slash, produced by [normalizeBaseUrl]. */
    public val baseUrl: String,
    /** Personal access token, sent as `Authorization: Bearer <token>`. */
    public val token: String,
) {
    public companion object {
        /**
         * Turns what someone types on a tablet keyboard into an origin, or null
         * if it cannot be one.
         *
         * Being liberal here is the whole point: the address is typed once, on a
         * touch keyboard, and is usually a bare Tailscale host or `host:30177`.
         * A missing scheme therefore defaults to http rather than failing —
         * Cody on a tail-net is plain HTTP far more often than not. A path
         * prefix is preserved so a reverse-proxied `https://box/cody` works.
         */
        public fun normalizeBaseUrl(raw: String): String? {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return null
            val absolute = if (trimmed.contains("://")) trimmed else "http://$trimmed"
            val url = runCatching { Url(absolute) }.getOrNull() ?: return null
            val scheme = url.protocol.name
            if (scheme != "http" && scheme != "https") return null
            if (url.host.isBlank()) return null
            val port = if (url.port == url.protocol.defaultPort) "" else ":${url.port}"
            val path = url.encodedPath.trimEnd('/')
            return "$scheme://${url.host}$port$path"
        }
    }
}
