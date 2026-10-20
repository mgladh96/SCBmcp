import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLoopbackHost } from "../config/env.js";
import type { createLogger } from "../log.js";
import { isMcpRequestAuthorized, MCP_AUTH_HEADER } from "./auth.js";

export const SSE_PATH = "/sse";
export const MESSAGES_PATH = "/messages";
/**
 * Streamable HTTP (MCP 2025-03-26). Stateless JSON: one MCP server per POST.
 * Cloud Run can scale without session affinity. GET/DELETE return 405 so the
 * process does not hold a long-lived SSE stream (the spec allows 405).
 */
export const MCP_PATH = "/mcp";

type Logger = ReturnType<typeof createLogger>;

export type SseHttpServerOptions = {
  createMcpServer: () => McpServer;
  log?: Logger;
  authToken?: string;
  authHeader?: string;
};

export function createSseHttpServer(options: SseHttpServerOptions) {
  const sessions = new Map<string, SSEServerTransport>();
  const log = options.log;
  const authToken = options.authToken;
  const authHeader = options.authHeader ?? MCP_AUTH_HEADER;

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "OPTIONS") {
      writeCors(req, res, authHeader);
      res.writeHead(204).end();
      return;
    }

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        writeJson(req, res, 200, {
          ok: true,
          transport: "sse",
          transports: ["sse", "streamable-http"],
          sse: SSE_PATH,
          messages: MESSAGES_PATH,
          mcp: MCP_PATH,
        });
        return;
      }

      if (url.pathname === SSE_PATH || url.pathname === MESSAGES_PATH || url.pathname === MCP_PATH) {
        if (!isMcpRequestAuthorized(req, authToken, authHeader)) {
          writeUnauthorized(req, res, authHeader);
          return;
        }
      }

      if (url.pathname === MCP_PATH) {
        if (req.method === "POST") {
          await handleStreamableHttp(req, res);
          return;
        }
        if (req.method === "GET" || req.method === "DELETE") {
          writeMethodNotAllowed(req, res);
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
      log?.error("MCP HTTP handler failed", {
        endpoint: url.pathname,
        errorCode: error instanceof Error ? error.name : "unknown",
      });
      if (!res.headersSent) {
        writeJson(req, res, 500, { error: "Internal server error" });
      }
    }
  }

  async function handleStreamableHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const mcp = options.createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    let closed = false;
    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      void transport.close();
      void mcp.close();
    };
    res.on("close", close);
    try {
      await mcp.connect(transport as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(req, res);
      log?.info("Streamable HTTP request handled", { endpoint: MCP_PATH });
    } finally {
      if (res.writableEnded) {
        close();
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

function writeCors(req: IncomingMessage, res: ServerResponse, authHeader = MCP_AUTH_HEADER): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && isLoopbackOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  const allowHeaders = new Set([
    "content-type",
    "accept",
    "authorization",
    "x-mcp-auth",
    "mcp-protocol-version",
    "mcp-session-id",
    authHeader.trim().toLowerCase(),
  ]);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", [...allowHeaders].join(", "));
}

function writeJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: unknown,
  authHeader = MCP_AUTH_HEADER,
): void {
  writeCors(req, res, authHeader);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(`${JSON.stringify(body)}\n`);
}

function writeUnauthorized(req: IncomingMessage, res: ServerResponse, authHeader = MCP_AUTH_HEADER): void {
  res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
  writeJson(
    req,
    res,
    401,
    {
      error: "Unauthorized",
      message: "Missing or invalid MCP auth token.",
    },
    authHeader,
  );
}

function writeMethodNotAllowed(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Allow", "POST");
  writeJson(req, res, 405, {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}
