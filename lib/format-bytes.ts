/**
 * Byte formatting, kept apart from lib/disk-space.ts on purpose: that module
 * imports node:fs, and this helper is needed by CLIENT components too. A
 * client importing it from there pulls `fs` into the browser bundle and fails
 * the build with "Module not found: Can't resolve 'fs'".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
