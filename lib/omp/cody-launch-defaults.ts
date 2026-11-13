import { existsSync } from "fs";
import path from "path";
import { readPersistedBoolean } from "./settings-values";

/**
 * The config layers carrying Cody's own launch defaults (cody-launch-defaults*.yml
 * beside this file): omp settings whose default is right for its terminal UI but
 * wrong for an engine Cody drives over a pipe (`display.shellVisualization`,
 * `async.widgets`), plus desktop control, which Cody offers on demand per chat
 * (`computer.enabled`, see on-demand-chats.ts).
 *
 * They ride `PI_CONFIG_FILES`, which omp layers ABOVE config.yml, so the user's
 * file is never written. That ordering is also why a value the user set there
 * themselves needs care: the layer would override it. Each setting therefore has
 * its own layer file, dropped when config.yml explicitly turns THAT key ON —
 * someone who asked for the feature gets it, everyone else gets the smaller bill.
 *
 * Static on purpose: nothing is written at launch, and a missing file (a
 * stripped-down tree) just means the engine's own defaults apply.
 */

/** One layer file per setting, so a user who explicitly turned ONE on loses only that layer. */
export const CODY_LAUNCH_DEFAULTS_LAYERS: ReadonlyArray<{ file: string; key: string }> = [
  { file: "cody-launch-defaults.yml", key: "display.shellVisualization" },
  { file: "cody-launch-defaults-async-widgets.yml", key: "async.widgets" },
  { file: "cody-launch-defaults-computer.yml", key: "computer.enabled" },
];

/** The layers' paths for a chat started from `packageRoot`: each file that exists
 *  and whose setting the user has not explicitly turned ON in config.yml. */
export function codyLaunchDefaultsLayers(packageRoot: string): string[] {
  const layers: string[] = [];
  for (const { file, key } of CODY_LAUNCH_DEFAULTS_LAYERS) {
    if (readPersistedBoolean(key) === true) continue;
    const full = path.join(packageRoot, "lib", "omp", file);
    if (existsSync(full)) layers.push(full);
  }
  return layers;
}

/** The `PI_CONFIG_FILES` a chat launches with: the defaults layers FIRST, then
 *  `inherited` (what the chat would have had without them — a model preset, the
 *  Claude credits and Local-only routing set disjoint keys and keep their place).
 *  Undefined when no layer applies, so the launch env stays untouched. */
export function codyLaunchDefaultsEnv(inherited: string | undefined, packageRoot: string): { PI_CONFIG_FILES: string } | undefined {
  const layers = codyLaunchDefaultsLayers(packageRoot);
  if (layers.length === 0) return undefined;
  const others = (inherited ?? "").split(path.delimiter).filter((entry) => entry.length > 0 && !layers.includes(entry));
  return { PI_CONFIG_FILES: [...layers, ...others].join(path.delimiter) };
}
