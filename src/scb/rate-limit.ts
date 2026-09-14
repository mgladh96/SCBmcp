import { RATE_LIMIT_MAX_CALLS, RATE_LIMIT_WINDOW_MS } from "./types.js";

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly maxCalls = RATE_LIMIT_MAX_CALLS,
    private readonly windowMs = RATE_LIMIT_WINDOW_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = delay,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.prune(now);
      if (this.timestamps.length < this.maxCalls) {
        this.timestamps.push(now);
        return;
      }
      const oldest = this.timestamps[0];
      if (oldest === undefined) {
        this.timestamps.push(now);
        return;
      }
      await this.sleep(this.windowMs - (now - oldest) + 1);
    }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
