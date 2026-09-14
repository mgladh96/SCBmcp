import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { createLogger } from "../log.js";

export const SSE_PATH = "/sse";
export const MESSAGES_PATH = "/messages";

type Logger = ReturnType<typeof createLogger>;

export type SseHttpServerOptions = {
  createMcpServer: () => McpServer;
  log?: Logger;
};

export function createSseHttpServer(options: SseHttpServerOptions) {
  const sessions = new Map<string, SSEServerTransport>();
  const log = options.log;

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") {
      writeCors(res);
      res.writeHead(204).end();
      return;
    }

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        writeJson(res, 200, {
          ok: true,
          transport: "sse",
          sse: SSE_PATH,
          messages: MESSAGES_PATH,
        });
        return;
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
          writeJson(res, 400, {
            error: "No SSE session found for sessionId.",
          });
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }

      writeJson(res, 404, { error: "Not found" });
    } catch (error) {
      log?.error("SSE HTTP handler failed", {
        endpoint: url.pathname,
        errorCode: error instanceof Error ? error.name : "unknown",
      });
      if (!res.headersSent) {
        writeJson(res, 500, { error: "Internal server error" });
      }
    }
  }

  return server;
}

function writeCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  writeCors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
}
