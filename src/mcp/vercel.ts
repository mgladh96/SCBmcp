import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, McpConfigError, type AppConfig } from "../config/env.js";
import { ScbError } from "../domain/errors.js";
import { createLogger } from "../log.js";
import { bundledCatalogPath } from "../scb/offline-catalog.js";
import { ScbClient } from "../scb/client.js";
import { defaultCompanyDirectory, type CompanyIndexStatus } from "../companies/directory.js";
import { isWebRequestAuthorized, mcpTokensEqual, tokenFromAuthorization } from "./auth.js";
import { MCP_PATH } from "./http.js";
import { createMcpServer, createToolHandlers } from "./server.js";
import { websiteRuntimeFromConfig } from "../web/company-website.js";

export const VERCEL_FUNCTION_MAX_DURATION_SECONDS = 60;

export function vercelHealthBody(): {
  ok: true;
  transport: "streamable-http";
  transports: ["streamable-http"];
  mcp: string;
} {
  return {
    ok: true,
    transport: "streamable-http",
    transports: ["streamable-http"],
    mcp: MCP_PATH,
  };
}

export function handleVercelHealthRequest(): Response {
  return Response.json(vercelHealthBody());
}

export function isVercelHealthRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
    return true;
  }
  return url.searchParams.get("route") === "health";
}

/** `/api/warm` is rewritten onto this function. A separate function would warm another instance. */
export function isVercelWarmRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (url.pathname === "/api/warm" || url.pathname === "/warm") {
    return true;
  }
  return url.searchParams.get("route") === "warm";
}

export type VercelRequestOptions = {
  ensureLoaded?: () => Promise<CompanyIndexStatus>;
};

/** One function serves `/health`, `/api/warm`, and `/mcp` so Fluid Compute can reuse the instance. */
export function handleVercelRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  options: VercelRequestOptions = {},
): Promise<Response> | Response {
  if (isVercelHealthRequest(request)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET");
    }
    return handleVercelHealthRequest();
  }
  if (isVercelWarmRequest(request)) {
    return handleVercelWarmRequest(request, env, options.ensureLoaded);
  }
  return handleVercelMcpRequest(request, env);
}

/**
 * Keep-warm ping. Awaits the Firestore company index on this instance.
 * When `CRON_SECRET` is set, Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 * When it is unset, the route stays open so the cron still runs.
 */
export async function handleVercelWarmRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
  ensureLoaded?: () => Promise<CompanyIndexStatus>,
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
  }
  if (!isCronAuthorized(request, env)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const load = ensureLoaded ?? (() => defaultCompanyDirectory().ensureLoaded());
  const status = await load();
  return Response.json(
    { loaded: status.loaded, count: status.count, ageSeconds: status.ageSeconds },
    { status: status.loaded ? 200 : 503 },
  );
}

function isCronAuthorized(request: Request, env: NodeJS.ProcessEnv): boolean {
  const secret = env.CRON_SECRET?.trim();
  if (!secret) {
    return true;
  }
  const provided = tokenFromAuthorization(request.headers.get("authorization") ?? undefined);
  if (!provided) {
    return false;
  }
  return mcpTokensEqual(provided, secret);
}

type Runtime = {
  config: AppConfig;
  client: ScbClient;
};

let processRuntime: Runtime | undefined;

function catalogPathOverride(): string | undefined {
  if (process.env.SCB_CATALOG_PATH?.trim()) {
    return undefined;
  }
  if (existsSync(bundledCatalogPath())) {
    return undefined;
  }
  const fromCwd = join(process.cwd(), "data", "scb-catalog", "catalog.json");
  return existsSync(fromCwd) ? fromCwd : undefined;
}

function buildRuntime(env: NodeJS.ProcessEnv): Runtime {
  const config = loadConfig(env);
  const catalog = catalogPathOverride();
  const client = new ScbClient({
    baseUrl: config.baseUrl,
    auth: {
      apiId: config.apiId,
      apiIdHeader: config.apiIdHeader,
      certPassword: config.certPassword,
      ...(config.certPath ? { certPath: config.certPath } : {}),
      ...(config.certPfx ? { certPfx: config.certPfx } : {}),
    },
    logLevel: config.logLevel,
    ...(catalog ? { offlineCatalog: catalog } : {}),
  });
  return { config, client };
}

function runtimeFor(env: NodeJS.ProcessEnv): Runtime {
  if (env === process.env) {
    processRuntime ??= buildRuntime(env);
    return processRuntime;
  }
  return buildRuntime(env);
}

function unauthorized(): Response {
  return Response.json(
    { error: "Unauthorized", message: "Missing or invalid MCP auth token." },
    { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="mcp"' } },
  );
}

function methodNotAllowed(allow = "POST"): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    { status: 405, headers: { Allow: allow } },
  );
}

function configurationError(error: unknown): Response {
  const code =
    error instanceof ScbError || error instanceof McpConfigError ? error.code : "MCP_CONFIG_ERROR";
  createLogger("error").error("Vercel MCP configuration failed", { errorCode: code });
  return Response.json({ error: "Server configuration error", code }, { status: 500 });
}

/**
 * Stateless streamable HTTP for one Vercel invocation.
 * A public deployment never serves MCP without MCP_AUTH_TOKEN, even when the
 * bind address would be loopback for the local server.
 */
export async function handleVercelMcpRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  let runtime: Runtime;
  try {
    runtime = runtimeFor(env);
  } catch (error) {
    return configurationError(error);
  }

  const token = runtime.config.authToken;
  if (!token || !isWebRequestAuthorized(request.headers, token, runtime.config.authHeader)) {
    return unauthorized();
  }
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  const handlers = createToolHandlers(runtime.client, createLogger(runtime.config.logLevel), {
    website: websiteRuntimeFromConfig(runtime.config),
  });
  const mcp = runtime.config.exposedTools
    ? createMcpServer(handlers, runtime.config.exposedTools)
    : createMcpServer(handlers);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  try {
    await mcp.connect(transport as Parameters<McpServer["connect"]>[0]);
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
  }
}
