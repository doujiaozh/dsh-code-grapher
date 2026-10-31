/**
 * Sliding-window rate limiter
 * ===========================
 * InkStone's free tier caps at 50 RPM. This limiter uses a 60s sliding
 * window of request timestamps and a hard ceiling (default 60/min) that
 * cannot be raised by callers — `rpm` may only go LOWER. Every LLM call
 * in cg_analyze must funnel through `await limiter.acquire()`.
 */
export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly stamps: number[] = [];
  /** Calls currently waiting (start times, used for wait diagnostics). */
  private waiting = 0;

  constructor(rpm: number, windowMs = 60_000) {
    if (!Number.isFinite(rpm) || rpm <= 0) throw new Error('rpm must be > 0');
    // platform ceiling enforced: never above 60 even if constructed higher
    this.max = Math.min(Math.floor(rpm), 60);
    this.windowMs = windowMs;
  }

  get pendingWaiters(): number {
    return this.waiting;
  }

  /**
   * Reserve one slot, sleeping as long as needed. Resolves with the waited ms.
   */
  acquire(): Promise<number> {
    return this.acquireWithProbe(() => Date.now());
  }

  private acquireWithProbe(now: () => number): Promise<number> {
    return new Promise<number>((resolve) => {
      this.waiting++;
      const attempt = (startedAt: number): void => {
        const t = now();
        // drop timestamps outside the window
        while (this.stamps.length > 0 && t - this.stamps[0]! >= this.windowMs) {
          this.stamps.shift();
        }
        if (this.stamps.length < this.max) {
          this.stamps.push(t);
          this.waiting--;
          resolve(t - startedAt);
          return;
        }
        const waitMs = this.windowMs - (t - this.stamps[0]!) + 1;
        setTimeout(() => attempt(startedAt), Math.max(waitMs, 10));
      };
      attempt(Date.now());
    });
  }

  /** Number of requests sent within the current window. */
  currentWindowCount(): number {
    const t = Date.now();
    while (this.stamps.length > 0 && t - this.stamps[0]! >= this.windowMs) {
      this.stamps.shift();
    }
    return this.stamps.length;
  }
}

/**
 * Map a thunk over items with bounded concurrency; each item's thunk waits
 * on the shared rate limiter before doing work. Used by the analyze crew.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  limiter: RateLimiter,
  work: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let done = 0;
  const limitClamped = Math.max(1, Math.floor(limit));

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      await limiter.acquire();
      results[i] = await work(items[i], i);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < limitClamped; w++) workers.push(run());
  await Promise.all(workers);
  return results;
}
