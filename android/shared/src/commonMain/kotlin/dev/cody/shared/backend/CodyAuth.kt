package dev.cody.shared.backend

import dev.cody.shared.model.ApiError
import dev.cody.shared.model.CodyJson
import dev.cody.shared.model.LoginRequest
import dev.cody.shared.model.MintTokenRequest
import dev.cody.shared.model.MintTokenResponse
import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.call.body
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.client.request.accept
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.CancellationException

/**
 * Mints a personal access token from a username and password, so the tablet
 * never needs a web detour to get onboarded.
 *
 * This is the ONLY place a password is handled, and the only place a cookie
 * exists. The flow is: log in (server sets a session cookie) → ask that
 * authenticated session for a token → keep the token, throw the client and its
 * in-memory cookie jar away. Nothing is persisted here; the caller stores the
 * returned secret. The cookie jar is per-instance and in-memory by
 * construction, so [close] is genuinely the end of it.
 *
 * A bearer credential may not mint another token (the server answers 403
 * `bearer_forbidden`), which is why this cannot simply reuse [RemoteBackend].
 */
public class CodyAuth(
    private val baseUrl: String,
    engine: HttpClientEngine? = null,
) {
    private val http: HttpClient = run {
        val configure: HttpClientConfig<*>.() -> Unit = {
            expectSuccess = false
            install(ContentNegotiation) { json(CodyJson) }
            // Default storage is an in-memory AcceptAllCookiesStorage: the login
            // cookie lives exactly as long as this object.
            install(HttpCookies)
            install(HttpTimeout) {
                requestTimeoutMillis = REQUEST_TIMEOUT_MS
                connectTimeoutMillis = CONNECT_TIMEOUT_MS
            }
            defaultRequest { accept(ContentType.Application.Json) }
        }
        if (engine != null) HttpClient(engine, configure) else HttpClient(configure)
    }

    /**
     * @param deviceName what the token is called in the account's token list, so
     *   a lost tablet can be identified and revoked from another device.
     * @return the token secret, which the server shows exactly once.
     */
    public suspend fun mintToken(username: String, password: String, deviceName: String): String {
        ensureOk {
            http.post("$baseUrl/api/accounts/login") {
                contentType(ContentType.Application.Json)
                setBody(LoginRequest(username = username, password = password))
            }
        }

        val response = ensureOk {
            http.post("$baseUrl/api/accounts/me/tokens") {
                contentType(ContentType.Application.Json)
                setBody(MintTokenRequest(name = deviceName))
            }
        }

        val minted = try {
            response.body<MintTokenResponse>()
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (failure: Throwable) {
            throw BackendException(BackendFailure.Malformed, detail = failure.message, cause = failure)
        }

        if (minted.secret.isBlank()) {
            throw BackendException(
                failure = BackendFailure.Malformed,
                detail = "token response carried no secret",
            )
        }
        return minted.secret
    }

    public fun close(): Unit = http.close()

    private suspend fun ensureOk(block: suspend () -> HttpResponse): HttpResponse {
        val response = try {
            block()
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (failure: Throwable) {
            throw asBackendException(failure)
        }
        if (response.status.isSuccess()) return response

        val error = runCatching { response.body<ApiError>() }.getOrNull()
        throw BackendException(
            failure = when (response.status.value) {
                // A wrong password is a 401 here, and unlike a 401 on /api/*
                // it does NOT mean "token is dead" -- onboarding shows "check
                // your credentials" instead of bouncing anywhere.
                401 -> BackendFailure.Unauthorized
                403 -> BackendFailure.Forbidden
                429 -> BackendFailure.RateLimited
                else -> BackendFailure.Server
            },
            status = response.status.value,
            code = error?.code,
            detail = error?.error?.takeIf { it.isNotBlank() },
        )
    }

    private companion object {
        const val REQUEST_TIMEOUT_MS = 20_000L
        const val CONNECT_TIMEOUT_MS = 10_000L
    }
}
