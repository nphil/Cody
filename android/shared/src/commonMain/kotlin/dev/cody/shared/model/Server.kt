package dev.cody.shared.model

import kotlinx.serialization.Serializable

/** Response body of `GET /api/info`. */
@Serializable
public data class ServerInfo(
    public val codyVersion: String = "",
    public val nodeVersion: String = "",
    /** "<os> <arch>", e.g. "linux x64". */
    public val platform: String = "",
    public val harness: HarnessRef = HarnessRef(),
    public val capabilities: ServerCapabilities = ServerCapabilities(),
    public val engine: EngineRef = EngineRef(),
)

@Serializable
public data class HarnessRef(
    public val id: String = "",
    public val name: String = "",
)

@Serializable
public data class EngineRef(
    public val id: String = "",
    public val displayName: String = "",
    public val shortName: String = "",
    public val experimental: Boolean = false,
)

/**
 * What the server's ACTIVE engine can serve, mirroring `HarnessCapabilities`
 * (lib/harness/types.ts). Everything defaults to false: an older server that
 * does not report a capability must make the app hide that surface, never show
 * a screen that 404s.
 */
@Serializable
public data class ServerCapabilities(
    public val liveSessions: Boolean = false,
    public val models: Boolean = false,
    public val skills: Boolean = false,
    public val plugins: Boolean = false,
    public val mcp: Boolean = false,
    public val nativeSettings: Boolean = false,
    public val updates: Boolean = false,
    public val chatExtras: Boolean = false,
)

/** Response body of `GET /api/accounts/me`. */
@Serializable
public data class AccountEnvelope(public val user: Account? = null)

@Serializable
public data class Account(
    public val id: String = "",
    public val username: String = "",
    public val fullName: String? = null,
    public val role: String = "",
    /** Account materialised from server environment config rather than signup. */
    public val envManaged: Boolean = false,
    public val hasAvatar: Boolean = false,
)

/** Request body of `POST /api/accounts/login`. */
@Serializable
public data class LoginRequest(
    public val username: String,
    public val password: String,
)

/** Request body of `POST /api/accounts/me/tokens`. */
@Serializable
public data class MintTokenRequest(public val name: String)

/**
 * Response body of `POST /api/accounts/me/tokens`. [secret] is shown exactly
 * once — the server stores only a hash — so it must be persisted immediately or
 * it is gone.
 */
@Serializable
public data class MintTokenResponse(
    public val token: TokenRef = TokenRef(),
    public val secret: String = "",
)

@Serializable
public data class TokenRef(
    public val id: String = "",
    public val name: String = "",
    /** Non-secret prefix, safe to display so a token can be identified later. */
    public val preview: String = "",
    public val createdAt: String? = null,
    public val lastUsedAt: String? = null,
)

/** Error envelope every Cody API route returns on failure. */
@Serializable
public data class ApiError(
    public val error: String = "",
    public val code: String? = null,
)
