import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Loaded by omp itself (Bun), not by Cody's bundler: keep this file free of
// Cody imports so it resolves from any install location.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A refusal older than this cannot be the cause of a fallback happening now
 *  (omp switches models within milliseconds of the refused reply), so a later
 *  rate-limit or outage fallback never re-raises an old refusal question. */
const REFUSAL_FALLBACK_WINDOW_MS = 60_000;

type Refusal = {
  userEntryId: string;
  from: string;
  detectedAt: number;
  decisionShown: boolean;
  choice?: string;
  decisionPromise?: Promise<string>;
  resolveDecision?: (choice: string) => void;
};

type PurgeResult = {
  before: number;
  deleted: number;
  remaining: number;
  skipped?: string;
};

type OmpContext = {
  agent?: { kind?: string };
  sessionManager: {
    getBranch(): unknown[];
    getSessionId(): string;
  };
  models: {
    current(): { provider?: string; id?: string } | undefined;
    resolve(id: string): unknown;
  };
  memory?: { status(): Promise<unknown> };
  ui: { select(title: string, choices: string[]): Promise<string> };
  waitForIdle(): Promise<void>;
  navigateTree(entryId: string): Promise<{ cancelled?: boolean }>;
  abort(): void;
};

type OmpApi = {
  on(event: string, handler: (event: unknown, ctx: OmpContext) => void | Promise<void>): void;
  registerCommand(
    name: string,
    command: { description: string; handler(args: string, ctx: OmpContext): Promise<string> },
  ): void;
  setModel(model: unknown): Promise<boolean>;
  appendEntry(type: string, data: unknown): Promise<unknown>;
};

type MemoryOptions = {
  dbPath: string;
  bank: string;
  sessionId: string;
  authorId: "coding-agent";
  authorType: "agent";
  channelId: string;
  noEmbeddings: true;
  reconcile: false;
};

type MemoryStatement = {
  get(...parameters: string[]): unknown;
  all(...parameters: string[]): unknown;
};

type MnemopiRuntime = {
  db: { prepare(sql: string): MemoryStatement };
  forget(id: string): boolean;
  close(): void;
};

type MnemopiConstructor = new (options: MemoryOptions) => MnemopiRuntime;

let pending: Refusal | null = null;


function isMnemopiConstructor(value: unknown): value is MnemopiConstructor {
  return typeof value === "function";
}

function isRefusalMessage(value: unknown): boolean {
  if (!isRecord(value) || value.role !== "assistant" || value.stopReason !== "error" || !isRecord(value.stopDetails)) return false;
  return value.stopDetails.type === "refusal" || value.stopDetails.type === "sensitive";
}

function latestUserEntryId(ctx: OmpContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!isRecord(entry) || entry.type !== "message" || typeof entry.id !== "string" || !isRecord(entry.message)) continue;
    if (entry.message.role === "user") return entry.id;
  }
  return undefined;
}

function createDecisionGate(refusal: Refusal): void {
  refusal.choice = undefined;
  const { promise, resolve } = Promise.withResolvers<string>();
  refusal.decisionPromise = promise;
  refusal.resolveDecision = resolve;
}

async function purgeTranscriptMemory(ctx: OmpContext, refusalAt: number): Promise<PurgeResult> {
  if (!ctx.memory) return { before: 0, deleted: 0, remaining: 0, skipped: "Memory runtime unavailable" };

  try {
    const status: unknown = await ctx.memory.status();
    if (!isRecord(status) || status.backend !== "mnemopi" || typeof status.database !== "string" || typeof status.retainBank !== "string") {
      return { before: 0, deleted: 0, remaining: 0, skipped: "Mnemopi is not the active memory backend" };
    }

    const runningEntry = process.argv[1];
    if (!runningEntry) return { before: 0, deleted: 0, remaining: 0, skipped: "OMP entry point unavailable" };
    // The omp binary is usually a symlink (tools/bin/omp -> .../dist/cli.js):
    // resolve from the real file so its own node_modules are found.
    const requireFromOmp = createRequire(realpathSync(path.resolve(runningEntry)));
    const modulePath = requireFromOmp.resolve("@oh-my-pi/pi-mnemopi");
    // Resolve from OMP's installation because its package root is selected at runtime.
    const loadedModule: unknown = await import(pathToFileURL(modulePath).href);
    const constructor = isRecord(loadedModule) ? loadedModule.Mnemopi : undefined;
    if (!isMnemopiConstructor(constructor)) {
      return { before: 0, deleted: 0, remaining: 0, skipped: "Mnemopi cleanup is unavailable" };
    }

    const memory = new constructor({
      dbPath: status.database,
      bank: status.retainBank,
      sessionId: status.retainBank,
      authorId: "coding-agent",
      authorType: "agent",
      channelId: status.retainBank,
      noEmbeddings: true,
      reconcile: false,
    });
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const cutoff = new Date(refusalAt).toISOString();
      const where = "source = ? AND json_extract(metadata_json, '$.session_id') = ? AND julianday(created_at) >= julianday(?)";
      const rawTargets = memory.db.prepare(`SELECT id FROM working_memory WHERE ${where}`).all("coding-agent-transcript", sessionId, cutoff);
      const targets = Array.isArray(rawTargets)
        ? rawTargets.filter((row): row is Record<string, unknown> => isRecord(row) && typeof row.id === "string")
        : [];
      let deleted = 0;
      for (const row of targets) {
        const id = row.id;
        if (typeof id === "string" && memory.forget(id)) deleted += 1;
      }
      const rawRemaining = memory.db.prepare(`SELECT COUNT(*) AS count FROM working_memory WHERE ${where}`).get(
        "coding-agent-transcript",
        sessionId,
        cutoff,
      );
      const remaining = isRecord(rawRemaining) && Number.isFinite(Number(rawRemaining.count)) ? Number(rawRemaining.count) : 0;
      return { before: targets.length, deleted, remaining };
    } finally {
      memory.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { before: 0, deleted: 0, remaining: 0, skipped: `Mnemopi cleanup could not be completed: ${detail.slice(0, 200)}` };
  }
}

