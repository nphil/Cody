// A fake of bin/cody-omp-credentials.mjs for the operations Cody's Claude-credits code uses:
// `list` and `remove`, request as JSON in argv[2], answer as one JSON frame on stdout.
// See fake-omp-store.mjs for what it reads and writes.
import { applyFault, CREDITS_PROVIDER_IDS, emit, readFakeStore, recordOperation, writeFakeStore } from "./fake-omp-store.mjs";

const request = JSON.parse(process.argv[2] ?? "{}");
const { operation, agentDir } = request;
const store = readFakeStore(agentDir);

if (!applyFault(store, `credentials.${operation}`, operation)) {
  if (operation === "list") {
    emit({
      type: "list",
      ok: true,
      credentials: [...store.rows].sort((a, b) => a.id - b.id).map((row) => ({
        id: row.id,
        provider: row.provider,
        type: row.type,
        identity: row.identity ?? null,
        planType: null,
        disabledCause: row.disabledCause ?? null,
        blockedUntil: row.blockedUntil ?? null,
        pinHash: null,
      })),
    });
  } else if (operation === "remove") {
    const index = store.rows.findIndex((row) => row.id === request.credentialId && row.provider === request.provider);
    recordOperation(agentDir, store, {
      op: "remove",
      provider: request.provider,
      id: request.credentialId,
      found: index >= 0,
      held: store.rows.filter((row) => CREDITS_PROVIDER_IDS.includes(row.provider)).map((row) => row.id),
    });
    if (index >= 0) store.rows.splice(index, 1);
    writeFakeStore(agentDir, store);
    emit({
      type: "remove",
      ok: true,
      removed: index >= 0,
      providerRemoved: index >= 0 ? !store.rows.some((row) => row.provider === request.provider) : false,
    });
  } else {
    emit({ type: "error", ok: false, code: "invalid_request", message: "Malformed credential request." });
  }
}
