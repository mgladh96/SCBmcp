import { afterAll, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSseHttpServer } from "../src/mcp/http.js";
import { createMcpServer, createToolHandlers } from "../src/mcp/server.js";
import { createTestClient, jsonResponse } from "./helpers.js";
import { createLogger } from "../src/log.js";

function createTestSseServer(authToken?: string) {
  return createSseHttpServer({
    createMcpServer: () =>
      createMcpServer(
        createToolHandlers(
          createTestClient(async () => jsonResponse(200, { Kategorier: [] })),
          createLogger("error"),
        ),
      ),
    ...(authToken ? { authToken } : {}),
  });
}

async function listen(httpServer: ReturnType<typeof createSseHttpServer>): Promise<string> {
  if (!httpServer.listening) {
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
  }
  const address = httpServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readSseEndpointEvent(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  let text = "";
  while (reader) {
    const chunk = await reader.read();
    if (chunk.value) {
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (text.includes("event: endpoint") || chunk.done) {
      break;
    }
  }
  await reader?.cancel();
  return text;
}

describe("SSE HTTP server", () => {
  const httpServer = createTestSseServer();

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("exposes a URL health document", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as { transport: string; sse: string };
    expect(response.status).toBe(200);
    expect(body.transport).toBe("sse");
    expect(body.sse).toBe("/sse");
    const doc = body as { mcp?: string; transports?: string[] };
    expect(doc.mcp).toBe("/mcp");
    expect(doc.transports).toEqual(["sse", "streamable-http"]);
  });

  it("serves stateless streamable HTTP on /mcp", async () => {
    const base = await listen(httpServer);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    const client = new Client({ name: "streamable-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "scb_find_company")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("answers GET /mcp with 405 so Cloud Run does not hold an SSE stream", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/mcp`, { headers: { Accept: "text/event-stream" } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("opens an SSE stream with an endpoint event", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/sse`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await readSseEndpointEvent(response);
    expect(text).toContain("event: endpoint");
    expect(text).toContain("/messages?sessionId=");
  });

  it("rejects POST /messages without a live session", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(400);
  });

  it("does not use wildcard CORS", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/health`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(response.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });
});

describe("SSE HTTP server with auth", () => {
  const authToken = "test-mcp-shared-secret";
  const httpServer = createTestSseServer(authToken);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("keeps /health unauthenticated", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
  });

  it("rejects GET /sse without a token", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/sse`);
    const body = (await response.json()) as { error: string };
    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/i);
  });

  it("rejects POST /messages without a token", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects GET /sse with an invalid token", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/sse`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  it("opens an SSE stream with a valid bearer token", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/sse`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await readSseEndpointEvent(response);
    expect(text).toContain("event: endpoint");
    expect(text).toContain("/messages?sessionId=");
  });

  it("rejects POST /mcp without a token", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "curl", version: "0" },
        },
      }),
    });
    expect(response.status).toBe(401);
  });

  it("accepts streamable HTTP with a raw Authorization value", async () => {
    const base = await listen(httpServer);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: authToken } },
    });
    const client = new Client({ name: "streamable-raw-auth", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "scb_search_companies")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("rejects GET /mcp without a token", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/mcp`, { headers: { Accept: "text/event-stream" } });
    expect(response.status).toBe(401);
  });

  it("opens an SSE stream with X-MCP-Auth", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/sse`, {
      headers: { "X-MCP-Auth": authToken },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await readSseEndpointEvent(response);
  });

  it("rejects POST /messages with a valid token but no live session", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(400);
  });

  it("allows CORS preflight Authorization without a token", async () => {
    const base = await listen(httpServer);
    const response = await fetch(`${base}/sse`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3000");
    expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
      "authorization",
    );
  });
});
