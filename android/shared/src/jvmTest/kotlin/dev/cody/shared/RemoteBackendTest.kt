package dev.cody.shared

import dev.cody.shared.backend.BackendException
import dev.cody.shared.backend.BackendFailure
import dev.cody.shared.backend.RemoteBackend
import dev.cody.shared.backend.ServerConfig
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The transport contract, pinned against `docs/api.md`.
 *
 * The 401 body below is not invented: it is byte-for-byte what a live Cody
 * server answers on `/api/accounts/me` without a credential, and `docs/api.md`
 * documents it as the response for ANY dead credential — absent, invalid,
 * revoked, expired, or belonging to a deleted account. The client must not try
 * to tell those apart, and these tests are what stops someone adding a
 * challenge/retry dance that the server has no `WWW-Authenticate` header to
 * support.
 */
class RemoteBackendTest {

    private val config = ServerConfig(baseUrl = "http://cody.test:30177", token = "cody_pat_secret")

    private fun jsonEngine(status: HttpStatusCode, body: String) = MockEngine {
        respond(
            content = body,
            status = status,
            headers = headersOf(HttpHeaders.ContentType, "application/json"),
        )
    }

    @Test
    fun `401 auth_required surfaces as Unauthorized with the server's own code`() = runTest {
        val engine = jsonEngine(
            HttpStatusCode.Unauthorized,
            """{"error":"Authentication required","code":"auth_required"}""",
        )
        val backend = RemoteBackend(config, engine)

        val failure = assertFailsWith<BackendException> { backend.listSessions() }
        assertEquals(BackendFailure.Unauthorized, failure.failure)
        assertEquals(401, failure.status)
        assertEquals("auth_required", failure.code)
        assertEquals("Authentication required", failure.detail)

        backend.close()
    }

    @Test
    fun `every request presents the bearer token and asks for json`() = runTest {
        val engine = jsonEngine(HttpStatusCode.OK, """{"sessions":[],"runningSessionIds":[]}""")
        val backend = RemoteBackend(config, engine)

        backend.listSessions()

        val request = engine.requestHistory.single()
        assertEquals("Bearer cody_pat_secret", request.headers[HttpHeaders.Authorization])
        assertTrue(request.headers[HttpHeaders.Accept].orEmpty().contains("application/json"))
        assertEquals("http://cody.test:30177/api/sessions", request.url.toString())

        backend.close()
    }

    @Test
    fun `status codes map onto the failure vocabulary the UI switches on`() = runTest {
        val cases = mapOf(
            HttpStatusCode.Forbidden to BackendFailure.Forbidden,
            HttpStatusCode.NotFound to BackendFailure.NotFound,
            HttpStatusCode.TooManyRequests to BackendFailure.RateLimited,
            HttpStatusCode.InternalServerError to BackendFailure.Server,
            HttpStatusCode.BadGateway to BackendFailure.Server,
        )
        for ((status, expected) in cases) {
            val backend = RemoteBackend(config, jsonEngine(status, """{"error":"nope"}"""))
            val failure = assertFailsWith<BackendException> { backend.listSessions() }
            assertEquals(expected, failure.failure, "HTTP ${status.value}")
            assertEquals(status.value, failure.status)
            backend.close()
        }
    }

    @Test
    fun `a non-json error body still yields the right failure`() = runTest {
        // A reverse proxy in front of Cody answers with HTML, not the documented
        // envelope. The status still has to drive the failure.
        val engine = MockEngine {
            respond(
                content = "<html><body>502 Bad Gateway</body></html>",
                status = HttpStatusCode.BadGateway,
                headers = headersOf(HttpHeaders.ContentType, "text/html"),
            )
        }
        val backend = RemoteBackend(config, engine)

        val failure = assertFailsWith<BackendException> { backend.listSessions() }
        assertEquals(BackendFailure.Server, failure.failure)
        assertNull(failure.code)

        backend.close()
    }

    @Test
    fun `a 2xx whose body does not decode is Malformed, not Server`() = runTest {
        // The distinction matters to the user: Server means "the box is unhappy",
        // Malformed means "this client and that server disagree", and only one of
        // those is worth retrying.
        val engine = jsonEngine(HttpStatusCode.OK, """{"sessions": "not-an-array"}""")
        val backend = RemoteBackend(config, engine)

        val failure = assertFailsWith<BackendException> { backend.listSessions() }
        assertEquals(BackendFailure.Malformed, failure.failure)
        assertEquals(200, failure.status)

        backend.close()
    }

    @Test
    fun `a transport error that never reached the server is Unreachable`() = runTest {
        val engine = MockEngine { throw java.io.IOException("no route to host") }
        val backend = RemoteBackend(config, engine)

        val failure = assertFailsWith<BackendException> { backend.listSessions() }
        assertEquals(BackendFailure.Unreachable, failure.failure)
        assertNull(failure.status)

        backend.close()
    }

