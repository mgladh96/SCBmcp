import { existsSync, readFileSync } from "node:fs";
import { Agent } from "undici";
import { ScbError } from "../domain/errors.js";

export type ScbAuthConfig = {
  certPath: string;
  certPassword: string;
  apiId: string;
  apiIdHeader: string;
};

export function validateCertConfig(config: ScbAuthConfig): void {
  if (!config.apiId.trim()) {
    throw new ScbError("SCB_AUTH_ERROR", "SCB_API_ID is required.", false, {
      field: "SCB_API_ID",
    });
  }
  if (!config.certPath.trim()) {
    throw new ScbError("SCB_AUTH_ERROR", "SCB_CERT_PATH is required.", false, {
      field: "SCB_CERT_PATH",
    });
  }
  if (!config.certPassword) {
    throw new ScbError("SCB_AUTH_ERROR", "SCB_CERT_PASSWORD is required.", false, {
      field: "SCB_CERT_PASSWORD",
    });
  }
  if (!existsSync(config.certPath)) {
    throw new ScbError("SCB_AUTH_ERROR", "SCB certificate file was not found.", false, {
      field: "SCB_CERT_PATH",
    });
  }
}

export function createScbDispatcher(config: ScbAuthConfig): Agent {
  validateCertConfig(config);
  try {
    return new Agent({
      connect: {
        pfx: readFileSync(config.certPath),
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
