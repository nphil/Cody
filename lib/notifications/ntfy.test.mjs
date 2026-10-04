import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The client against a real HTTP server on loopback, so what is pinned is the
 * request ntfy would actually receive — method, path, headers, body — not a
 * mock's idea of it.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const ntfy = await jiti.import("./ntfy.ts");

/** A server that records every request and answers with `respond(request, response, body)`. */
async function serve(respond) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: request.method, path: request.url, headers: request.headers, body });
      respond(request, response, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const accepted = (_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ id: "msgid123", time: 1, event: "message", topic: "t", message: "m" }));
};

const message = {
  title: "Approval needed · Fix login",
  message: "Tool: bash\nrm -rf build",
  priority: 4,
  tags: ["lock", "my-project"],
};

test("publish is one JSON POST to the server ROOT, with ntfy's own field names", async () => {
  const server = await serve(accepted);
  try {
    const result = await ntfy.publishNtfy({ server: server.url, topic: "alerts", token: "" }, message);
    assert.deepEqual(result, { ok: true });
    assert.equal(server.requests.length, 1);
    const [request] = server.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/", "the root url, not /alerts");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.authorization, undefined, "no token, no Authorization");
    assert.deepEqual(JSON.parse(request.body), {
      topic: "alerts",
      title: "Approval needed · Fix login",
      message: "Tool: bash\nrm -rf build",
      priority: 4,
      tags: ["lock", "my-project"],
    });
  } finally {
    await server.close();
  }
});

test("a token goes out as a Bearer header and nowhere in the body", async () => {
  const server = await serve(accepted);
  try {
    await ntfy.publishNtfy({ server: server.url, topic: "alerts", token: "tk_secret123" }, message);
    const [request] = server.requests;
    assert.equal(request.headers.authorization, "Bearer tk_secret123");
    assert.equal(request.body.includes("tk_secret123"), false);
  } finally {
    await server.close();
  }
});

test("click, actions and the sequence id travel under ntfy's names; unset extras are left out", async () => {
  const server = await serve(accepted);
  try {
    const actions = [
      { action: "http", label: "Allow", url: "https://cody.example.net/api/notifications/action", method: "POST", headers: { "Content-Type": "application/json" }, body: '{"t":"abc"}', clear: true },
      { action: "view", label: "Open Cody", url: "https://cody.example.net" },
    ];
    await ntfy.publishNtfy(
      { server: server.url, topic: "alerts", token: "" },
      { ...message, click: "https://cody.example.net/?session=s1", actions, sequenceId: "cody-0123456789abcdef01234567" },
    );
    const body = JSON.parse(server.requests[0].body);
    assert.equal(body.click, "https://cody.example.net/?session=s1");
    assert.deepEqual(body.actions, actions);
    assert.equal(body.sequence_id, "cody-0123456789abcdef01234567");
    assert.equal("sequenceId" in body, false, "ntfy's field is sequence_id");

    await ntfy.publishNtfy({ server: server.url, topic: "alerts", token: "" }, { ...message, actions: [] });
    const bare = JSON.parse(server.requests[1].body);
    for (const absent of ["click", "actions", "sequence_id", "markdown", "attach", "delay", "email"]) {
      assert.equal(absent in bare, false, `${absent} is not sent unless set`);
    }
  } finally {
    await server.close();
  }
});

test("quotes, newlines and non-ASCII text survive the round trip", async () => {
  const server = await serve(accepted);
  try {
    const tricky = { ...message, title: 'He said "go" — 日本語 🚀', message: "line one\nline \\ two\t\"three\"" };
    await ntfy.publishNtfy({ server: server.url, topic: "alerts", token: "" }, tricky);
    const body = JSON.parse(server.requests[0].body);
    assert.equal(body.title, tricky.title);
    assert.equal(body.message, tricky.message);
  } finally {
    await server.close();
  }
});

test("clear is a PUT to /<topic>/<sequence id>/clear, authenticated, with no body", async () => {
  const server = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "clr1", event: "message_clear", topic: "alerts", sequence_id: "cody-abc" }));
  });
  try {
    const result = await ntfy.clearNtfy({ server: server.url, topic: "alerts", token: "tk_abc" }, "cody-abc");
    assert.deepEqual(result, { ok: true });
    const [request] = server.requests;
    assert.equal(request.method, "PUT");
    assert.equal(request.path, "/alerts/cody-abc/clear");
    assert.equal(request.headers.authorization, "Bearer tk_abc");
    assert.equal(request.body, "");
  } finally {
    await server.close();
  }
});

