package dev.cody.shared

import dev.cody.shared.model.ChatMessage
import dev.cody.shared.model.CodyJson
import dev.cody.shared.model.ContentBlock
import dev.cody.shared.model.SessionListPage
import dev.cody.shared.model.SessionTranscript
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The wire format, pinned.
 *
 * Every payload below is the shape `docs/api.md` documents for the route named
 * in the test. These run on the `jvm()` target with no emulator, which is the
 * reason that target exists at all.
 *
 * What these defend is specifically the FORWARD-COMPATIBILITY contract: this app
 * ships on its own release train and will routinely be talking to a newer server
 * than it was built against. Two failure modes matter and neither shows up in a
 * type checker — a field the server added blowing up decoding, and a message
 * kind the server added taking the whole transcript down with it.
 */
class WireFormatTest {

    @Test
    fun `session list decodes and separates running sessions`() {
        val page = CodyJson.decodeFromString<SessionListPage>(
            """
            {
              "sessions": [
                {
                  "id": "s-1",
                  "cwd": "/root/work/cody",
                  "name": "Android client",
                  "modified": "2026-08-18T04:00:00.000Z",
                  "messageCount": 12,
                  "firstMessage": "port the sidebar",
                  "projectRoot": "/root/work/cody"
                },
                { "id": "s-2", "cwd": "/root/scratch", "firstMessage": "(no messages)" }
              ],
              "runningSessionIds": ["s-1"]
            }
            """.trimIndent(),
        )

        assertEquals(2, page.sessions.size)
        assertEquals(listOf("s-1"), page.runningSessionIds)

        // label precedence: explicit name, else opening message, else the id.
        assertEquals("Android client", page.sessions[0].label)
        assertEquals("cody", page.sessions[0].projectName)
        // "(no messages)" is the server's placeholder, not a title.
        assertEquals("s-2", page.sessions[1].label)
    }

    @Test
    fun `a newer server's unknown fields do not break decoding`() {
        val page = CodyJson.decodeFromString<SessionListPage>(
            """
            {
              "sessions": [
                { "id": "s-1", "cwd": "/w", "somethingAddedNextYear": { "nested": [1, 2] } }
              ],
              "runningSessionIds": [],
              "pagination": { "cursor": "abc" }
            }
            """.trimIndent(),
        )
        assertEquals("s-1", page.sessions.single().id)
    }

    @Test
    fun `an older server's missing fields fall back to defaults`() {
        // Every property has a default precisely so this decodes rather than
        // throwing on the first absent key.
        val page = CodyJson.decodeFromString<SessionListPage>("""{"sessions":[{"id":"s-1"}]}""")
        val session = page.sessions.single()
        assertEquals("", session.cwd)
        assertEquals(0, session.messageCount)
        assertTrue(page.runningSessionIds.isEmpty())
    }

    @Test
    fun `transcript accepts both the string and the block-array content shapes`() {
        val transcript = CodyJson.decodeFromString<SessionTranscript>(
            """
            {
              "sessionId": "s-1",
              "info": { "id": "s-1", "cwd": "/w", "name": "T" },
              "context": {
                "messages": [
                  { "role": "user", "content": "just a string", "timestamp": 1 },
                  { "role": "assistant", "content": [
                      { "type": "text", "text": "block form" },
                      { "type": "toolCall", "toolCallId": "t1", "toolName": "bash",
                        "input": { "command": "ls" } }
                  ], "timestamp": 2 }
                ],
                "entryIds": ["e1", "e2"]
              }
            }
            """.trimIndent(),
        )

        val user = assertIs<ChatMessage.User>(transcript.context.messages[0])
        assertEquals("just a string", user.content.text)

        val assistant = assertIs<ChatMessage.Assistant>(transcript.context.messages[1])
        assertEquals("block form", assistant.content.text)
        val call = assistant.content.blocks.filterIsInstance<ContentBlock.ToolCall>().single()
        assertEquals("bash", call.toolName)
        assertEquals("t1", call.toolCallId)
    }

