/**
 * The one channel a sign-in flow's pasted values travel through.
 *
 * A login has exactly one place the user can type — the panel's paste box —
 * and two things that may be waiting on it: a driver's explicit prompt
 * ("Authorization code:") and its watch for a value pasted UNPROMPTED, which
 * exists because the box is on screen from the first URL and a redirect URL
 * usually arrives before the engine asks. So: the next submission goes to
 * whoever asked first; with nobody asking it is held for the next asker; a
 * cancel rejects every waiter so no driver hangs on a closed stream.
 */
export interface LoginValueChannel {
  /** Resolves with the next submitted value (or one already held). Rejects on cancel. */
  next(): Promise<string>;
  /** Hand a value in: to the oldest waiter, or hold it. */
  submit(value: string): void;
  /** Reject every waiter; later `next()` calls reject too. */
  cancel(reason?: string): void;
}

export function createLoginValueChannel(): LoginValueChannel {
  const waiters: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
  let held: string | null = null;
  let cancelled: Error | null = null;
  return {
    next() {
      return new Promise<string>((resolve, reject) => {
        if (cancelled) { reject(cancelled); return; }
        if (held !== null) {
          const value = held;
          held = null;
          resolve(value);
          return;
        }
        waiters.push({ resolve, reject });
      });
    },
    submit(value) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value);
      else held = value;
    },
    cancel(reason = "Login cancelled") {
      cancelled = new Error(reason);
      for (const waiter of waiters.splice(0)) waiter.reject(cancelled);
    },
  };
}
