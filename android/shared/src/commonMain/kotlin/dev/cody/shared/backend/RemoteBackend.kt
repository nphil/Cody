package dev.cody.shared.backend

import dev.cody.shared.model.AccountEnvelope
import dev.cody.shared.model.AgentEvent
import dev.cody.shared.model.ApiError
import dev.cody.shared.model.CodyJson
import dev.cody.shared.model.ServerInfo
import dev.cody.shared.model.SessionListPage
import dev.cody.shared.model.SessionTranscript
import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.client.call.body
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.HttpTimeoutConfig
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.sse.SSE
import io.ktor.client.plugins.sse.sse
import io.ktor.client.plugins.timeout
import io.ktor.client.request.accept
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * [CodyBackend] over the Cody server's HTTP API.
 *
 * Authentication is a bearer token on every request; there is no cookie path and
 * no challenge/retry dance, because the server never sends `WWW-Authenticate`.
 * Any 401 means the token is dead, which surfaces as
 * [BackendFailure.Unauthorized] and sends the user back to onboarding.
 */
public class RemoteBackend(
    private val config: ServerConfig,
    engine: HttpClientEngine? = null,
) : CodyBackend {

    override val kind: BackendKind get() = BackendKind.Remote

    private val http: HttpClient = run {
        val configure: HttpClientConfig<*>.() -> Unit = {
            // Statuses are mapped by hand in `call`, so Ktor must not throw its
            // own exception type first and lose the server's error body.
            expectSuccess = false
            install(ContentNegotiation) { json(CodyJson) }
            install(SSE)
            install(HttpTimeout) {
                requestTimeoutMillis = REQUEST_TIMEOUT_MS
                connectTimeoutMillis = CONNECT_TIMEOUT_MS
                socketTimeoutMillis = SOCKET_TIMEOUT_MS
            }
            defaultRequest {
                header(HttpHeaders.Authorization, "Bearer ${config.token}")
                accept(ContentType.Application.Json)
            }
        }
        if (engine != null) HttpClient(engine, configure) else HttpClient(configure)
    }

    override suspend fun identify(): BackendIdentity {
        // accounts/me is the cheapest authenticated route: no session scan, no
        // engine work. It doubles as the connectivity check and the identity
        // lookup, which is why onboarding calls exactly this.
        val account = call { http.get(endpoint("accounts", "me")) }.decode<AccountEnvelope>().user

        // Capabilities are best-effort. A server that cannot report them is
        // still perfectly able to serve sessions, so degrade to the core set
        // rather than presenting an app with every screen hidden.
        val info = runCatching { call { http.get(endpoint("info")) }.decode<ServerInfo>() }.getOrNull()

        return BackendIdentity(
            kind = BackendKind.Remote,
            label = hostLabel(),
            codyVersion = info?.codyVersion.orEmpty(),
            engineName = info?.engine?.displayName.orEmpty(),
            username = account?.username,
            capabilities = info?.let { BackendCapabilities.fromServer(it.capabilities) }
                ?: BackendCapabilities.Core,
        )
    }

    override suspend fun listSessions(): SessionListPage =
        call { http.get(endpoint("sessions")) }.decode()

    override suspend fun loadTranscript(sessionId: String): SessionTranscript =
        call {
            http.get(endpoint("sessions", sessionId)) {
                // Thinking bodies and tool-result images are fetched on demand;
                // asking for them inline turns a long transcript into megabytes
                // over a tail-net link.
                url.parameters.append("deferThinking", "1")
                url.parameters.append("deferMedia", "1")
            }
        }.decode()

    override suspend fun sendPrompt(sessionId: String, text: String) {
        call {
            http.post(endpoint("agent", sessionId)) {
                contentType(ContentType.Application.Json)
                setBody(PromptCommand(type = "prompt", message = text))
            }
        }
    }

    override fun events(sessionId: String): Flow<AgentEvent> = channelFlow {
        try {
            http.sse(
                urlString = endpoint("agent", sessionId, "events"),
                request = {
                    // The stream stays open for as long as the agent runs, so a
                    // finite REQUEST timeout would sever it mid-turn.
                    //
                    // The socket timeout must not be left at the default either:
                    // the server's only keep-alive is a bare `:` comment every
                    // 30s, and the default 30s socket timeout races it -- an idle
                    // but perfectly healthy stream would drop roughly whenever
                    // the heartbeat was a moment late. SSE_SOCKET_TIMEOUT_MS
                    // tolerates two missed heartbeats and still notices a link
                    // that has genuinely died, which INFINITE would not.
                    timeout {
                        requestTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
                        socketTimeoutMillis = SSE_SOCKET_TIMEOUT_MS
                    }
                },
            ) {
                incoming.collect { frame ->
                    val payload = frame.data?.takeIf { it.isNotBlank() } ?: return@collect
                    val decoded = runCatching {
                        CodyJson.decodeFromString(JsonObject.serializer(), payload)
                    }.getOrNull() ?: return@collect
                    send(AgentEvent.from(decoded))
                }
            }
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (failure: Throwable) {
            throw asBackendException(failure)
        }
    }

    override fun close(): Unit = http.close()

    /** `<base>/api/<segment>/<segment>…`, each segment path-encoded. */
    private fun endpoint(vararg segments: String): String =
        segments.joinToString(separator = "/", prefix = "${config.baseUrl}/api/") { it.encodeURLPathPart() }

    private fun hostLabel(): String =
        config.baseUrl.substringAfter("://").substringBefore('/')

    /** Runs a request, turning transport failures and non-2xx into [BackendException]. */
    private suspend fun call(block: suspend () -> HttpResponse): HttpResponse {
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
                401 -> BackendFailure.Unauthorized
                403 -> BackendFailure.Forbidden
                404 -> BackendFailure.NotFound
                429 -> BackendFailure.RateLimited
                else -> BackendFailure.Server
            },
            status = response.status.value,
            code = error?.code,
            detail = error?.error?.takeIf { it.isNotBlank() },
        )
    }

    private suspend inline fun <reified T> HttpResponse.decode(): T =
        try {
            body()
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (failure: Throwable) {
            throw BackendException(
                failure = BackendFailure.Malformed,
                status = status.value,
                detail = failure.message,
                cause = failure,
            )
        }

    /**
     * `POST /api/agent/{id}` is a discriminated command envelope and the route
     * rejects a body without `type` outright (`command_type_required`, HTTP
     * 400).
     *
     * [type] therefore has NO default, and that is load-bearing rather than
     * stylistic: kotlinx.serialization omits a property whose value equals its
     * default unless `encodeDefaults` is on, so writing `val type: String =
     * "prompt"` here produces `{"message":"…"}` on the wire and every single
     * prompt 400s. A required constructor parameter is always encoded.
     */
    @Serializable
    private data class PromptCommand(
        val type: String,
        val message: String,
    )

    private companion object {
        const val REQUEST_TIMEOUT_MS = 30_000L
        const val CONNECT_TIMEOUT_MS = 10_000L
        const val SOCKET_TIMEOUT_MS = 30_000L

        /** Two server heartbeat intervals (30s) plus margin. */
        const val SSE_SOCKET_TIMEOUT_MS = 90_000L
    }
}

/**
 * Maps a transport-level throwable onto the app's failure vocabulary. Anything
 * that is not already a [BackendException] never reached a server answer, so it
 * is [BackendFailure.Unreachable] — the one message that tells the user to check
 * the address or the tail-net rather than the token.
 */
internal fun asBackendException(failure: Throwable): BackendException =
    failure as? BackendException
        ?: BackendException(
            failure = BackendFailure.Unreachable,
            detail = failure.message,
            cause = failure,
        )
