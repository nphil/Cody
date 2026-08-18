package dev.cody.shared.backend

import dev.cody.shared.model.AgentEvent
import dev.cody.shared.model.ServerCapabilities
import dev.cody.shared.model.SessionListPage
import dev.cody.shared.model.SessionTranscript
import kotlinx.coroutines.flow.Flow

/**
 * Which brain the user is talking to. The architecture brief requires this to be
 * visible at all times, never inferred and never silently switched, so it is a
 * property of the backend itself rather than a setting somewhere.
 */
public enum class BackendKind { Remote, Local }

/**
 * What a backend can actually do. Screens gate on these instead of on
 * `kind == Remote`, which is what lets a future `LocalBackend` report a smaller
 * set and have the UI hide the right things without touching a single screen.
 */
public data class BackendCapabilities(
    /** Can list and open sessions at all. */
    public val sessions: Boolean = false,
    /** Can stream live agent events for a running session. */
    public val liveEvents: Boolean = false,
    /** Can submit a prompt. */
    public val prompts: Boolean = false,
    public val models: Boolean = false,
    public val skills: Boolean = false,
    public val plugins: Boolean = false,
    public val mcp: Boolean = false,
    public val chatExtras: Boolean = false,
    public val engineSettings: Boolean = false,
    public val updates: Boolean = false,
) {
    public companion object {
        /**
         * What a reachable, authenticated server is assumed to support when
         * `GET /api/info` could not be read.
         *
         * Clamp, do not bail: sessions and chat live on their own routes and are
         * the reason the app exists, so an unreadable capability report hides
         * the extras and keeps the core working rather than presenting an empty
         * app. Mirrors how the streamed-display work treats a bad viewport.
         */
        public val Core: BackendCapabilities =
            BackendCapabilities(sessions = true, liveEvents = true, prompts = true)

        /** Derived from the server's active-engine capability report. */
        public fun fromServer(capabilities: ServerCapabilities): BackendCapabilities =
            BackendCapabilities(
                sessions = true,
                liveEvents = capabilities.liveSessions,
                prompts = true,
                models = capabilities.models,
                skills = capabilities.skills,
                plugins = capabilities.plugins,
                mcp = capabilities.mcp,
                chatExtras = capabilities.chatExtras,
                engineSettings = capabilities.nativeSettings,
                updates = capabilities.updates,
            )
    }
}

/** Who and what the app is connected to; drives the persistent badge. */
public data class BackendIdentity(
    public val kind: BackendKind,
    /** Host of the remote server, or the device name for a local backend. */
    public val label: String,
    public val codyVersion: String,
    /** Display name of the engine the server has active, empty if unreported. */
    public val engineName: String,
    public val username: String?,
    public val capabilities: BackendCapabilities,
)

/**
 * The seam the whole app is written against.
 *
 * Screens and presentation models depend on THIS and never on Ktor, HTTP, SSE or
 * a URL — that rule is what makes the offline `LocalBackend` a drop-in later
 * rather than a rewrite. Every method throws [BackendException] and nothing
 * else.
 */
public interface CodyBackend {
    public val kind: BackendKind

    /** Round-trips the credential and reports what this backend can do. */
    public suspend fun identify(): BackendIdentity

    public suspend fun listSessions(): SessionListPage

    public suspend fun loadTranscript(sessionId: String): SessionTranscript

    /** Submits a prompt. Starts the engine for [sessionId] if it is not running. */
    public suspend fun sendPrompt(sessionId: String, text: String)

    /**
     * Live frames for one session.
     *
     * CALLER BEWARE, and this is a property of the server rather than of this
     * interface: subscribing to a session whose engine is not already running
     * STARTS it (`app/api/agent/[id]/events/route.ts` calls `startRpcSession`
     * when no live session exists). Collect this only for a session already
     * reported in [SessionListPage.runningSessionIds], or straight after
     * [sendPrompt], which spawns the engine anyway. Opening it merely to look at
     * an idle session would spin up an engine process per tap.
     */
    public fun events(sessionId: String): Flow<AgentEvent>

    /** Releases the transport. The instance is unusable afterwards. */
    public fun close()
}
