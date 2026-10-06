// Shared by tests that drive an AGENT operation through a DeviceOperationManager (`manager.start`, or a tool through
// the bridge): the person's one answer to "Let the agent control <device>?", given the way the chat card gives it.
// `startUser` operations are the person's own and are never asked about.

/** Lets every promise chain that can run, run. setImmediate is never mocked, so it works while timers are. */
export async function flush(turns = 8) {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The open trust question for a device (or the first one), once the manager has raised it. */
export async function untilTrustRequest(manager, deviceId, attempts = 80) {
  for (let turn = 0; turn < attempts; turn += 1) {
    const request = manager.trustRequests().find((candidate) => deviceId === undefined || candidate.deviceId === deviceId);
    if (request) return request;
    await flush(2);
  }
  throw new Error(`the manager never asked to trust ${deviceId ?? "a device"}`);
}

/** Answers the open question Allow. `remember` ticks "Remember this device". Resolves with the manager's result. */
export async function allowAgent(manager, options = {}) {
  const { deviceId, remember = false } = options;
  const request = await untilTrustRequest(manager, deviceId);
  const result = await manager.answerTrust(request.id, { allow: true, remember });
  await flush();
  return result;
}

/** Answers the open question Deny. */
export async function denyAgent(manager, options = {}) {
  const request = await untilTrustRequest(manager, options.deviceId);
  const result = await manager.answerTrust(request.id, { allow: false });
  await flush();
  return result;
}
