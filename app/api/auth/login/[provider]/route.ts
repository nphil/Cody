import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/engine-guard";
import { getHarness } from "@/lib/harness";
import { createLoginValueChannel } from "@/lib/harness/login-channel";
import type { ProviderLoginUi } from "@/lib/harness/types";

export const dynamic = "force-dynamic";

/**
 * Interactive provider sign-in, engine-neutral.
 *
 * GET opens an SSE stream and runs the ACTIVE engine's own login for the
 * provider through its `providerLogins` surface; the driver's calls become
 * the frames the sign-in panel renders (`auth`, `device_code`,
 * `prompt_request`, `progress`, `success`, `error`, `cancelled`). POST feeds
 * back what the user pasted — a code, a redirect URL, an answer — against the
 * stream's token. A value pasted before the engine asks for it is held and
 * handed over at the first request, because the paste box is on screen from
 * the first URL and a redirect URL often arrives first.
 */

const HEARTBEAT_MS = 30_000;

interface PendingLogin {
  provider: string;
  submit: (value: string) => void;
}

// Registry survives dev-server hot reload; the SSE stream registers its token,
// the POST handler resolves it.
declare global {
  var __providerLoginRegistry: Map<string, PendingLogin> | undefined;
}

function getLoginRegistry(): Map<string, PendingLogin> {
  if (!globalThis.__providerLoginRegistry) globalThis.__providerLoginRegistry = new Map();
  return globalThis.__providerLoginRegistry;
}

// POST /api/auth/login/[provider] — the pasted code, redirect URL or answer
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const { token, code } = (await req.json()) as { token?: string; code?: string };

  // An EMPTY answer is a valid one: some prompts are optional (pi's GitHub
  // Copilot flow asks for an enterprise domain, blank meaning github.com),
  // so only a missing field is refused, never an empty string.
  if (!token || typeof code !== "string") {
    return Response.json({ error: "token and code required", code: "login_token_code_required" }, { status: 400 });
  }
  const pending = getLoginRegistry().get(token);
  if (!pending) {
    return Response.json({ error: "No pending login for token", code: "login_no_pending" }, { status: 404 });
  }
  // Exact provider association: the registry records the provider a token was
  // created for. A prefix check on the token alone is unsafe because provider
  // ids may share prefixes (e.g. "openai" vs "openai-codex"), which would let
  // a token for one provider be submitted against another provider's route.
  if (pending.provider !== provider) {
    return Response.json({ error: "Token does not match provider", code: "login_token_mismatch" }, { status: 400 });
  }

  pending.submit(code);
  return Response.json({ ok: true, provider });
}

// GET /api/auth/login/[provider] — SSE stream for the login flow
export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const gate = requireCapability("providerLogin", "Provider sign-in");
  if ("response" in gate) return gate.response;
  const engine = getHarness();
  const surface = engine.providerLogins;
  if (!surface) {
    return NextResponse.json(
      { error: `${engine.displayName} has no provider sign-in surface`, code: "unsupported" },
      { status: 400 },
    );
  }

  const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const registry = getLoginRegistry();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      // OAuth flows sit idle while the user is in the browser; keep the SSE
      // connection alive past proxy/Next idle timeouts.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      // ONE channel for the user's values (lib/harness/login-channel.ts):
      // whoever is waiting — a prompt, or the driver's watch for an
      // unprompted paste — gets the next submission; with nobody waiting it
      // is held for the next asker.
      const channel = createLoginValueChannel();
      const nextValue = () => channel.next();
      const submit = (value: string) => channel.submit(value);
      const abort = new AbortController();
      const cancelWaiters = () => channel.cancel();

      const ui: ProviderLoginUi = {
        onUrl: (url, instructions) => send({ type: "auth", url, instructions: instructions ?? null, token }),
        onDeviceCode: (info) => send({
          type: "device_code",
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          intervalSeconds: info.intervalSeconds ?? null,
          expiresInSeconds: info.expiresInSeconds ?? null,
        }),
        onPrompt: (message, placeholder) => {
          send({ type: "prompt_request", message, placeholder: placeholder ?? null, token });
          return nextValue();
        },
        onManualInput: () => nextValue(),
        onProgress: (message) => send({ type: "progress", message }),
        signal: abort.signal,
      };

      registry.set(token, { provider, submit });
      const cleanup = () => {
        registry.delete(token);
        clearInterval(heartbeat);
        abort.abort();
        cancelWaiters();
      };
      req.signal.addEventListener("abort", cleanup);

      try {
        await surface.login(provider, ui);
        send({ type: "success" });
      } catch (error) {
        if (req.signal.aborted) {
          send({ type: "cancelled" });
        } else {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        cleanup();
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
