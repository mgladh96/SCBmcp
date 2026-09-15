import { ScbError } from "../domain/errors.js";
import { RATE_LIMIT_WINDOW_MS } from "./types.js";

export type RateLimitRetryOptions = {
  sleep?: (ms: number) => Promise<void>;
  onWait?: (waitMs: number) => void;
  /** Attempts including the first try. Default 8 so a full catalog can span several 10s windows. */
  maxAttempts?: number;
};

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isRateLimited(error: unknown): error is ScbError {
  return error instanceof ScbError && error.code === "SCB_RATE_LIMITED";
}

export function retryAfterMsFrom(error: ScbError): number {
  return typeof error.details.retryAfterMs === "number" && error.details.retryAfterMs > 0
    ? error.details.retryAfterMs
    : RATE_LIMIT_WINDOW_MS;
}

/**
 * Wait + retry on SCB_RATE_LIMITED until the call succeeds or attempts are exhausted.
 * After a full 10s window the local 10-call budget resets, so a full JE+AE catalog
 * can be built under the 10 / 10s cap without aborting.
 */
export async function withRateLimitRetry<T>(
  run: () => Promise<T>,
  options: RateLimitRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 8;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isRateLimited(error) || attempt === maxAttempts) {
        throw error;
      }
      const waitMs = retryAfterMsFrom(error);
      options.onWait?.(waitMs);
      await sleep(waitMs);
    }
  }
  throw lastError;
}
