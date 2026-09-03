#!/usr/bin/env node
/**
 * A model provider that needs no account.
 *
 * Every engine Cody drives can be pointed at an OpenAI-compatible endpoint
 * (omp and pi through a custom provider, Hermes through its `custom`
 * provider, Codex through a `model_provider` with `wire_api = "chat"`), and
 * Claude Code at an Anthropic-compatible one through ANTHROPIC_BASE_URL. This
 * serves both dialects with a canned, streamed reply, so a turn can run all
 * the way through Cody — spawn, RPC or ACP, streaming, transcript, sidebar —
 * on a machine with no credentials at all. That is what a release gate needs:
 * the engine bring-up proves each engine STARTS; this proves each engine can
 * finish a turn.
 *
 * The reply always contains MOCK_REPLY_MARKER, so a caller can prove the
 * text on screen came from here and not from a cached transcript.
 *
 * Usage: node scripts/mock-model-server.mjs [--port 30190]
 */
import { createServer } from "node:http";

export const MOCK_REPLY_MARKER = "MOCK-TURN-OK";
const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 30190) || 30190;
const MODEL = "mock-1";

/** Echo the last user message back so the reply is visibly about the prompt. */
function replyFor(lastUser) {
  const brief = String(lastUser ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${MOCK_REPLY_MARKER}: you said "${brief}"`;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join(" ");
  }
  return "";
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}

const sse = (res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  return (event, data) => res.write((event ? `event: ${event}\n` : "") + `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
};

/** OpenAI chat completions: streamed deltas or one JSON body. */
async function chatCompletions(req, res, body) {
  const text = replyFor(lastUserText(body.messages ?? []));
  const id = `chatcmpl-${Date.now()}`;
  const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
  if (!body.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model ?? MODEL, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }));
    return;
  }
  const write = sse(res);
  const chunk = (delta, finish = null) => write(null, { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? MODEL, choices: [{ index: 0, delta, finish_reason: finish }] });
  chunk({ role: "assistant", content: "" });
  for (const word of text.split(/(?<= )/)) { chunk({ content: word }); await new Promise((r) => setTimeout(r, 15)); }
  chunk({}, "stop");
  write(null, { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? MODEL, choices: [], usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

/** OpenAI Responses API (Codex's default wire), streamed or not. */
async function responses(req, res, body) {
  const input = Array.isArray(body.input) ? body.input : [{ role: "user", content: String(body.input ?? "") }];
  const text = replyFor(lastUserText(input));
  const id = `resp_${Date.now()}`;
  const message = { id: `msg_${Date.now()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const response = { id, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: body.model ?? MODEL, output: [message], usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 } };
  if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(response)); return; }
  const write = sse(res);
  write("response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } });
  write("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } });
  write("response.content_part.added", { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: message.id, part: { type: "output_text", text: "" } });
  for (const word of text.split(/(?<= )/)) { write("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: message.id, delta: word }); await new Promise((r) => setTimeout(r, 15)); }
  write("response.output_text.done", { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: message.id, text });
  write("response.content_part.done", { type: "response.content_part.done", output_index: 0, content_index: 0, item_id: message.id, part: { type: "output_text", text } });
  write("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: message });
  write("response.completed", { type: "response.completed", response });
  res.end();
}

/** Anthropic Messages API, streamed or not. */
async function anthropicMessages(req, res, body) {
  const text = replyFor(lastUserText(body.messages ?? []));
  const id = `msg_${Date.now()}`;
  const usage = { input_tokens: 12, output_tokens: 8 };
  if (!body.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model ?? MODEL, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage }));
    return;
  }
  const write = sse(res);
  write("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model ?? MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } });
  write("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const word of text.split(/(?<= )/)) { write("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word } }); await new Promise((r) => setTimeout(r, 15)); }
  write("content_block_stop", { type: "content_block_stop", index: 0 });
  write("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } });
  write("message_stop", { type: "message_stop" });
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://mock");
  const path = url.pathname.replace(/\/+$/, "");
  // One line per request, so a caller can see what an engine asked for on
  // its way to a turn — an unexpected 404 here is usually why a CLI stalls.
  res.on("finish", () => console.log(`${new Date().toISOString()} ${req.method} ${path} -> ${res.statusCode}`));
  try {
    if (req.method === "GET" && /\/models$/.test(path)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "cody-mock" }] }));
      return;
    }
    if (req.method === "POST" && /\/chat\/completions$/.test(path)) return await chatCompletions(req, res, await readJson(req));
    if (req.method === "POST" && /\/responses$/.test(path)) return await responses(req, res, await readJson(req));
    if (req.method === "POST" && /\/messages$/.test(path)) return await anthropicMessages(req, res, await readJson(req));
    if (req.method === "POST" && /\/messages\/count_tokens$/.test(path)) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ input_tokens: 12 })); return; }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `mock: no route for ${req.method} ${path}` } }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(error) } }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock model server on http://127.0.0.1:${port} (model "${MODEL}", marker ${MOCK_REPLY_MARKER})`);
});
