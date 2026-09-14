import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { ScbError } from "../src/domain/errors.js";
import { MAX_RESULTS } from "../src/scb/types.js";
import { createTestClient, jsonResponse } from "./helpers.js";

const silent = createLogger("error");

describe("MCP input validation", () => {
  it("rejects missing objectType", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => jsonResponse(200, [])),
      silent,
    );
    const result = await handlers.scb_list_categories({});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { code: string };
    expect(payload.code).toBe("SCB_INVALID_QUERY");
  });

  it("rejects unknown objectType", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => jsonResponse(200, [])),
      silent,
    );
    const result = await handlers.scb_list_categories({ objectType: "provider" });
    expect(result.isError).toBe(true);
  });

  it("requires category for scb_get_category_values", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => jsonResponse(200, [])),
      silent,
    );
    const result = await handlers.scb_get_category_values({ objectType: "company" });
    expect(result.isError).toBe(true);
  });
});

describe("MCP JE vs AE tools", () => {
  it("routes company count to JE", async () => {
    const paths: string[] = [];
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        paths.push(new URL(url).pathname);
        return jsonResponse(200, 7);
      }),
      silent,
    );
    const result = await handlers.scb_count_companies({
      filters: {
        categories: [{ category: "Företagsstatus", values: ["1"] }],
      },
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      objectType: string;
    };
    expect(payload.count).toBe(7);
    expect(payload.objectType).toBe("company");
    expect(paths[0]).toContain("/api/je/raknaforetag");
  });

  it("routes workplace search to AE and preserves Reklam", async () => {
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        if (url.includes("raknaarbetsstallen")) {
          return jsonResponse(200, 1);
        }
        return jsonResponse(200, [{ CfarNr: "123", Reklam: "21" }]);
      }),
      silent,
    );
    const result = await handlers.scb_search_workplaces({
      filters: { categories: [{ category: "Arbetsställestatus", values: ["1"] }] },
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      results: Array<{ Reklam?: string }>;
    };
    expect(payload.results[0]?.Reklam).toBe("21");
  });
});

describe("MCP QUERY_TOO_BROAD", () => {
  it("returns structured QUERY_TOO_BROAD without fetching rows", async () => {
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        if (url.includes("hamta")) {
          throw new Error("should not fetch");
        }
        return jsonResponse(200, MAX_RESULTS + 100);
      }),
      silent,
    );
    const result = await handlers.scb_search_companies({
      filters: { categories: [{ category: "Företagsstatus", values: ["1"] }] },
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      code: string;
      details: { count: number; maxResults: number; suggestion: string };
    };
    expect(payload.code).toBe("QUERY_TOO_BROAD");
    expect(payload.details.count).toBe(MAX_RESULTS + 100);
    expect(payload.details.suggestion).toContain("Narrow the query");
  });
});

describe("MCP error passthrough", () => {
  it("returns SCB_UNAVAILABLE for HTTP 503", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => new Response("http ERROR 503", { status: 503 })),
      silent,
    );
    const result = await handlers.scb_list_variables({ objectType: "workplace" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as ScbError;
    expect(payload.code).toBe("SCB_UNAVAILABLE");
  });
});
