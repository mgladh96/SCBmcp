import { RATE_LIMIT_MAX_CALLS, RATE_LIMIT_WINDOW_MS } from "./types.js";

export type RateLimitDecision = { ok: true } | { ok: false; retryAfterMs: number };

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly maxCalls = RATE_LIMIT_MAX_CALLS,
    private readonly windowMs = RATE_LIMIT_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Consume one slot if the window has capacity. Does not sleep.
   * Agents should see SCB_RATE_LIMITED + retryAfterMs instead of a silent hang.
   */
  tryAcquire(): RateLimitDecision {
    const now = this.now();
    this.prune(now);
    if (this.timestamps.length < this.maxCalls) {
      this.timestamps.push(now);
      return { ok: true };
    }
    const oldest = this.timestamps[0];
    const retryAfterMs =
      oldest === undefined ? 1 : Math.max(1, this.windowMs - (now - oldest) + 1);
    return { ok: false, retryAfterMs };
  }

  get outstanding(): number {
    this.prune(this.now());
    return this.timestamps.length;
  }

  private prune(now: number): void {
    while (this.timestamps[0] !== undefined && now - this.timestamps[0] >= this.windowMs) {
      this.timestamps.shift();
    }
  }
}
