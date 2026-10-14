import { createServer } from "node:http";

/**
 * One local HTTP server standing in for everything a real omp run talks to in the Claude-credits
 * scenarios — so that the assertions can be about what the FAKE OBSERVED, in order:
 *
 *  - `POST /v1/messages`, the Anthropic Messages API. A request is told apart by its credential:
 *    a plan account's OAuth bearer (`sk-ant-oat…`, labelled by its last character) or a credits
 *    API key (`sk-ant-api…`, labelled by its last four characters). omp sends an API key as
 *    `X-Api-Key` to the official URL but as `Authorization: Bearer` to any other base URL, so
 *    both are read. Each plan account either answers (200, a server-sent-event stream) or is
 *    over its limit (429 with the headers omp reads a limit from); each credits key either
 *    answers or is out of credit (the configured failure).
 *  - `GET /api/oauth/usage`, the plan's usage report omp ranks accounts by (it follows the
 *    provider's base URL).
 *  - `POST /openai/v1/chat/completions`, an OpenAI-compatible stand-in for "any other provider":
 *    a Codex, an OpenRouter, a local model. Any request it receives in a credits scenario means
 *    omp went past the credits.
 *
 * Nothing here reaches beyond 127.0.0.1.
 */

export const STAND_IN_TEXT = "HELLO FROM THE STAND-IN PROVIDER";
export const planText = (account) => `HELLO FROM THE PLAN (${account})`;
export const creditsText = (key) => `HELLO FROM THE API CREDITS (${key})`;

/** What Anthropic answers with when an API key's credit balance is gone: a 400, `invalid_request_error`. */
export const ANTHROPIC_CREDIT_BALANCE_FAILURE = {
  status: 400,
  type: "invalid_request_error",
  message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
};

const stream = (res, model, text) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } });
  send("message_stop", { type: "message_stop" });
  res.end();
};

/** A plan account's 429: the unified rate-limit headers omp reads, and a `retry-after` that sets its cooldown. */
function planLimited(res, retryAfterSeconds) {
  const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
  res.writeHead(429, {
    "content-type": "application/json",
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String(reset),
    "anthropic-ratelimit-unified-reset": String(reset),
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "retry-after": String(retryAfterSeconds),
  });
  res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." }, request_id: "req_fake_limit" }));
}

/**
 * @param {object} [options]
 * @param {Record<string, "ok"|"limited">} [options.plans]   Per plan account label (the last character of its token), what /v1/messages answers.
 * @param {Record<string, number|"auto">} [options.usage]    Per plan account, the utilisation its usage report shows; "auto" = 100 when limited, 12 when not.
 * @param {Record<string, "ok"|"exhausted">} [options.credits] Per credits key label (its last four characters).
 * @param {{status:number,type:string,message:string}} [options.creditsFailure] What an exhausted key answers.
 * @param {number} [options.retryAfter] Seconds in a plan's `retry-after`: omp's cooldown for the account.
 */
export async function startFakeAnthropic({ plans = {}, usage = {}, credits = {}, creditsFailure = ANTHROPIC_CREDIT_BALANCE_FAILURE, retryAfter = 10800 } = {}) {
  const state = { plans: { ...plans }, usage: { ...usage }, credits: { ...credits }, creditsFailure, retryAfter };
  const log = [];

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://fake");
    const authorization = req.headers.authorization ? String(req.headers.authorization) : null;
    const apiKeyHeader = req.headers["x-api-key"] ? String(req.headers["x-api-key"]) : null;
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const credential = apiKeyHeader ?? bearer;
    let parsed = null;
    try { parsed = body ? JSON.parse(body) : null; } catch { /* not JSON */ }

    let kind = "other";
    let who = null;
    if (url.pathname.startsWith("/openai/")) kind = "standin";
    else if (credential?.startsWith("sk-ant-oat")) { kind = "plan"; who = credential.slice(-1); }
    else if (credential?.startsWith("sk-ant-api")) { kind = "credits"; who = credential.slice(-4); }
    const entry = {
      seq: log.length,
      at: Date.now(),
      method: req.method,
      path: url.pathname,
      kind,
      who,
      model: parsed?.model ?? null,
      // How the credential arrived, for the tests that care (an API key is `x-api-key` on the official URL only).
      via: apiKeyHeader ? "x-api-key" : bearer ? "authorization" : "none",
      status: null,
    };
    log.push(entry);
    const finish = (status) => { entry.status = status; };

    if (url.pathname === "/api/oauth/usage") {
      const label = bearer?.startsWith("sk-ant-oat") ? bearer.slice(-1) : null;
      const limited = label !== null && state.plans[label] === "limited";
      const configured = label === null ? undefined : state.usage[label];
      const five = configured === undefined || configured === "auto" ? (limited ? 100 : 12) : configured;
      finish(200);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        five_hour: { utilization: five, resets_at: new Date(Date.now() + 3 * 3600e3).toISOString() },
        seven_day: { utilization: Math.min(five, 61), resets_at: new Date(Date.now() + 4 * 86400e3).toISOString() },
      }));
      return;
    }

    if (url.pathname === "/v1/messages" && req.method === "POST") {
      if (kind === "plan") {
        if ((state.plans[who] ?? "ok") === "limited") { finish(429); planLimited(res, state.retryAfter); return; }
        finish(200);
        stream(res, parsed?.model ?? "claude-opus-5-5", planText(who));
        return;
      }
      if (kind === "credits") {
        if ((state.credits[who] ?? "ok") === "exhausted") {
          const failure = state.creditsFailure;
          finish(failure.status);
          res.writeHead(failure.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: failure.type, message: failure.message }, request_id: "req_fake_credits" }));
          return;
        }
        finish(200);
        stream(res, parsed?.model ?? "claude-opus-5-5", creditsText(who));
        return;
      }
      finish(401);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      return;
    }

    if (url.pathname === "/openai/v1/chat/completions") {
      finish(200);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: STAND_IN_TEXT }, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }

    finish(404);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not served by the fake", path: url.pathname }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const answered = (entry) => entry.method === "POST" && (entry.path === "/v1/messages" || entry.path === "/openai/v1/chat/completions");

  return {
    baseUrl,
    /** The stand-in provider's own base URL (OpenAI-compatible). */
    standInUrl: `${baseUrl}/openai/v1`,
    state,
    log,
    /** Every model request, in the order the fake saw them: plan, credits or stand-in. */
    requests: () => log.filter(answered),
    /** One line per model request, for a failure message. */
    describe: () => log.filter(answered).map((entry) => `#${entry.seq} ${entry.kind}${entry.who ? `:${entry.who}` : ""} ${entry.path} → ${entry.status} (${entry.via})`).join("\n") || "(no model request)",
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
