#!/usr/bin/env node
import { loadConfig, loadEnvFiles, McpConfigError } from "./config/env.js";
import { ScbError } from "./domain/errors.js";
import { createLogger } from "./log.js";
import { createSseHttpServer } from "./mcp/http.js";
import { createMcpServer, createToolHandlers } from "./mcp/server.js";
import { ScbClient } from "./scb/client.js";

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const client = new ScbClient({
    baseUrl: config.baseUrl,
    auth: {
      apiId: config.apiId,
      apiIdHeader: config.apiIdHeader,
      certPath: config.certPath,
      certPassword: config.certPassword,
    },
    logLevel: config.logLevel,
  });
  const handlers = createToolHandlers(client, log);
  const httpServer = createSseHttpServer({
    createMcpServer: () => createMcpServer(handlers),
    log,
    ...(config.authToken ? { authToken: config.authToken } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(config.port, config.host, () => resolve());
    httpServer.once("error", reject);
  });

  const url = `http://${config.host}:${config.port}`;
  log.info("MCP SSE server started", {
    endpoint: `${url}/sse`,
    host: config.host,
    port: config.port,
    auth: config.authToken ? "required" : "disabled",
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
