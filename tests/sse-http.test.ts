import { afterAll, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { createSseHttpServer } from "../src/mcp/http.js";
import { createMcpServer, createToolHandlers } from "../src/mcp/server.js";
import { createTestClient, jsonResponse } from "./helpers.js";
import { createLogger } from "../src/log.js";

describe("SSE HTTP server", () => {
  const httpServer = createSseHttpServer({
    createMcpServer: () =>
      createMcpServer(
        createToolHandlers(
          createTestClient(async () => jsonResponse(200, { Kategorier: [] })),
          createLogger("error"),
        ),
      ),
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function listen(): Promise<string> {
    if (!httpServer.listening) {
      await new Promise<void>((resolve) => {
        httpServer.listen(0, "127.0.0.1", () => resolve());
      });
    }
    const address = httpServer.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  it("exposes a URL health document", async () => {
    const base = await listen();
    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as { transport: string; sse: string };
    expect(response.status).toBe(200);
    expect(body.transport).toBe("sse");
    expect(body.sse).toBe("/sse");
  });

  it("opens an SSE stream with an endpoint event", async () => {
    const base = await listen();
    const response = await fetch(`${base}/sse`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
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
    expect(text).toContain("event: endpoint");
    expect(text).toContain("/messages?sessionId=");
  });

  it("rejects POST /messages without a live session", async () => {
    const base = await listen();
    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(400);
  });
});
