import { readFileSync } from "node:fs";
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

describe("Vercel company-index warm route", () => {
  const ready = async () => ({ loaded: true, count: 7202, ageSeconds: 4 });

  it("keeps /api/warm on the mcp function and cron", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      rewrites: Array<{ source: string; destination: string }>;
      crons: Array<{ path: string; schedule: string }>;
      functions: Record<string, unknown>;
    };
    expect(config.rewrites).toContainEqual({
      source: "/api/warm",
      destination: "/api/mcp?route=warm",
    });
    expect(config.crons).toContainEqual({ path: "/api/warm", schedule: "*/2 * * * *" });
    expect(config.functions).toHaveProperty("api/mcp.ts");
    expect(config.functions).not.toHaveProperty("api/warm.ts");
  });

  it("awaits the index on the mcp function without MCP auth", async () => {
    const direct = await handleVercelRequest(mcpRequest("/api/warm"), vercelEnv(), { ensureLoaded: ready });
    const rewritten = await handleVercelRequest(mcpRequest("/api/mcp?route=warm"), vercelEnv(), {
      ensureLoaded: ready,
    });
    expect(direct.status).toBe(200);
    expect(rewritten.status).toBe(200);
    expect(await rewritten.json()).toEqual({ loaded: true, count: 7202, ageSeconds: 4 });
  });

  it("requires the cron bearer token only when CRON_SECRET is set", async () => {
    let calls = 0;
    const ensureLoaded = async () => {
      calls += 1;
      return { loaded: true, count: 7, ageSeconds: 1 };
    };
    const env = vercelEnv({ CRON_SECRET: "cron-secret" });
    const missing = await handleVercelRequest(mcpRequest("/api/warm"), env, { ensureLoaded });
    expect(missing.status).toBe(401);
    expect(calls).toBe(0);
    const wrong = await handleVercelRequest(
      mcpRequest("/api/warm", { headers: { Authorization: "Bearer other-secret" } }),
      env,
      { ensureLoaded },
    );
    expect(wrong.status).toBe(401);
    expect(calls).toBe(0);
    const allowed = await handleVercelRequest(
      mcpRequest("/api/mcp?route=warm", { headers: { Authorization: "Bearer cron-secret" } }),
      env,
      { ensureLoaded },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ loaded: true, count: 7, ageSeconds: 1 });
    expect(calls).toBe(1);
  });

  it("returns 503 when the index does not load", async () => {
    const response = await handleVercelRequest(mcpRequest("/api/warm"), vercelEnv(), {
      ensureLoaded: async () => ({ loaded: false, count: 0, ageSeconds: 0 }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ loaded: false, count: 0, ageSeconds: 0 });
  });

  it("rejects a non-GET warm ping before loading", async () => {
    let calls = 0;
    const response = await handleVercelRequest(
      mcpRequest("/api/warm", { method: "POST" }),
      vercelEnv(),
      {
        ensureLoaded: async () => {
          calls += 1;
          return { loaded: true, count: 1, ageSeconds: 0 };
        },
      },
    );
    expect(response.status).toBe(405);
    expect(calls).toBe(0);
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

  it("passes TAVILY_API_KEY and OPENAI_API_KEY from the request env into the website tool", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({ url, authorization });
      if (url.includes("api.tavily.com")) {
        return Response.json({ results: [{ url: "https://www.ikea.com/se/sv/" }] });
      }
      if (url.includes("www.ikea.com")) {
        return new Response(
          "<p>Vi säljer möbler och heminredning till privatpersoner och företag i Sverige, med bas i Älmhult.</p>",
          { status: 200, headers: { "Content-Type": "text/html" } },
        );
      }
      if (url.includes("api.openai.com")) {
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "De säljer möbler till hem i Sverige.",
                  services: ["Kök"],
                  customerTypes: ["Privatpersoner"],
                  signals: ["har webbshop"],
                  confidence: "high",
                }),
              },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    try {
      const response = await handleVercelMcpRequest(
        mcpRequest("/mcp", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-03-26",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "company_website_summary", arguments: { name: "IKEA" } },
          }),
        }),
        vercelEnv({ TAVILY_API_KEY: "tvly-from-env", OPENAI_API_KEY: "sk-from-env" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(body.result?.isError).toBeFalsy();
      const payload = JSON.parse(body.result?.content?.[0]?.text ?? "{}") as { summary?: string; code?: string };
      expect(payload.code).toBeUndefined();
      expect(payload.summary).toBe("De säljer möbler till hem i Sverige.");
      expect(calls.find((call) => call.url.includes("api.tavily.com"))?.authorization).toBe("Bearer tvly-from-env");
      expect(calls.find((call) => call.url.includes("api.openai.com"))?.authorization).toBe("Bearer sk-from-env");
    } finally {
      globalThis.fetch = original;
    }
  });
});