export default function codyRefusalGuard(pi: OmpApi): void {
  pi.on("message_end", (event: unknown, ctx: OmpContext) => {
    if (ctx.agent?.kind !== "main" || !isRecord(event)) return;
    if (!isRefusalMessage(event.message)) {
      // A real reply supersedes any earlier refusal still on record.
      if (isRecord(event.message) && event.message.role === "assistant" && event.message.stopReason !== "error") pending = null;
      return;
    }
    const userEntryId = latestUserEntryId(ctx);
    const model = ctx.models.current();
    if (!userEntryId || typeof model?.provider !== "string" || typeof model.id !== "string") {
      pending = null;
      return;
    }
    pending = {
      userEntryId,
      from: `${model.provider}/${model.id}`,
      detectedAt: Date.now(),
      decisionShown: false,
    };
  });

  pi.on("agent_end", async (event: unknown, ctx: OmpContext) => {
    if (ctx.agent?.kind !== "main" || !isRecord(event)) return;
    const refusal = pending;
    const messages = Array.isArray(event.messages) ? event.messages : [];
    if (event.willContinue === true || !messages.some(isRefusalMessage) || !refusal || refusal.decisionShown) return;

    refusal.decisionShown = true;
    createDecisionGate(refusal);
    const decision = {
      kind: "cody.refusal-decision",
      mode: "no_fallback",
      from: refusal.from,
      to: null,
      userEntryId: refusal.userEntryId,
    };
    // Cody answers at once (omp's handler budget does not pause for this
    // dialog): `hold` and `rewind` both keep the record for /cody-rewind.
    const choice = await ctx.ui.select(`CODY_REFUSAL_DECISION ${JSON.stringify(decision)}`, ["keep", "rewind", "hold"]);
    refusal.choice = choice;
    refusal.resolveDecision?.(choice);
    if (pending === refusal && choice !== "rewind" && choice !== "hold") pending = null;
  });

  pi.on("retry_fallback_applied", async (event: unknown, ctx: OmpContext) => {
    const refusal = pending;
    if (!refusal || ctx.agent?.kind !== "main" || Date.now() - refusal.detectedAt > REFUSAL_FALLBACK_WINDOW_MS) return;
    const from = isRecord(event) && typeof event.from === "string" ? event.from : refusal.from;
    const to = isRecord(event) && typeof event.to === "string" ? event.to : null;

    refusal.decisionShown = true;
    createDecisionGate(refusal);
    const decision = {
      kind: "cody.refusal-decision",
      mode: "fallback",
      from,
      to,
      userEntryId: refusal.userEntryId,
    };
    // `hold` (Cody will ask the user, with no time limit) stops the fallback
    // exactly like `rewind`; only `continue` lets it run now.
    const choice = await ctx.ui.select(`CODY_REFUSAL_DECISION ${JSON.stringify(decision)}`, ["continue", "rewind", "hold"]);
    refusal.choice = choice;
    refusal.resolveDecision?.(choice);
    if (pending !== refusal) return;
    if (choice !== "rewind" && choice !== "hold") {
      pending = null;
      return;
    }

    const original = ctx.models.resolve(from);
    if (!original) {
      ctx.abort();
      throw new Error("Could not restore the model active before fallback.");
    }
    const restored = await pi.setModel(original);
    ctx.abort();
    if (!restored) throw new Error("Could not restore the model active before fallback.");
  });

  pi.registerCommand("cody-rewind", {
    description: "Rewind before the selected declined message",
    handler: async (args: string, ctx: OmpContext) => {
      const userEntryId = args.trim() || pending?.userEntryId;
      if (!userEntryId) throw new Error("No declined message to rewind to.");
      const refusal = pending?.userEntryId === userEntryId ? pending : null;
      if (!refusal) throw new Error("No pending rewind matches that message.");
      if (!refusal.decisionShown) throw new Error("A rewind decision has not been requested.");
      if (refusal.choice === undefined) await refusal.decisionPromise;
      if (pending !== refusal || (refusal.choice !== "rewind" && refusal.choice !== "hold")) throw new Error("The rewind choice is no longer active.");

      await ctx.waitForIdle();
      const result = await ctx.navigateTree(userEntryId);
      if (result.cancelled) throw new Error("The session could not move to the earlier message.");

      const purged = await purgeTranscriptMemory(ctx, refusal.detectedAt);
      await pi.appendEntry("cody.rewind", {
        rewoundEntryId: userEntryId,
        at: Date.now(),
        refusalAt: refusal.detectedAt,
        purged,
      });
      if (pending === refusal) pending = null;
      return "Rewind complete.";
    },
  });
}
