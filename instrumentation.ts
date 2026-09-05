export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Startup diagnostics: agent dir. Kept to one line so it greps cleanly;
  // failures here must never block boot.
  try {
    const { getAgentDir } = await import("@/lib/session-reader");
    console.log(
      `[Cody] starting (agent-dir ${getAgentDir()})`,
    );
  } catch {
    // Diagnostics are best-effort.
  }

  // Warm the ACTIVE engine's shared utility process so the first models
  // request does not pay the multi-second cold spawn (measured 1.2-4s on a
  // real install). Fire-and-forget: register() must not block boot, and a
  // missing binary is reported per-request by the routes — log once here and
  // move on. The shared process registers its own SIGINT/SIGTERM/exit disposal
  // hook on first use (lib/omp/rpc-utility.ts), as the session registry does.
  //
  // Engine-aware, because this used to spawn omp at every boot whichever
  // engine was selected: a Claude Code instance started an omp child it would
  // never speak to, and kept it alive for the idle window.
  void (async () => {
    const { getHarness } = await import("@/lib/harness");
    let harness;
    try {
      harness = getHarness();
    } catch (error) {
      console.warn(`[Cody] engine unknown, skipping utility warm-up: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // An ACP engine has no sessionless utility process to warm — its models
    // and state live inside a session it will not open without credentials.
    if (!harness.rpcUi) {
      console.log(`[Cody] ${harness.displayName} needs no utility warm-up (no sessionless RPC surface)`);
      return;
    }
    try {
      const { runUtilityCommand } = await import("@/lib/omp/rpc-utility");
      const { utilityRpcLaunchFor } = await import("@/lib/rpc-manager");
      await runUtilityCommand({ type: "get_state" }, undefined, utilityRpcLaunchFor(harness));
      const version = await harness.getVersion();
      console.log(`[Cody] ${harness.binaryName} utility ready (${version ?? "version unknown"})`);
    } catch (error) {
      const bin = harness.resolveBinary();
      const detail = error instanceof Error ? error.message : String(error);
      const hint = bin
        ? `resolved ${bin}; repair by reinstalling ${harness.displayName} from Settings → System → Engines`
        : `${harness.binaryName} binary not found; install ${harness.displayName} from the engine picker or set CODY_${harness.binaryName.toUpperCase()}_BIN`;
      console.warn(`[Cody] ${harness.binaryName} utility warm-up failed (routes will retry on demand): ${detail} — ${hint}`);
    }
  })();
}
