import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

process.env.CODY_HARNESS = "omp";
process.env.CODY_OMP_BIN = "/bin/echo";
process.env.CODY_TERMINAL_SHELL = "/bin/sh";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { TerminalManager } = await jiti.import("./terminal-manager.ts");

function waitForExit(manager, id, output, onOutput, includeReplay = true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`terminal did not exit; output: ${output.value}`)), 5_000);
    const unsubscribe = manager.subscribe(id, (event) => {
      if (event.type === "output" && event.replay && !includeReplay) return;
      if (event.type === "output") {
        output.value += event.data;
        onOutput(event.data);
      }
      if (event.type === "exit") {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

test("a new Cody terminal starts the engine once, then continues as a plain shell", async () => {
  const manager = new TerminalManager();
  const terminal = manager.create(process.cwd(), "Smoke terminal", 80, 24);
  const output = { value: "" };
  let sentInitialCommand = false;

  try {
    await waitForExit(manager, terminal.id, output, () => {
      if (sentInitialCommand || !output.value.includes("this is a plain shell now")) return;
      sentInitialCommand = true;
      manager.write(terminal.id, "printf 'CODY_SHELL_READY\\n'; exit\n");
    });

    assert.match(output.value, /Cody: starting omp/);
    assert.match(output.value, /CODY_SHELL_READY/);

    const continuedAt = output.value.length;
    manager.continue(terminal.id, 80, 24);
    manager.write(terminal.id, "printf 'CODY_CONTINUED_SHELL\\n'; exit\n");
    await waitForExit(manager, terminal.id, output, () => {}, false);

    const continuedOutput = output.value.slice(continuedAt);
    assert.match(continuedOutput, /CODY_CONTINUED_SHELL/);
    assert.doesNotMatch(continuedOutput, /Cody: starting omp/);
  } finally {
    manager.dispose();
  }
});