    @Test
    fun `an unrecognised role degrades to Unknown without losing the rest`() {
        // The whole point of ChatMessagesSerializer. If this regresses, one new
        // server-side message kind blanks the entire transcript on an installed
        // client.
        val transcript = CodyJson.decodeFromString<SessionTranscript>(
            """
            {
              "context": {
                "messages": [
                  { "role": "user", "content": "before" },
                  { "role": "somethingNew", "payload": { "a": 1 } },
                  { "role": "assistant", "content": "after" }
                ],
                "entryIds": ["e1", "e2", "e3"]
              }
            }
            """.trimIndent(),
        )

        assertEquals(3, transcript.context.messages.size)
        assertIs<ChatMessage.User>(transcript.context.messages[0])
        assertIs<ChatMessage.Unknown>(transcript.context.messages[1])
        val after = assertIs<ChatMessage.Assistant>(transcript.context.messages[2])
        assertEquals("after", after.content.text)
    }

    @Test
    fun `an unrecognised content block degrades to Unknown without losing its siblings`() {
        val transcript = CodyJson.decodeFromString<SessionTranscript>(
            """
            {
              "context": { "messages": [
                { "role": "assistant", "content": [
                    { "type": "text", "text": "kept" },
                    { "type": "somethingNew", "whatever": true }
                ] }
              ] }
            }
            """.trimIndent(),
        )

        val blocks = assertIs<ChatMessage.Assistant>(transcript.context.messages.single()).content.blocks
        assertEquals(2, blocks.size)
        assertEquals("kept", assertIs<ContentBlock.Text>(blocks[0]).text)
        assertEquals("somethingNew", assertIs<ContentBlock.Unknown>(blocks[1]).kind)
    }

    @Test
    fun `deferred thinking and both image shapes decode`() {
        // loadTranscript asks for deferThinking=1 and deferMedia=1, so these are
        // the shapes the app actually receives, not the inline ones.
        val transcript = CodyJson.decodeFromString<SessionTranscript>(
            """
            {
              "context": { "messages": [
                { "role": "assistant", "content": [
                    { "type": "thinking", "thinking": "", "deferred": true }
                ] },
                { "role": "toolResult", "toolCallId": "t1", "content": [
                    { "type": "image", "mimeType": "image/png", "data": "AAAA" }
                ] },
                { "role": "toolResult", "toolCallId": "t2", "content": [
                    { "type": "image",
                      "source": { "type": "base64", "media_type": "image/jpeg", "data": "BBBB" } }
                ] }
              ] }
            }
            """.trimIndent(),
        )

        val thinking = assertIs<ContentBlock.Thinking>(
            assertIs<ChatMessage.Assistant>(transcript.context.messages[0]).content.blocks.single(),
        )
        assertTrue(thinking.deferred)

        // Flat shape.
        val flat = assertIs<ContentBlock.Image>(
            assertIs<ChatMessage.ToolResult>(transcript.context.messages[1]).content.blocks.single(),
        )
        assertEquals("image/png", flat.effectiveMimeType)
        assertEquals("AAAA", flat.base64)

        // Legacy nested shape; same accessors must answer.
        val nested = assertIs<ContentBlock.Image>(
            assertIs<ChatMessage.ToolResult>(transcript.context.messages[2]).content.blocks.single(),
        )
        assertEquals("image/jpeg", nested.effectiveMimeType)
        assertEquals("BBBB", nested.base64)
    }

    @Test
    fun `a custom message the server marks undisplayable is still decoded`() {
        // ChatModel drops these at render time; decoding must not, or the
        // entryIds list stops lining up with the messages list.
        val transcript = CodyJson.decodeFromString<SessionTranscript>(
            """
            {"context":{"messages":[
              {"role":"custom","customType":"compactionMarker","content":"x","display":false}
            ]}}
            """.trimIndent(),
        )
        val custom = assertIs<ChatMessage.Custom>(transcript.context.messages.single())
        assertEquals("compactionMarker", custom.customType)
        assertEquals(false, custom.display)
    }
}
