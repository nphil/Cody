#!/usr/bin/env node
"use strict";

async function main() {
  const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("zod"),
  ]);
  const endpoint = process.env.CODY_DISPLAY_ENDPOINT;
  const sessionsEndpoint = process.env.CODY_SESSIONS_ENDPOINT;
  const devicesEndpoint = process.env.CODY_DEVICES_ENDPOINT;
  const capability = process.env.CODY_DISPLAY_CAPABILITY;
  const sessionId = process.env.CODY_DISPLAY_SESSION_ID;
  if (!endpoint || !capability) throw new Error("Cody display capability is unavailable");

  /** Shared by the three session-awareness tools below: same endpoint,
   * same envelope, same error shape — one place to keep them in lockstep
   * rather than three fetch blocks that could drift. */
  async function callSessionTool(tool, toolArgs) {
    if (!sessionsEndpoint || !sessionId) throw new Error("Cody session capability is unavailable");
    const response = await fetch(sessionsEndpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + capability, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, tool, arguments: toolArgs }),
      // Longer than the display calls' 5s: a transcript read is bounded in
      // OUTPUT but not in the work behind it (a long session file, or a status
      // sweep over every running session), and a timeout here costs the model
      // a whole tool call.
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "HTTP " + response.status);
    return typeof body.text === "string" ? body.text : "";
  }

  /** Same envelope as callSessionTool, for browser-hosted hardware. A page
   * quiet read may legitimately use the full 60s bridge budget, while the
   * liveness watchdog is 65s; never cut that short with a fixed MCP timeout. */
  async function callDeviceTool(tool, toolArgs) {
    if (!devicesEndpoint || !sessionId) throw new Error("Cody device capability is unavailable");
    const requestedQuiet = Number.isSafeInteger(toolArgs?.timeoutMs) ? toolArgs.timeoutMs : 60_000;
    const quietBudget = Math.max(1, Math.min(60_000, requestedQuiet));
    const response = await fetch(devicesEndpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + capability, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, tool, arguments: toolArgs }),
      signal: AbortSignal.timeout(quietBudget + 5_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "HTTP " + response.status);
    return typeof body.text === "string" ? body.text : "";
  }

  const server = new McpServer({ name: "cody-display", version: "1.0.0" });
  server.registerTool("open_preview", {
    title: "Open Cody Preview",
    description: "Open or refresh a running local web UI in Cody's Preview panel. Call this after starting or restarting a dev server and whenever the URL changes. The URL must use localhost or 127.0.0.1.",
    inputSchema: {
      url: z.string().describe("Container-local http(s) URL, for example http://127.0.0.1:3000"),
      title: z.string().max(160).optional().describe("Short label for the preview"),
      mode: z.enum(["auto", "stream", "native"]).optional().describe("Prefer auto unless a specific transport is required"),
    },
  }, async (input) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + capability, "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "HTTP " + response.status);
      const accepted = { accepted: true, requestId: body.requestId };
      return { content: [{ type: "text", text: JSON.stringify(accepted) }], structuredContent: accepted };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to open preview" }] };
    }
  });
  server.registerTool("shared_browser", {
    title: "Open a shared browser",
    description: "Open a URL in a browser the user WATCHES LIVE in Cody's Preview panel, and get back a DevTools endpoint to drive it with. Use this instead of your own headless browser whenever you verify a web UI: the user sees every click as it happens and can take the mouse mid-run. Attach browser automation to the returned endpoint as a CDP url and drive the tab that is already open. Loopback URLs only.",
    inputSchema: {
      url: z.string().describe("Container-local http(s) URL, for example http://127.0.0.1:3000"),
      title: z.string().max(160).optional().describe("Short label for the preview"),
    },
  }, async (input) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer " + capability, "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, shared: true }),
        // Starting a renderer means launching Chromium, which is slower than
        // publishing a request; the 5s publish budget would time out on a
        // cold first call.
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "HTTP " + response.status);
      const text = `Shared browser is open at ${body.url} and streaming to the user's Preview panel — they can watch and take the mouse at any time. Attach your browser automation to this CDP endpoint and drive the tab that is already open: ${body.endpoint}`;
      return { content: [{ type: "text", text }], structuredContent: { url: body.url, endpoint: body.endpoint, requestId: body.requestId } };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to start a shared browser" }] };
    }
  });
  server.registerTool("list_sessions", {
    description: "List recent chat sessions: id, title, folder, running state, last activity.",
    inputSchema: {
      workspace: z.string().optional().describe("Only sessions whose folder matches this path."),
      running: z.boolean().optional().describe("Only sessions with a live engine process."),
    },
  }, async (input) => {
    try {
      const text = await callSessionTool("list_sessions", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to list sessions" }] };
    }
  });
  server.registerTool("session_status", {
    description: "What a chat session is doing right now — live phase plus its newest message. Omit `session` for every running one.",
    inputSchema: {
      session: z.string().optional().describe("Session id or title; omit for all running sessions."),
    },
  }, async (input) => {
    try {
      const text = await callSessionTool("session_status", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to read session status" }] };
    }
  });
  server.registerTool("read_session", {
    description: "Read a condensed transcript of a chat session by id or title: messages and tool names only.",
    inputSchema: {
      session: z.string().optional().describe("Session id or title; omit for this session."),
      tail: z.number().optional().describe("Only the most recent N messages."),
      offset: z.number().optional().describe("Resume from a prior truncated result's offset."),
    },
  }, async (input) => {
    try {
      const text = await callSessionTool("read_session", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to read the session transcript" }] };
    }
  });
  server.registerTool("device_list", {
    description: "List what this session's browser can reach: its Web Serial/WebUSB/Web Bluetooth capabilities, whether a browser is attached, and one line per device (id, label, kind, open/closed, buffered bytes).",
    inputSchema: {},
  }, async () => {
    try {
      const text = await callDeviceTool("device_list", {});
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to list devices" }] };
    }
  });
  server.registerTool("device_open", {
    description: "Open a device: serial.open (baud default 115200) for a serial port, ble.connect for BLE, or usb.open for a raw USB device — dispatched from the device's kind.",
    inputSchema: {
      device: z.string().optional().describe("Device id or a case-insensitive substring of its label; omit when exactly one device is attached."),
      baudRate: z.number().optional().describe("Serial only. Baud rate; defaults to 115200."),
      dataBits: z.number().optional().describe("Serial only. 7 or 8."),
      stopBits: z.number().optional().describe("Serial only. 1 or 2."),
      parity: z.enum(["none", "even", "odd"]).optional().describe("Serial only."),
      flowControl: z.enum(["none", "hardware"]).optional().describe("Serial only."),
    },
  }, async (input) => {
    try {
      const text = await callDeviceTool("device_open", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to open the device" }] };
    }
  });
  server.registerTool("device_write", {
    description: "Write bytes to an open serial device. Exactly one of text (UTF-8) or base64 is required. For BLE use ble_gatt; raw USB writes are not exposed by a tool.",
    inputSchema: {
      device: z.string().optional().describe("Device id or a case-insensitive substring of its label; omit when exactly one device is attached."),
      text: z.string().optional().describe("UTF-8 text to write."),
      base64: z.string().optional().describe("Base64-encoded bytes to write."),
    },
  }, async (input) => {
    try {
      const text = await callDeviceTool("device_write", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to write to the device" }] };
    }
  });
  server.registerTool("device_read", {
    description: "Drain buffered bytes from an open device: serial RX, a BLE notification after ble_gatt subscribes, or a streamed USB IN transfer.",
    inputSchema: {
      device: z.string().optional().describe("Device id or a case-insensitive substring of its label; omit when exactly one device is attached."),
      waitMs: z.number().optional().describe("Milliseconds to wait for at least one byte; default 0 (read whatever is already buffered), capped at 10000."),
      maxBytes: z.number().optional().describe("Maximum bytes to drain in one call."),
      encoding: z.enum(["text", "base64"]).optional().describe('"text" (default, lossy UTF-8) or "base64".'),
      characteristic: z.string().optional().describe("BLE only: read notifications from this characteristic. Each subscribed characteristic buffers separately; omit for a serial or USB device."),
    },
  }, async (input) => {
    try {
      const text = await callDeviceTool("device_read", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to read from the device" }] };
    }
  });
  server.registerTool("device_close", {
    description: "Close an open device.",
    inputSchema: {
      device: z.string().optional().describe("Device id or a case-insensitive substring of its label; omit when exactly one device is attached."),
    },
  }, async (input) => {
    try {
      const text = await callDeviceTool("device_close", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to close the device" }] };
    }
  });
  server.registerTool("ble_gatt", {
    description: 'Bluetooth GATT operations: "services" lists them, "read"/"write" need service and characteristic, "subscribe"/"unsubscribe" toggle notifications (which then arrive via device_read).',
    inputSchema: {
      device: z.string().optional().describe("Device id or a case-insensitive substring of its label; omit when exactly one device is attached."),
      op: z.enum(["services", "read", "write", "subscribe", "unsubscribe"]).describe("GATT operation to perform."),
      service: z.string().optional().describe("GATT service UUID. Required for read, write, subscribe, unsubscribe."),
      characteristic: z.string().optional().describe("GATT characteristic UUID. Required for read, write, subscribe, unsubscribe."),
      text: z.string().optional().describe('UTF-8 text to write. For op "write", exactly one of text or base64 is required.'),
      base64: z.string().optional().describe('Base64-encoded bytes to write. For op "write", exactly one of text or base64 is required.'),
      withoutResponse: z.boolean().optional().describe('For op "write": true sends without waiting for a peripheral response.'),
    },
  }, async (input) => {
    try {
      const text = await callDeviceTool("ble_gatt", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to perform the BLE operation" }] };
    }
  });

  const operationInput = {
    device: z.string().describe("Exact browser device id from device_list."),
    protocol: z.enum(["esp", "adb", "fastboot", "gecko", "stm32", "stk500", "dfu", "edl", "serial"]).describe("Protocol implementation to run. Use serial for an interactive CDC/UART console."),
    target: z.string().optional().describe("Exact destination, path, partition, or address."),
    offset: z.number().int().nonnegative().optional(),
    length: z.number().int().positive().optional(),
    fileId: z.string().optional().describe("Session artifact id displayed in Cody's Devices panel."),
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional().describe("Exact artifact SHA-256; required with fileId."),
    baudRate: z.number().int().positive().optional(),
    interfaceNumber: z.number().int().nonnegative().optional().describe("USB interface number for an exclusive operation lease."),
    alternateSetting: z.number().int().nonnegative().optional().describe("USB alternate setting paired with interfaceNumber from device_detect."),
    command: z.string().max(16 * 1024).optional(),
    options: z.object({}).passthrough().optional().describe("Protocol-specific validated configuration, such as safety or DFU descriptor data. It cannot approve a risk."),
  };
  const startOperationTools = [
    ["device_detect", "Start protocol detection in the browser. Protocol edl reads a Qualcomm 9008 device's boot-ROM identity (chip serial, hardware id, public-key hash) and needs no loader."],
    ["device_flash", "Start a verified flash. Any destructive write pauses for direct browser UI confirmation bound to the exact target, hash, and offset. Protocol edl: target is the exact GPT partition name, fileId + sha256 the image (the partition's exact size, or smaller with options.pad zero or ff); the partition is saved first, protected names need the typed override write:NAME, boot0/boot1/rpmb are refused, and the read-back SHA-256 decides verified. Run device_exec connect first; flash never sends a loader."],
    ["device_dump", "Start a dump or backup; resulting bytes remain a session-owned browser artifact. Protocol edl: target is the exact GPT partition name, or user-area with options.sectors set to the count device_exec check verified; fileId + sha256 name the loader while the device is still in the boot ROM."],
    ["device_exec", "Start a protocol command. State-changing commands pause for direct browser UI confirmation. Protocol edl (Qualcomm 9008) takes connect, printgpt, check, reset, erase (target = the exact GPT partition name; saved first, typed override write:NAME for protected names, reports what the partition reads as afterwards), backup (every partition and both partition tables saved with a manifest; a set restorable only when taken from a device freshly put into EDL mode with the loader as fileId + sha256) and restore (fileId + sha256 = the loader, options.manifestSha256 = the manifest's SHA-256; same unit only, typed override restore:<first 8 characters of that SHA-256>, partition tables written last, every region read back)."],
    ["device_push", "Start a resumable file push from a session artifact."],
    ["device_pull", "Start a file pull into a session-owned browser artifact."],
    ["device_sideload", "Serve a session artifact to ADB recovery sideload. Requires direct approval; transfer completion does not verify installation."],
    ["device_install", "Install an APK from a session artifact after direct typed browser confirmation."],
    ["device_verify", "After a Fastboot write without fetch support, compare an exact raw-image byte range in ADB recovery with the expected SHA-256. Needs target, length, sha256 and the shell grant."],
    ["device_monitor", "Start an exclusive serial monitor. Use device_monitor_send with its operation id for input."],
  ];
  for (const [name, description] of startOperationTools) {
    server.registerTool(name, { description, inputSchema: operationInput }, async (input) => {
      try {
        const text = await callDeviceTool(name, input);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to start device operation" }] };
      }
    });
  }
  const tunnelInput = {
    device: z.string().describe("Exact browser device id from device_list."),
    target: z.string().describe("Device-side address such as tcp:8080, localabstract:NAME, or (forward only) jdwp:PID."),
    local: z.string().describe("Host address on the machine running Cody: tcp:PORT (forward may use tcp:0 for any free port, 1024 or above)."),
  };
  const tunnelTools = [
    ["device_forward", "adb forward: listen on 127.0.0.1 of the machine running Cody and relay each connection to the device service through the browser's ADB connection. Long-running; pauses for the user's direct confirmation; ends with device_operation_cancel or device_tunnels remove."],
    ["device_reverse", "adb reverse: the device listens on target and each connection is relayed through the browser to 127.0.0.1:PORT of the machine running Cody. Long-running; pauses for the user's direct confirmation; ends with device_operation_cancel or device_tunnels remove."],
  ];
  for (const [name, description] of tunnelTools) {
    server.registerTool(name, { description, inputSchema: tunnelInput }, async (input) => {
      try {
        const text = await callDeviceTool(name, input);
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to start the port rule" }] };
      }
    });
  }
  server.registerTool("device_tunnels", {
    description: "List, remove, or remove all adb forward/reverse port rules of this session.",
    inputSchema: {
      action: z.enum(["list", "remove", "remove_all"]).optional().describe("Defaults to list."),
      operationId: z.string().optional().describe("The forward/reverse operation to remove; required for remove."),
    },
  }, async (input) => {
    try {
      const text = await callDeviceTool("device_tunnels", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to manage port rules" }] };
    }
  });
  server.registerTool("device_operation_status", {
    description: "Read the bounded snapshot and recent output for an operation id.",
    inputSchema: { operationId: z.string() },
  }, async (input) => {
    try {
      const text = await callDeviceTool("device_operation_status", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to read device operation" }] };
    }
  });
  server.registerTool("device_operation_cancel", {
    description: "Cancel an operation by id. No pending write is replayed after cancellation.",
    inputSchema: { operationId: z.string() },
  }, async (input) => {
    try {
      const text = await callDeviceTool("device_operation_cancel", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to cancel device operation" }] };
    }
  });
  server.registerTool("device_monitor_send", {
    description: "Send immediate UTF-8 input to a running serial monitor operation. Input is never queued or replayed after cancel/reconnect.",
    inputSchema: { operationId: z.string(), text: z.string().min(1).max(16 * 1024) },
  }, async (input) => {
    try {
      const text = await callDeviceTool("device_monitor_send", input);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Unable to send monitor input" }] };
    }
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
