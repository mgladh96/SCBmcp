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

export function createScbDispatcher(config: ScbAuthConfig): Agent {
  const pfx = loadCertPfx(config);
  try {
    return new Agent({
      connect: {
        pfx,
        passphrase: config.certPassword,
      },
    });
  } catch (error) {
    throw new ScbError(
      "SCB_AUTH_ERROR",
      "Failed to load SCB client certificate.",
      false,
      { cause: error instanceof Error ? error.message : "unknown" },
    );
  }
}

export function apiIdHeaders(config: Pick<ScbAuthConfig, "apiId" | "apiIdHeader">): Record<string, string> {
  return { [config.apiIdHeader]: config.apiId };
}
