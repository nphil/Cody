// A fake of bin/cody-omp-claude-credits.mjs: `list` and `add`, request as JSON on STDIN,
// answer as one JSON frame on stdout. It never prints more of a key than the real helper does
// (the row id, the provider and the last four characters). See fake-omp-store.mjs for what it
// reads and writes.
//
// Like the real helper it only ever looks under the credits providers the request names, and an
// `add` of a key text that omp already holds under ANY of them stores nothing and answers with THAT
// row — whose provider may differ from the one asked for.
import { applyFault, emit, holdAtGate, isGated, readFakeStore, recordOperation, writeFakeStore } from "./fake-omp-store.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
const { operation, agentDir } = request;
const providers = Array.isArray(request.providers) ? request.providers : [];
const store = readFakeStore(agentDir);
const creditsKeys = () => store.rows.filter((row) => providers.includes(row.provider) && row.type === "api_key");

if (providers.length === 0) {
  emit({ type: "error", ok: false, code: "invalid_request", message: "Malformed request." });
} else if (!applyFault(store, `keys.${operation}`, operation)) {
  if (operation === "list") {
    emit({ type: "list", ok: true, keys: creditsKeys().sort((a, b) => a.id - b.id).map((row) => ({ id: row.id, last4: row.key.slice(-4), provider: row.provider })) });
  } else if (operation === "add") {
    if (!providers.includes(request.provider)) {
      emit({ type: "add", ok: false, code: "invalid_request", message: "A credits provider is required." });
    } else {
      // A gate holds the row back until the test opens it: a save that is still in flight. The store is read again
      // afterwards, so whatever the test changed in the meantime (the fault itself, included) is what is written on.
      if (isGated(store, "keys.add")) {
        await holdAtGate(agentDir);
        Object.assign(store, readFakeStore(agentDir));
      }
      const existing = creditsKeys().find((row) => row.key === request.key);
      let id;
      let provider;
      if (existing) {
        id = existing.id;
        provider = existing.provider;
      } else {
        id = store.nextId;
        provider = request.provider;
        store.nextId += 1;
        store.rows.push({ id, provider, type: "api_key", identity: null, disabledCause: null, blockedUntil: null, key: request.key });
      }
      recordOperation(agentDir, store, { op: "add", id, provider, asked: request.provider, reused: Boolean(existing), held: creditsKeys().map((row) => row.id) });
      writeFakeStore(agentDir, store);
      emit({ type: "add", ok: true, id, last4: request.key.slice(-4), provider });
    }
  } else {
    emit({ type: "error", ok: false, code: "invalid_request", message: "Malformed request." });
  }
}
