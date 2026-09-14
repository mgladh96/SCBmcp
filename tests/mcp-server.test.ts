import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { SERVER_INSTRUCTIONS, createMcpServer, createToolHandlers } from "../src/mcp/server.js";
import { createTestClient, jsonResponse } from "./helpers.js";

describe("MCP server instructions and prompts", () => {
  const sessions: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (sessions.length > 0) {
      const session = sessions.pop();
      await session?.close();
    }
  });

  async function connect() {
    const mcp = createMcpServer(
      createToolHandlers(
        createTestClient(async () => jsonResponse(200, { Kategorier: [] })),
        createLogger("error"),
      ),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "instructions-test", version: "0.0.0" });
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    sessions.push({
      close: async () => {
        await client.close();
        await mcp.close();
      },
    });
    return client;
  }

  it("sends README workflow instructions at initialize/listTools time", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    expect(instructions).toContain("Säteslän");
    expect(instructions).toContain("2000");
    expect(instructions).toContain("Innehaller");
    expect(instructions).toContain("Reklam");
    expect(instructions).toContain("AnstSME");
    const tools = await client.listTools();
    const search = tools.tools.find((tool) => tool.name === "scb_search_companies");
    expect(search?.description).toContain("Bygg");
    expect(search?.description).toContain("Säteslän");
    expect(search?.description).toContain("Innehaller");
  });

  it("registers schema summary, lookup, filter hints, and operators resource", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["scb_schema_summary", "scb_lookup_codes", "scb_filter_hints", "scb_explain_query"]),
    );
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain("scb://operators");
    const operators = await client.readResource({ uri: "scb://operators" });
    const text = operators.contents[0] && "text" in operators.contents[0] ? operators.contents[0].text : "";
    expect(text).toContain("Innehaller");
  });

  it("registers explore, count-then-fetch, and too-broad prompts", async () => {
    const client = await connect();
    const listed = await client.listPrompts();
    expect(listed.prompts.map((prompt) => prompt.name).sort()).toEqual([
      "scb_count_then_fetch",
      "scb_explore_schema",
      "scb_handle_too_broad",
    ]);
    const prompt = await client.getPrompt({
      name: "scb_handle_too_broad",
      arguments: { objectType: "workplace" },
    });
    const text = prompt.messages[0]?.content.type === "text" ? prompt.messages[0].content.text : "";
    expect(text).toContain("Län");
    expect(text).toContain("QUERY_TOO_BROAD");
    expect(text).toMatch(/paginera/i);
  });
});