test("a server under a path prefix keeps it for both calls", async () => {
  const server = await serve(accepted);
  try {
    await ntfy.publishNtfy({ server: `${server.url}/ntfy`, topic: "alerts", token: "" }, message);
    await ntfy.clearNtfy({ server: `${server.url}/ntfy`, topic: "alerts", token: "" }, "cody-x");
    assert.deepEqual(server.requests.map((r) => `${r.method} ${r.path}`), ["POST /ntfy/", "PUT /ntfy/alerts/cody-x/clear"]);
  } finally {
    await server.close();
  }
});

test("ntfy's own refusal is reported in ntfy's own words, with the status", async () => {
  const server = await serve((_request, response) => {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 40301, http: 403, error: "forbidden", link: "https://ntfy.sh/docs/publish/#authentication" }));
  });
  try {
    assert.deepEqual(await ntfy.publishNtfy({ server: server.url, topic: "locked", token: "" }, message), { ok: false, status: 403, error: "forbidden" });
    assert.deepEqual(await ntfy.clearNtfy({ server: server.url, topic: "locked", token: "" }, "cody-x"), { ok: false, status: 403, error: "forbidden" });
  } finally {
    await server.close();
  }
});

test("whatever else answers is never echoed back: the address is user-supplied", async () => {
  const server = await serve((_request, response) => {
    response.writeHead(404, { "Content-Type": "text/html" });
    response.end("<html>internal admin console — secret=hunter2</html>");
  });
  try {
    const result = await ntfy.publishNtfy({ server: server.url, topic: "t", token: "" }, message);
    assert.deepEqual(result, { ok: false, status: 404, error: "HTTP 404" });
  } finally {
    await server.close();
  }
  const noisy = await serve((_request, response) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "x".repeat(5000) }));
  });
  try {
    const result = await ntfy.publishNtfy({ server: noisy.url, topic: "t", token: "" }, message);
    assert.equal(result.ok, false);
    assert.equal(result.error.length, 200, "even a JSON error is cut to a sentence");
  } finally {
    await noisy.close();
  }
});

test("a redirect is never followed: a redirected POST would come back as a 200 page and look accepted", async () => {
  const server = await serve((request, response) => {
    if (request.url === "/") {
      response.writeHead(301, { Location: "https://ntfy.example.com/" });
      response.end();
    } else {
      response.writeHead(200);
      response.end("<html>the web app</html>");
    }
  });
  try {
    const result = await ntfy.publishNtfy({ server: server.url, topic: "t", token: "" }, message);
    assert.equal(result.ok, false);
    assert.equal(result.status, 301);
    assert.match(result.error, /redirected.*https:\/\/ntfy\.example\.com\//);
    assert.equal(server.requests.length, 1, "the redirect target was never contacted");
  } finally {
    await server.close();
  }
});

test("a 200 that is not ntfy's reply is not a delivery", async () => {
  const server = await serve((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<html>Welcome</html>");
  });
  try {
    const result = await ntfy.publishNtfy({ server: server.url, topic: "t", token: "" }, message);
    assert.deepEqual(result, { ok: false, status: 200, error: "That address answered, but not like an ntfy server" });
  } finally {
    await server.close();
  }
});

test("a server that never answers costs the timeout, not the chat", async () => {
  const server = await serve(() => {});
  try {
    const started = Date.now();
    const result = await ntfy.publishNtfy({ server: server.url, topic: "t", token: "" }, message, { timeoutMs: 150 });
    assert.equal(result.ok, false);
    assert.match(result.error, /did not answer/);
    assert.ok(Date.now() - started < 3_000);
  } finally {
    await server.close();
  }
});

test("an unreachable server is a value, with the reason", async () => {
  const server = await serve(accepted);
  const dead = server.url;
  await server.close();
  const result = await ntfy.publishNtfy({ server: dead, topic: "t", token: "" }, message);
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not reach the ntfy server \(ECONNREFUSED\)/);
  assert.equal("status" in result, false);
});

test("a hostile server cannot stream the client full", async () => {
  const server = await serve((_request, response) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    const chunk = Buffer.alloc(64 * 1024, "a");
    let sent = 0;
    const pump = () => {
      while (sent < 50 && response.write(chunk)) sent += 1;
      if (sent < 50) response.once("drain", pump);
      else response.end();
    };
    pump();
  });
  try {
    const result = await ntfy.publishNtfy({ server: server.url, topic: "t", token: "" }, message);
    assert.deepEqual(result, { ok: false, status: 500, error: "HTTP 500" });
  } finally {
    await server.close();
  }
});

test("the fetch used is the one in place when the call is made (so a stub swapped in later is honoured)", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, method: init.method });
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  };
  try {
    assert.deepEqual(await ntfy.publishNtfy({ server: "https://ntfy.example.com", topic: "t", token: "" }, message), { ok: true });
    assert.deepEqual(seen, [{ url: "https://ntfy.example.com/", method: "POST" }]);
  } finally {
    globalThis.fetch = original;
  }
});
