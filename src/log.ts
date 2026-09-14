export type LogLevel = "debug" | "info" | "error";

type LogFields = {
  tool?: string;
  endpoint?: string;
  durationMs?: number;
  status?: number;
  errorCode?: string;
  objectType?: string;
  count?: number;
  host?: string;
  port?: number;
  sessionId?: string;
};

const SENSITIVE_KEY = /password|passphrase|pfx|private.?key|cert(?:ificate)?/i;

export function createLogger(level: LogLevel = "info") {
  const rank = { debug: 10, info: 20, error: 30 };

  function write(entryLevel: LogLevel, message: string, fields: LogFields = {}): void {
    if (rank[entryLevel] < rank[level]) {
      return;
    }
    const entry = {
      ts: new Date().toISOString(),
      level: entryLevel,
      message,
      ...sanitize(fields),
    };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }

  return {
    debug: (message: string, fields?: LogFields) => write("debug", message, fields),
    info: (message: string, fields?: LogFields) => write("info", message, fields),
    error: (message: string, fields?: LogFields) => write("error", message, fields),
  };
}

function sanitize(fields: LogFields): LogFields {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
