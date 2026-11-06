import fs from "node:fs";
import path from "node:path";

/**
 * A stand-in for /proc, so a test never reads the real process table (which
 * would make its answer depend on whatever else runs on the machine).
 *
 * `held` says what one fake process holds: `cwd`, `exe`, `fds` (symlink
 * targets), `cmdline` and `environ` (arrays of strings), `maps` (text).
 * Call once per process; `sockets` (paths bound by unix sockets) is written
 * to `net/unix` each time and replaces the previous list.
 */
export function fakeProcess(procRoot, pid, held = {}, sockets = []) {
  const dir = path.join(procRoot, String(pid));
  fs.mkdirSync(path.join(dir, "fd"), { recursive: true });
  if (held.cwd) fs.symlinkSync(held.cwd, path.join(dir, "cwd"));
  if (held.exe) fs.symlinkSync(held.exe, path.join(dir, "exe"));
  (held.fds ?? []).forEach((target, index) => fs.symlinkSync(target, path.join(dir, "fd", String(index + 3))));
  if (held.cmdline) fs.writeFileSync(path.join(dir, "cmdline"), `${held.cmdline.join("\0")}\0`);
  if (held.environ) fs.writeFileSync(path.join(dir, "environ"), `${held.environ.join("\0")}\0`);
  if (held.maps) fs.writeFileSync(path.join(dir, "maps"), held.maps);
  fs.mkdirSync(path.join(procRoot, "net"), { recursive: true });
  fs.writeFileSync(path.join(procRoot, "net", "unix"), [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    "0000000000000001: 00000003 00000000 00000000 0001 03 111",
    ...sockets.map((socket) => `0000000000000002: 00000002 00000000 00010000 0001 01 222 ${socket}`),
    "",
  ].join("\n"));
}
