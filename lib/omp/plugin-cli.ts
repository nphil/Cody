import { execFile } from "child_process";
import { resolveOmpBin } from "./omp-cli";

/**
 * Small shared helpers for shelling out to `omp plugin ...` (Cody never
 * embeds the Bun-only SDK, so plugin/marketplace mutations always go through
 * the CLI). Used by both /api/plugins and /api/plugins/marketplace — kept
 * here instead of duplicated per-route once a second caller needed it.
 */

const ANSI_RE = /\x1B\[[0-9;]*m/g;

export function runOmpCli(
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = resolveOmpBin();
  if (!bin) {
    return Promise.reject(new Error("omp binary not found. Install oh-my-pi or set CODY_OMP_BIN."));
  }
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message).replace(ANSI_RE, "").trim();
          reject(new Error(detail.slice(-600) || `omp ${args.join(" ")} failed`));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/** Parse `--json` stdout, tolerating stray non-JSON lines before the payload. */
export function parseJsonLoose<T>(stdout: string): T | null {
  const cleaned = stdout.replace(ANSI_RE, "");
  const start = cleaned.search(/[{[]/);
  if (start < 0) return null;
  try {
    return JSON.parse(cleaned.slice(start)) as T;
  } catch {
    return null;
  }
}
