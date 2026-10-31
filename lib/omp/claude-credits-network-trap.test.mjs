import assert from "node:assert/strict";
import { Socket, createConnection } from "node:net";
import test from "node:test";
import { startNetworkTrap } from "./fixtures/claude-credits/omp-driver.mjs";

test("the network trap handles reset CONNECT sockets but reports other socket errors", async () => {
  for (const code of ["ECONNRESET", "EIO"]) {
    const trap = await startNetworkTrap();
    const originalEnd = Socket.prototype.end;
    let injected = 0;
    Socket.prototype.end = function (...args) {
      if (args[0] === "HTTP/1.1 403 Forbidden\r\n\r\n") {
        injected++;
        this.emit("error", Object.assign(new Error(`injected ${code}`), { code }));
      }
      return originalEnd.apply(this, args);
    };
    try {
      const address = new URL(trap.url);
      const client = createConnection({ host: address.hostname, port: Number(address.port) });
      client.write("CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n");
      let response = "";
      for await (const chunk of client) response += chunk;
      assert.equal(response, "HTTP/1.1 403 Forbidden\r\n\r\n");
      assert.deepEqual(trap.attempts, ["CONNECT example.test:443"]);
      assert.equal(injected, 1);
      if (code === "ECONNRESET") {
        await trap.close();
      } else {
        await assert.rejects(trap.close(), (error) =>
          error instanceof AggregateError && error.errors.length === 1 && error.errors[0].code === code);
      }
    } finally {
      Socket.prototype.end = originalEnd;
    }
  }
});
