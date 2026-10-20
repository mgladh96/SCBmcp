import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import mcpFunction, { maxDuration } from "../api/mcp.js";
import {
  handleVercelHealthRequest,
  handleVercelMcpRequest,
  handleVercelRequest,
} from "../src/mcp/vercel.js";
import { dummyCertPath } from "./helpers.js";

const token = "vercel-mcp-token";

function vercelEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SCB_API_ID: "A12345",
    SCB_CERT_PATH: dummyCertPath(),
    SCB_CERT_PASSWORD: "pw",
    SCB_LOG_LEVEL: "error",
    MCP_AUTH_TOKEN: token,
    MCP_EXPOSED_TOOLS: "voice",
    ...overrides,
  };
}

function mcpRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://scb.example${path}`, init);
}

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "curl", version: "0" },
  },
});

describe("Vercel health handler", () => {
  it("stays open and does not require SCB configuration", async () => {
    const response = handleVercelHealthRequest();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; mcp: string; transport: string };
    expect(body.ok).toBe(true);
    expect(body.transport).toBe("streamable-http");
    expect(body.mcp).toBe("/mcp");
  });

  it("serves /health and the rewrite query on the same function", async () => {
    const direct = await handleVercelRequest(mcpRequest("/health"));
    const rewritten = await handleVercelRequest(mcpRequest("/api/mcp?route=health"));
    expect(direct.status).toBe(200);
    expect(rewritten.status).toBe(200);
  });
});

describe("Vercel streamable HTTP handler", () => {
  const env = vercelEnv();

  it("exports a 60 second function", () => {
    expect(maxDuration).toBe(60);
    expect(typeof mcpFunction.fetch).toBe("function");
  });

  it("rejects POST /mcp without a token", async () => {
    const response = await handleVercelMcpRequest(
      mcpRequest("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: initializeBody,
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/Bearer/i);
  });

  it("rejects a public deployment when MCP_AUTH_TOKEN is unset", async () => {
    const response = await handleVercelMcpRequest(
      mcpRequest("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}` } }),
      vercelEnv({ MCP_AUTH_TOKEN: undefined }),
    );
    expect(response.status).toBe(401);
  });

  it("returns 405 for GET /mcp after a valid token", async () => {
    const response = await handleVercelMcpRequest(
      mcpRequest("/mcp", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      }),
      env,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("accepts a raw Authorization value and answers initialize", async () => {
    const response = await handleVercelMcpRequest(
      mcpRequest("/mcp", {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: initializeBody,
      }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("scb-foretagsregister");
  });

  it("lists only the voice tool over stateless streamable HTTP", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      return handleVercelMcpRequest(new Request(input, init), env);
    };
    const transport = new StreamableHTTPClientTransport(new URL("https://scb.example/mcp"), {
      fetch: fetchImpl,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "vercel-handler-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["scb_find_company", "company_website_summary"]);
    } finally {
      await client.close();
    }
  });

  it("answers tools/list on a fresh POST the way curl will", async () => {
    const response = await handleVercelMcpRequest(
      mcpRequest("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { tools?: Array<{ name: string }> } };
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual(["scb_find_company", "company_website_summary"]);
  });
});
