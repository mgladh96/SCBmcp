import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLoopbackHost } from "../config/env.js";
import type { createLogger } from "../log.js";
import { isMcpRequestAuthorized } from "./auth.js";

export const SSE_PATH = "/sse";
export const MESSAGES_PATH = "/messages";

type Logger = ReturnType<typeof createLogger>;

export type SseHttpServerOptions = {
  createMcpServer: () => McpServer;
  log?: Logger;
  authToken?: string;
};

export function createSseHttpServer(options: SseHttpServerOptions) {
  const sessions = new Map<string, SSEServerTransport>();
  const log = options.log;
  const authToken = options.authToken;

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") {
      writeCors(req, res);
      res.writeHead(204).end();
      return;
    }

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        writeJson(req, res, 200, {
          ok: true,
          transport: "sse",
          sse: SSE_PATH,
          messages: MESSAGES_PATH,
        });
        return;
      }

      if (url.pathname === SSE_PATH || url.pathname === MESSAGES_PATH) {
        if (!isMcpRequestAuthorized(req, authToken)) {
          writeUnauthorized(req, res);
          return;
        }
      }

      if (req.method === "GET" && url.pathname === SSE_PATH) {
        const transport = new SSEServerTransport(MESSAGES_PATH, res);
        sessions.set(transport.sessionId, transport);
        transport.onclose = () => {
          sessions.delete(transport.sessionId);
          log?.info("SSE session closed", { endpoint: SSE_PATH, sessionId: transport.sessionId });
        };
        const mcp = options.createMcpServer();
        await mcp.connect(transport);
        log?.info("SSE session started", { endpoint: SSE_PATH, sessionId: transport.sessionId });
        return;
      }

      if (req.method === "POST" && url.pathname === MESSAGES_PATH) {
        const sessionId = url.searchParams.get("sessionId");
        const transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          writeJson(req, res, 400, {
            error: "No SSE session found for sessionId.",
          });
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }

      writeJson(req, res, 404, { error: "Not found" });
    } catch (error) {
      log?.error("SSE HTTP handler failed", {
        endpoint: url.pathname,
        errorCode: error instanceof Error ? error.name : "unknown",
      });
      if (!res.headersSent) {
        writeJson(req, res, 500, { error: "Internal server error" });
      }
    }
  }

  return server;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function writeCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && isLoopbackOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-MCP-Auth");
}

function writeJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  writeCors(req, res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
}

function writeUnauthorized(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
  writeJson(req, res, 401, {
    error: "Unauthorized",
    message: "Missing or invalid MCP auth token.",
  });
}
