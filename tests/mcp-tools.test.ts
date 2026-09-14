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
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      code: string;
      nextAction?: string;
      nextTools?: string[];
      details?: { field?: string };
    };
    expect(payload.code).toBe("SCB_INVALID_QUERY");
    expect(payload.nextAction).toBe("retry_modified");
    expect(payload.nextTools).toContain("scb_list_categories");
    expect(payload.details?.field).toBe("objectType");
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
    expect(payload).not.toHaveProperty("warning");
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
    expect((payload as { warning?: string }).warning).toBeUndefined();
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
      nextAction?: string;
      nextTools?: string[];
      details: {
        count: number;
        maxResults: number;
        suggestion: string;
        appliedFilters?: unknown;
        candidateNarrowingDimensions?: unknown[];
        objectType?: string;
        layout?: string;
      };
    };
    expect(payload.code).toBe("QUERY_TOO_BROAD");
    expect(payload.nextAction).toBe("retry_modified");
    expect(payload.nextTools).toContain("scb_count_companies");
    expect(payload.details.count).toBe(MAX_RESULTS + 100);
    expect(payload.details.objectType).toBe("company");
    expect(payload.details.layout).toBe("je");
    expect(payload.details.appliedFilters).toEqual({
      categories: [{ category: "Företagsstatus", values: ["1"] }],
      variables: [],
    });
    expect(payload.details.candidateNarrowingDimensions?.length).toBeGreaterThan(0);
    expect(payload.details.suggestion).toMatch(/Smalna|paginera inte/i);
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
    expect(payload.nextAction).toBe("retry_same");
  });

  it("includes unknownName on SCB_UNKNOWN_CATEGORY", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => jsonResponse(400, { message: "Okänd kategori" })),
      silent,
    );
    const result = await handlers.scb_get_category_values({
      objectType: "company",
      category: "Bransch",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      code: string;
      nextAction?: string;
      nextTools?: string[];
      details: { unknownName?: string; field?: string };
    };
    expect(payload.code).toBe("SCB_UNKNOWN_CATEGORY");
    expect(payload.nextAction).toBe("retry_modified");
    expect(payload.nextTools).toEqual(
      expect.arrayContaining(["scb_list_categories", "scb_schema_summary", "scb_lookup_codes"]),
    );
    expect(payload.details.unknownName).toBe("Bransch");
    expect(payload.details.field).toBe("category");
  });
});

describe("MCP metadata envelope", () => {
  it("returns items + raw for list categories", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => jsonResponse(200, { Kategorier: [{ Kategori: "Företagsstatus" }] })),
      silent,
    );
    const result = await handlers.scb_list_categories({ objectType: "company" });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      items: Array<{ name: string }>;
      categories: { Kategorier: unknown[] };
      raw: { Kategorier: unknown[] };
    };
    expect(payload.items[0]?.name).toBe("Företagsstatus");
    expect(payload.raw.Kategorier).toHaveLength(1);
    expect(payload.categories.Kategorier).toHaveLength(1);
  });
});

describe("MCP empty filters warning", () => {
  it("warns on unbounded count but still calls SCB", async () => {
    const paths: string[] = [];
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        paths.push(new URL(url).pathname);
        return jsonResponse(200, 12);
      }),
      silent,
    );
    const result = await handlers.scb_count_companies({ filters: {} });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      warning?: string;
    };
    expect(payload.count).toBe(12);
    expect(payload.warning).toMatch(/Obegränsad fråga/);
    expect(paths[0]).toContain("/api/je/raknaforetag");
  });
});

describe("MCP search count zero", () => {
  it("returns empty results without fetching when count is 0", async () => {
    const paths: string[] = [];
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        paths.push(new URL(url).pathname);
        return jsonResponse(200, 0);
      }),
      silent,
    );
    const result = await handlers.scb_search_companies({
      filters: { categories: [{ category: "Företagsstatus", values: ["1"] }] },
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      returned: number;
      skippedFetch?: boolean;
    };
    expect(payload.count).toBe(0);
    expect(payload.returned).toBe(0);
    expect(payload.skippedFetch).toBe(true);
    expect(paths.some((path) => path.includes("hamta"))).toBe(false);
  });
});
