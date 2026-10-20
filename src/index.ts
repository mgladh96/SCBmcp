#!/usr/bin/env node
import { loadConfig, loadEnvFiles, McpConfigError } from "./config/env.js";
import { ScbError } from "./domain/errors.js";
import { createLogger } from "./log.js";
import { createSseHttpServer } from "./mcp/http.js";
import { createMcpServer, createToolHandlers } from "./mcp/server.js";
import { ScbClient } from "./scb/client.js";
import { websiteRuntimeFromConfig } from "./web/company-website.js";

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  const log = createLogger(config.logLevel);
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
  });
  const catalog = client.catalogInfo();
  if (catalog) {
    log.info("SCB offline catalog ready", {
      endpoint: "catalog",
      count: catalog.docCount,
      source: catalog.source,
    });
    if (catalog.source === "fixture") {
      log.info(
        "SCB catalog source is fixture, not live SoT; warm will replace Anställda/SNI/geo when SCB is reachable",
        { endpoint: "catalog", source: catalog.source },
      );
    }
  }
  const handlers = createToolHandlers(client, log, { website: websiteRuntimeFromConfig(config) });
  const httpServer = createSseHttpServer({
    createMcpServer: () =>
      config.exposedTools ? createMcpServer(handlers, config.exposedTools) : createMcpServer(handlers),
    log,
    authHeader: config.authHeader,
    ...(config.authToken ? { authToken: config.authToken } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(config.port, config.host, () => resolve());
    httpServer.once("error", reject);
  });

  const shutdown = (): void => {
    httpServer.close(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  const url = `http://${config.host}:${config.port}`;
  log.info("MCP HTTP server started", {
    endpoint: `${url}/mcp`,
    host: config.host,
    port: config.port,
    auth: config.authToken ? "required" : "disabled",
  });

  void client.warmMetadataCache({ persist: true }).catch((error: unknown) => {
    log.error("SCB metadata warm crashed", {
      errorCode: error instanceof ScbError ? error.code : "SCB_UNAVAILABLE",
    });
  });
}

main().catch((error: unknown) => {
  const payload =
    error instanceof ScbError
      ? error.toJSON()
      : error instanceof McpConfigError
        ? { code: error.code, message: error.message }
        : { code: "SCB_UNAVAILABLE", message: error instanceof Error ? error.message : "startup failed" };
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", ...payload })}\n`);
  process.exit(1);
});
