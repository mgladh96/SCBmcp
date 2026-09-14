import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ScbError } from "../domain/errors.js";

const DEFAULT_BASE_URL = "https://privateapi.scb.se/nv0101/v1/sokpavar";

export const envSchema = z.object({
  SCB_BASE_URL: z.string().url().default(DEFAULT_BASE_URL),
  SCB_API_ID: z.string().min(1),
  SCB_CERT_PATH: z.string().min(1),
  SCB_CERT_PASSWORD: z.string().min(1),
  SCB_API_ID_HEADER: z.string().min(1).default("api-id"),
  SCB_LOG_LEVEL: z.enum(["debug", "info", "error"]).default("info"),
  MCP_HOST: z.string().min(1).default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type AppConfig = {
  baseUrl: string;
  apiId: string;
  apiIdHeader: string;
  certPath: string;
  certPassword: string;
  logLevel: "debug" | "info" | "error";
  host: string;
  port: number;
};

export function loadEnvFiles(cwd = process.cwd()): void {
  for (const name of [".env.example", ".env"]) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) {
      continue;
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
      process.env[key] = value;
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse({
    SCB_BASE_URL: env.SCB_BASE_URL ?? DEFAULT_BASE_URL,
    SCB_API_ID: env.SCB_API_ID,
    SCB_CERT_PATH: env.SCB_CERT_PATH,
    SCB_CERT_PASSWORD: env.SCB_CERT_PASSWORD,
    SCB_API_ID_HEADER: env.SCB_API_ID_HEADER ?? "api-id",
    SCB_LOG_LEVEL: env.SCB_LOG_LEVEL ?? "info",
    MCP_HOST: env.MCP_HOST ?? "127.0.0.1",
    MCP_PORT: env.MCP_PORT ?? 3000,
  });
  if (!parsed.success) {
    throw new ScbError("SCB_AUTH_ERROR", "Invalid SCB configuration.", false, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return {
    baseUrl: parsed.data.SCB_BASE_URL.replace(/\/+$/, ""),
    apiId: parsed.data.SCB_API_ID,
    apiIdHeader: parsed.data.SCB_API_ID_HEADER,
    certPath: parsed.data.SCB_CERT_PATH,
    certPassword: parsed.data.SCB_CERT_PASSWORD,
    logLevel: parsed.data.SCB_LOG_LEVEL,
    host: parsed.data.MCP_HOST,
    port: parsed.data.MCP_PORT,
  };
}