    @Test
    fun `loadTranscript defers thinking bodies and media`() = runTest {
        // Not cosmetic: without these the server inlines every thinking block and
        // every tool-result image, which is megabytes over a tail-net link.
        val engine = jsonEngine(HttpStatusCode.OK, """{"sessionId":"s-1","context":{"messages":[]}}""")
        val backend = RemoteBackend(config, engine)

        backend.loadTranscript("s-1")

        val url = engine.requestHistory.single().url
        assertEquals("1", url.parameters["deferThinking"])
        assertEquals("1", url.parameters["deferMedia"])
        assertEquals("/api/sessions/s-1", url.encodedPath)

        backend.close()
    }

    @Test
    fun `session ids are path-encoded rather than pasted into the url`() = runTest {
        val engine = jsonEngine(HttpStatusCode.OK, """{"context":{"messages":[]}}""")
        val backend = RemoteBackend(config, engine)

        backend.loadTranscript("weird id/../etc")

        // The slash and the space must survive as ONE path segment; if they do
        // not, a session id becomes a path traversal.
        assertEquals("/api/sessions/weird%20id%2F..%2Fetc", engine.requestHistory.single().url.encodedPath)

        backend.close()
    }

    @Test
    fun `sendPrompt posts the prompt command shape the agent route expects`() = runTest {
        val engine = jsonEngine(HttpStatusCode.OK, """{"ok":true}""")
        val backend = RemoteBackend(config, engine)

        backend.sendPrompt("s-1", "hello")

        val request = engine.requestHistory.single()
        assertEquals("POST", request.method.value)
        assertEquals("/api/agent/s-1", request.url.encodedPath)
        val body = (request.body as io.ktor.http.content.TextContent).text
        assertTrue(body.contains(""""type":"prompt""""), body)
        assertTrue(body.contains(""""message":"hello""""), body)

        backend.close()
    }

    @Test
    fun `identify falls back to core capabilities when info cannot be read`() = runTest {
        // accounts/me succeeds, info 500s. A server that cannot describe itself is
        // still perfectly able to serve sessions, so the app must clamp rather
        // than present every screen as unavailable.
        var call = 0
        val engine = MockEngine { request ->
            call++
            if (request.url.encodedPath.endsWith("/accounts/me")) {
                respond(
                    content = """{"user":{"id":"u1","username":"nphil","role":"admin"}}""",
                    status = HttpStatusCode.OK,
                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                )
            } else {
                respond(
                    content = """{"error":"boom"}""",
                    status = HttpStatusCode.InternalServerError,
                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                )
            }
        }
        val backend = RemoteBackend(config, engine)

        val identity = backend.identify()
        assertEquals("nphil", identity.username)
        assertEquals("cody.test:30177", identity.label)
        assertEquals("", identity.codyVersion)
        assertTrue(identity.capabilities.sessions)
        assertTrue(identity.capabilities.prompts)
        // Extras stay off: nothing said they were available.
        assertEquals(false, identity.capabilities.models)
        assertEquals(2, call)

        backend.close()
    }

    @Test
    fun `identify reports the capabilities the server actually declared`() = runTest {
        val engine = MockEngine { request ->
            val body = if (request.url.encodedPath.endsWith("/accounts/me")) {
                """{"user":{"id":"u1","username":"nphil"}}"""
            } else {
                """
                {"codyVersion":"1.4.2","engine":{"displayName":"Test Engine"},
                 "capabilities":{"liveSessions":true,"models":true,"mcp":false}}
                """.trimIndent()
            }
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val backend = RemoteBackend(config, engine)

        val identity = backend.identify()
        assertEquals("1.4.2", identity.codyVersion)
        assertEquals("Test Engine", identity.engineName)
        assertTrue(identity.capabilities.liveEvents)
        assertTrue(identity.capabilities.models)
        assertEquals(false, identity.capabilities.mcp)

        backend.close()
    }
}

/** What someone can type into the address box on a tablet, and what it becomes. */
class ServerConfigTest {

    @Test
    fun `a bare host or host-port defaults to http`() {
        // Cody on a tail-net is plain HTTP far more often than not, and the
        // address is typed once on a touch keyboard.
        assertEquals("http://box", ServerConfig.normalizeBaseUrl("box"))
        assertEquals("http://box:30177", ServerConfig.normalizeBaseUrl("box:30177"))
        assertEquals("http://100.64.0.1:30177", ServerConfig.normalizeBaseUrl("  100.64.0.1:30177  "))
    }

    @Test
    fun `an explicit scheme and a proxy path prefix are preserved`() {
        assertEquals("https://cody.example", ServerConfig.normalizeBaseUrl("https://cody.example/"))
        assertEquals("https://box/cody", ServerConfig.normalizeBaseUrl("https://box/cody/"))
    }

    @Test
    fun `a default port is dropped so two spellings of one origin agree`() {
        assertEquals("https://cody.example", ServerConfig.normalizeBaseUrl("https://cody.example:443"))
        assertEquals("http://cody.example", ServerConfig.normalizeBaseUrl("http://cody.example:80"))
    }

    @Test
    fun `input that cannot be an origin is rejected rather than guessed at`() {
        assertNull(ServerConfig.normalizeBaseUrl(""))
        assertNull(ServerConfig.normalizeBaseUrl("   "))
        assertNull(ServerConfig.normalizeBaseUrl("ftp://box"))
        assertNull(ServerConfig.normalizeBaseUrl("file:///etc/passwd"))
    }
}
