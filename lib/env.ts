/**
 * Cody's own configuration lives under a `CODY_` prefix. The project was forked
 * from ompweb, which used `OMP_WEB_`, so every read falls back to the legacy
 * name and an existing ompweb environment keeps working untouched after the
 * rename. Only the suffix is passed in — `readEnv("PASSWORD")` resolves
 * `CODY_PASSWORD` first, then `OMP_WEB_PASSWORD`.
 *
 * `??` rather than `||` on purpose: exporting `CODY_PASSWORD=""` is a
 * deliberate "no password", not a request to fall back to the legacy variable.
 */
export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`CODY_${name}`] ?? env[`OMP_WEB_${name}`];
}
