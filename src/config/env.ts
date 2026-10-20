import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ScbError } from "../domain/errors.js";
import { parseExposedTools } from "../mcp/exposed-tools.js";
import { decodeCertBase64 } from "../scb/auth.js";
import { MCP_AUTH_HEADER } from "../mcp/auth.js";

const DEFAULT_BASE_URL = "https://privateapi.scb.se/nv0101/v1/sokpavar";

export const envSchema = z.object({
  SCB_BASE_URL: z.string().url().default(DEFAULT_BASE_URL),
  SCB_API_ID: z.string().min(1),
  SCB_CERT_PATH: z.string().min(1).optional(),
  SCB_CERT_PASSWORD: z.string().min(1),
  SCB_API_ID_HEADER: z.string().min(1).default("api-id"),
  SCB_LOG_LEVEL: z.enum(["debug", "info", "error"]).default("info"),
  MCP_HOST: z.string().min(1).default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_AUTH_TOKEN: z.string().min(1).optional(),
});

export type AppConfig = {
  baseUrl: string;
  apiId: string;
  apiIdHeader: string;
  certPath?: string;
  certPfx?: Buffer;
  certPassword: string;
  logLevel: "debug" | "info" | "error";
  host: string;
  port: number;
  authToken?: string;
  authHeader: string;
  exposedTools?: readonly string[];
  tavilyApiKey?: string;
  openAiApiKey?: string;
};

export class McpConfigError extends Error {
  readonly code = "MCP_CONFIG_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

/** True for bind addresses that only accept local connections. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  return /^127(?:\.(?:\d{1,3})){3}$/.test(normalized);
}

export function loadEnvFiles(cwd = process.cwd()): void {
  const path = resolve(cwd, ".env");
  if (!existsSync(path)) {
    return;
  }
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

/**
 * Cloud Run sets PORT and injects traffic on 0.0.0.0. Local runs keep MCP_PORT
 * (default 3000) and MCP_HOST (default 127.0.0.1). PORT wins over MCP_PORT.
 * An explicit MCP_HOST always wins over the Cloud Run host default.
 */
export function resolveListenPort(env: NodeJS.ProcessEnv): number {
  const raw = optionalEnvString(env.PORT) ?? optionalEnvString(env.MCP_PORT) ?? "3000";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ScbError("SCB_AUTH_ERROR", "PORT / MCP_PORT must be an integer from 1 to 65535.", false, {
      field: optionalEnvString(env.PORT) ? "PORT" : "MCP_PORT",
    });
  }
  return port;
}

export function resolveListenHost(env: NodeJS.ProcessEnv): string {
  const explicit = optionalEnvString(env.MCP_HOST);
  if (explicit) {
    return explicit;
  }
  if (optionalEnvString(env.PORT)) {
    return "0.0.0.0";
  }
  return "127.0.0.1";
}

export function resolveAuthHeader(raw: string | undefined): string {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return MCP_AUTH_HEADER;
  }
  if (value === "authorization" || value === "cookie" || value === "host") {
    throw new McpConfigError(
      "MCP_AUTH_HEADER cannot be Authorization, Cookie, or Host. " +
        "Use Authorization: Bearer <token>, a raw Authorization value, or a custom header such as X-MCP-Auth.",
    );
  }
  if (!/^[a-z0-9-]{1,64}$/.test(value)) {
    throw new McpConfigError("MCP_AUTH_HEADER must be letters, digits, and hyphens.");
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const authTokenInput = optionalEnvString(env.MCP_AUTH_TOKEN);
  const certPathInput = optionalEnvString(env.SCB_CERT_PATH);
  const certBase64Input = optionalEnvString(env.SCB_CERT_BASE64);
  const host = resolveListenHost(env);
  const port = resolveListenPort(env);
  const parsed = envSchema.safeParse({
    SCB_BASE_URL: env.SCB_BASE_URL ?? DEFAULT_BASE_URL,
    SCB_API_ID: env.SCB_API_ID,
    SCB_CERT_PASSWORD: env.SCB_CERT_PASSWORD,
    SCB_API_ID_HEADER: env.SCB_API_ID_HEADER ?? "api-id",
    SCB_LOG_LEVEL: env.SCB_LOG_LEVEL ?? "info",
    MCP_HOST: host,
    MCP_PORT: port,
    ...(certPathInput ? { SCB_CERT_PATH: certPathInput } : {}),
    ...(authTokenInput ? { MCP_AUTH_TOKEN: authTokenInput } : {}),
  });
  if (!parsed.success) {
    throw new ScbError("SCB_AUTH_ERROR", "Invalid SCB configuration.", false, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  const authToken = parsed.data.MCP_AUTH_TOKEN;
  if (!isLoopbackHost(host) && !authToken) {
    throw new McpConfigError(
      `Refusing to bind MCP HTTP server to ${host} without MCP_AUTH_TOKEN. ` +
        "Set a shared secret, or keep MCP_HOST at 127.0.0.1.",
    );
  }
  const certificate = resolveCertificate(certPathInput, certBase64Input);
  const exposed = parseExposedTools(env.MCP_EXPOSED_TOOLS);
  if (exposed.error) {
    throw new McpConfigError(exposed.error);
  }
  const authHeader = resolveAuthHeader(env.MCP_AUTH_HEADER);
  const tavilyApiKey = optionalEnvString(env.TAVILY_API_KEY);
  const openAiApiKey = optionalEnvString(env.OPENAI_API_KEY);
  return {
    baseUrl: parsed.data.SCB_BASE_URL.replace(/\/+$/, ""),
    apiId: parsed.data.SCB_API_ID,
    apiIdHeader: parsed.data.SCB_API_ID_HEADER,
    certPassword: parsed.data.SCB_CERT_PASSWORD,
    logLevel: parsed.data.SCB_LOG_LEVEL,
    host,
    port,
    authHeader,
    ...certificate,
    ...(authToken ? { authToken } : {}),
    ...(exposed.tools ? { exposedTools: exposed.tools } : {}),
    ...(tavilyApiKey ? { tavilyApiKey } : {}),
    ...(openAiApiKey ? { openAiApiKey } : {}),
  };
}

function resolveCertificate(
  certPath: string | undefined,
  certBase64: string | undefined,
): { certPath: string } | { certPfx: Buffer } {
  const pathExists = Boolean(certPath && existsSync(certPath));
  if (pathExists && certPath) {
    return { certPath };
  }
  if (certBase64) {
    return { certPfx: decodeCertBase64(certBase64) };
  }
  if (certPath) {
    return { certPath };
  }
  throw new ScbError("SCB_AUTH_ERROR", "Set SCB_CERT_PATH or SCB_CERT_BASE64.", false, {
    field: "SCB_CERT_PATH",
  });
}

function optionalEnvString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
