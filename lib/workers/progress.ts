/**
 * What the agent sees while a job runs: a one-line status, then the newest
 * lines of the job's output. The first non-empty line is always the status
 * (what the chat shows as the headline); the rest is output.
 *
 * Sent at most twice a second however fast the job prints, and again every few
 * seconds even when it is quiet, so a long compile still shows its elapsed time
 * moving instead of looking frozen.
 */

export const PROGRESS_MIN_INTERVAL_MS = 500;
export const PROGRESS_REFRESH_MS = 5_000;
/** Output lines shown under the status. */
export const PROGRESS_OUTPUT_LINES = 20;

export interface ProgressOptions {
  /** Where the text goes; omitted when nobody listens. */
  emit?: (text: string) => void;
  /** The newest `count` output lines, oldest first. */
  tail(count: number): string[];
  minIntervalMs?: number;
  refreshMs?: number;
  outputLines?: number;
}

export class Progress {
  private status: () => string = () => "";
  private lastEmitAt = 0;
  private lastText = "";
  private pending: NodeJS.Timeout | undefined;
  private refresher: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly minIntervalMs: number;
  private readonly outputLines: number;

  constructor(private readonly options: ProgressOptions) {
    this.minIntervalMs = options.minIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;
    this.outputLines = options.outputLines ?? PROGRESS_OUTPUT_LINES;
    if (options.emit) {
      this.refresher = setInterval(() => this.emitNow(), options.refreshMs ?? PROGRESS_REFRESH_MS);
      this.refresher.unref();
    }
  }

  /** The headline. A function stays true as time passes (elapsed, queue position). */
  setStatus(status: string | (() => string)): void {
    this.status = typeof status === "function" ? status : () => status;
    this.poke();
  }

  /** Something changed (a status, new output): send soon, not more than once per interval. */
  poke(): void {
    if (this.stopped || !this.options.emit || this.pending) return;
    const wait = Math.max(0, this.lastEmitAt + this.minIntervalMs - Date.now());
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.emitNow();
    }, wait);
    this.pending.unref();
  }

  /** The last text that was sent (empty before the first). */
  get lastSent(): string {
    return this.lastText;
  }

  private emitNow(): void {
    const { emit } = this.options;
    if (this.stopped || !emit) return;
    const headline = this.status().trim();
    if (!headline) return;
    const text = [headline, ...this.options.tail(this.outputLines)].join("\n");
    if (text === this.lastText) return;
    this.lastText = text;
    this.lastEmitAt = Date.now();
    try {
      emit(text);
    } catch {
      // a listener that throws must not stop the job
    }
  }

  /** The job is over: no more updates, whatever was waiting to be sent is dropped (the result says it all). */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.pending);
    clearInterval(this.refresher);
    this.pending = undefined;
    this.refresher = undefined;
  }
}
