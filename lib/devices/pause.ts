/**
 * Waits `milliseconds`, or rejects as soon as `signal` is aborted - a cancelled
 * operation must not sit out a poll interval, nor go on to its next attempt.
 */
export function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const cancelled = (): Error => (signal.reason instanceof Error ? signal.reason : new DOMException("Operation cancelled.", "AbortError"));
  if (signal.aborted) {
    reject(cancelled());
    return promise;
  }
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(cancelled());
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}
