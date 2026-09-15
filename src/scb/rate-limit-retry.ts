import { ScbError } from "../domain/errors.js";
import { RATE_LIMIT_WINDOW_MS } from "./types.js";

export type RateLimitRetryOptions = {
  sleep?: (ms: number) => Promise<void>;
  onWait?: (waitMs: number) => void;
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
 * One wait + retry on SCB_RATE_LIMITED, matching metadata warm.
 * After a full 10s window the local 10-call budget resets, so one retry per call
 * is enough to build a full JE+AE catalog under the 10 / 10s cap.
 */
export async function withRateLimitRetry<T>(
  run: () => Promise<T>,
  options: RateLimitRetryOptions = {},
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  try {
    return await run();
  } catch (error) {
    if (!isRateLimited(error)) {
      throw error;
    }
    const waitMs = retryAfterMsFrom(error);
    options.onWait?.(waitMs);
    await sleep(waitMs);
    return await run();
  }
}
