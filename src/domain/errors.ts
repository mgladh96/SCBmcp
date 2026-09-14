export type ScbErrorCode =
  | "SCB_AUTH_ERROR"
  | "SCB_RATE_LIMITED"
  | "SCB_UNAVAILABLE"
  | "SCB_INVALID_QUERY"
  | "SCB_UNKNOWN_CATEGORY"
  | "SCB_UNKNOWN_VARIABLE"
  | "QUERY_TOO_BROAD"
  | "SCB_RESPONSE_VALIDATION_ERROR";

export class ScbError extends Error {
  readonly code: ScbErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: ScbErrorCode,
    message: string,
    retryable: boolean,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ScbError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  toJSON(): {
    code: ScbErrorCode;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export function queryTooBroad(count: number, maxResults: number): ScbError {
  return new ScbError(
    "QUERY_TOO_BROAD",
    `Query matched ${count} rows; SCB returns at most ${maxResults} rows and does not paginate.`,
    false,
    {
      count,
      maxResults,
      suggestion: "Narrow the query using additional SCB filters.",
    },
  );
}

export function mapHttpError(status: number, bodyText: string): ScbError {
  const snippet = bodyText.slice(0, 500);
  if (status === 401 || status === 403) {
    return new ScbError("SCB_AUTH_ERROR", "SCB rejected the client certificate or API id.", false, {
      status,
      body: snippet,
    });
  }
  if (status === 429) {
    return new ScbError("SCB_RATE_LIMITED", "SCB rate limit exceeded (10 calls per 10 seconds).", true, {
      status,
      body: snippet,
    });
  }
  if (status === 503) {
    return new ScbError("SCB_UNAVAILABLE", "SCB API is unavailable (HTTP 503).", true, {
      status,
      body: snippet,
    });
  }
  const lower = bodyText.toLowerCase();
  if (status === 400 || status === 404) {
    if (lower.includes("kategori")) {
      return new ScbError("SCB_UNKNOWN_CATEGORY", "SCB rejected the category.", false, {
        status,
        body: snippet,
      });
    }
    if (lower.includes("variabel")) {
      return new ScbError("SCB_UNKNOWN_VARIABLE", "SCB rejected the variable.", false, {
        status,
        body: snippet,
      });
    }
    return new ScbError("SCB_INVALID_QUERY", "SCB rejected the query.", false, {
      status,
      body: snippet,
    });
  }
  if (status >= 500) {
    return new ScbError("SCB_UNAVAILABLE", `SCB returned HTTP ${status}.`, true, {
      status,
      body: snippet,
    });
  }
  return new ScbError("SCB_INVALID_QUERY", `SCB returned HTTP ${status}.`, false, {
    status,
    body: snippet,
  });
}
