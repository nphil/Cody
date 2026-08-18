package dev.cody.shared.model

import kotlinx.serialization.Serializable

/**
 * A row of the session list — the server's `SessionInfo` (lib/types.ts) minus
 * `path`, which is a server filesystem detail no client should know about.
 */
@Serializable
public data class SessionSummary(
    public val id: String = "",
    public val cwd: String = "",
    public val name: String? = null,
    /** ISO-8601 as sent by the server; kept as text because nothing sorts on it. */
    public val created: String? = null,
    public val modified: String? = null,
    public val messageCount: Int = 0,
    public val firstMessage: String = "",
    /** Set when this session was forked from another. */
    public val parentSessionId: String? = null,
    public val projectRoot: String? = null,
    /** Branch name when [cwd] is a linked git worktree rather than the main checkout. */
    public val worktreeBranch: String? = null,
) {
    /**
     * What the list shows. Same precedence the web sidebar uses: an explicit
     * title, else the opening user message, else the bare id so a row is never
     * blank.
     */
    public val label: String
        get() = name?.takeIf { it.isNotBlank() }
            ?: firstMessage.takeIf { it.isNotBlank() && it != NO_MESSAGES }
            ?: id

    /** Repo root shared by every worktree of [cwd]; falls back to [cwd]. */
    public val root: String get() = projectRoot?.takeIf { it.isNotBlank() } ?: cwd

    /** Trailing path segment of [root] — the project name a narrow layout has room for. */
    public val projectName: String
        get() = root.trimEnd('/').substringAfterLast('/').ifEmpty { root }

    private companion object {
        const val NO_MESSAGES = "(no messages)"
    }
}

/** Response body of `GET /api/sessions`. */
@Serializable
public data class SessionListPage(
    public val sessions: List<SessionSummary> = emptyList(),
    /** Sessions with a live engine process right now. */
    public val runningSessionIds: List<String> = emptyList(),
)

/** Response body of `GET /api/sessions/{id}`. */
@Serializable
public data class SessionTranscript(
    public val sessionId: String = "",
    public val info: SessionSummary = SessionSummary(),
    /** Entry id of the branch tip this transcript was projected from. */
    public val leafId: String? = null,
    public val context: SessionContext = SessionContext(),
)

@Serializable
public data class SessionContext(
    @Serializable(with = ChatMessagesSerializer::class)
    public val messages: List<ChatMessage> = emptyList(),
    /** Parallel to [messages]: the session entry id behind each one. */
    public val entryIds: List<String> = emptyList(),
    public val thinkingLevel: String = "",
)
