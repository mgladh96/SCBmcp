import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Agent } from "undici";
import { ScbError } from "../domain/errors.js";

export type ScbAuthConfig = {
  /** Filesystem path to a .pfx. Omit when `certPfx` is set. */
  certPath?: string;
  /** Decoded PKCS#12 bytes (from SCB_CERT_BASE64). Not written to disk. */
  certPfx?: Buffer;
  certPassword: string;
  apiId: string;
  apiIdHeader: string;
};

/**
 * Decode a .pfx supplied as base64 (Cloud Run / Secret Manager).
 * Whitespace is ignored. The error never includes the input.
 */
export function decodeCertBase64(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1) {
    throw invalidCertBase64();
  }
  const decoded = Buffer.from(compact, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/g, "");
  const given = compact.replace(/=+$/g, "");
  if (decoded.length === 0 || canonical !== given) {
    throw invalidCertBase64();
  }
  return decoded;
}

function invalidCertBase64(): ScbError {
  return new ScbError("SCB_AUTH_ERROR", "SCB_CERT_BASE64 is not valid base64.", false, {
    field: "SCB_CERT_BASE64",
  });
}

export function validateCertConfig(config: ScbAuthConfig): void {
  if (!config.apiId.trim()) {
    throw new ScbError("SCB_AUTH_ERROR", "SCB_API_ID is required.", false, {
      field: "SCB_API_ID",
    });
  }
  if (!config.certPassword) {
    throw new ScbError("SCB_AUTH_ERROR", "SCB_CERT_PASSWORD is required.", false, {
      field: "SCB_CERT_PASSWORD",
    });
  }
  const pfx = config.certPfx;
  if (pfx && pfx.length > 0) {
    return;
  }
  const certPath = config.certPath?.trim() ?? "";
  if (!certPath) {
    throw new ScbError("SCB_AUTH_ERROR", "SCB_CERT_PATH or SCB_CERT_BASE64 is required.", false, {
      field: "SCB_CERT_PATH",
    });
  }
  if (!existsSync(certPath)) {
    throw new ScbError("SCB_AUTH_ERROR", "SCB certificate file was not found.", false, {
      field: "SCB_CERT_PATH",
    });
  }
}

export function loadCertPfx(config: ScbAuthConfig): Buffer {
  validateCertConfig(config);
  if (config.certPfx && config.certPfx.length > 0) {
    return config.certPfx;
  }
  const certPath = config.certPath?.trim() ?? "";
  return readFileSync(certPath);
}

const dispatchers = new Map<string, Agent>();

/**
 * One TLS agent per certificate for the life of the process.
 * Vercel reuses the isolate, and a new ScbClient must not handshake again.
 */
export function createScbDispatcher(config: ScbAuthConfig): Agent {
  const pfx = loadCertPfx(config);
  const key = createHash("sha256")
    .update(config.apiId)
    .update("\0")
    .update(config.certPassword)
    .update("\0")
    .update(pfx)
    .digest("hex");
  const existing = dispatchers.get(key);
  if (existing) {
    return existing;
  }
  try {
    const agent = new Agent({
      connect: {
        pfx,
        passphrase: config.certPassword,
        timeout: 10_000,
      },
      keepAliveTimeout: 60_000,
      keepAliveMaxTimeout: 120_000,
      connections: 8,
      pipelining: 1,
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });
    dispatchers.set(key, agent);
    return agent;
  } catch (error) {
    throw new ScbError(
      "SCB_AUTH_ERROR",
      "Failed to load SCB client certificate.",
      false,
      { cause: error instanceof Error ? error.message : "unknown" },
    );
  }
}

export function clearScbDispatcherCache(): void {
  for (const agent of dispatchers.values()) {
    void agent.close().catch(() => undefined);
  }
  dispatchers.clear();
}

export function apiIdHeaders(config: Pick<ScbAuthConfig, "apiId" | "apiIdHeader">): Record<string, string> {
  return { [config.apiIdHeader]: config.apiId };
}
