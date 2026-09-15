import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { fold } from "../src/domain/catalog.js";
import { SlidingWindowRateLimiter } from "../src/scb/rate-limit.js";
import { catalogAndSearchFetch, catalogFetch, createTestClient, liveConstructionCatalogSpec } from "./helpers.js";
import { LIVE_AE_SEARCH_ROW } from "./fixtures/live-scb-metadata.js";

const silent = createLogger("error");

const SUNDSVALL_QUERY = {
  objectType: "workplace" as const,
  industry: { query: "bygg" },
  geography: { type: "municipality" as const, value: "Sundsvall" },
  employees: { min: 20, max: 30 },
  maxRows: 50,
  fields: ["name", "organizationNumber", "municipality", "employeeCount"],
};

function constructionHandlers(count = 3, results: unknown[] = [LIVE_AE_SEARCH_ROW]) {
  return createToolHandlers(
    createTestClient(catalogAndSearchFetch(liveConstructionCatalogSpec(), { count, results })),
    silent,
  );
}

describe("scb_query statuses", () => {
  it("returns choose (not a tool error) for ambiguous bygg with geography/employees resolved", async () => {
    const handlers = constructionHandlers();
    const result = await handlers.scb_query(SUNDSVALL_QUERY);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      status: string;
      ok: boolean;
      reason: string;
      candidates: Array<{ category: string; code: string; label: string; why?: string }>;
      resolved: { geography?: { category: string }; employees?: { category: string } };
      coverage: Array<{ constraint: string; relation: string; exact: boolean }>;
    };
    expect(payload.status).toBe("choose");
    expect(payload.ok).toBe(false);
    expect(payload.candidates.length).toBeGreaterThan(0);
    expect(payload.candidates.length).toBeLessThanOrEqual(5);
    expect(payload.candidates.some((item) => item.code === "41")).toBe(true);
    expect(payload.candidates.some((item) => item.code === "30")).toBe(true);
    expect(payload.candidates.every((item) => item.category && item.code && item.label)).toBe(true);
    expect(payload.candidates[0]?.why).toMatch(/discovery-träff/);
    expect(fold(payload.resolved.geography?.category ?? "")).toBe("kommun");
    expect(payload.coverage.some((item) => item.constraint === "employees" && item.relation === "superset" && item.exact === false)).toBe(
      true,
    );
    expect(payload.reason).toMatch(/tvetydig|candidates/i);
  });

  it("second scb_query with industry.codes returns ok rows and employee superset", async () => {
    const handlers = constructionHandlers();
    const result = await handlers.scb_query({
      ...SUNDSVALL_QUERY,
      industry: { codes: ["41"] },
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      status: string;
      ok: boolean;
      count: number;
      results: Array<Record<string, unknown>>;
      filters: { categories: Array<{ category: string; values: string[] }> };
      coverage: Array<{ constraint: string; relation: string; exact: boolean }>;
    };
    expect(payload.status).toBe("ok");
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(3);
    expect(payload.results.length).toBeGreaterThan(0);
    const industry = payload.filters.categories.find((item) => fold(item.category).includes("bransch"));
    expect(industry?.values).toEqual(["41"]);
    expect(payload.coverage.some((item) => item.constraint === "employees" && item.relation === "superset")).toBe(
      true,
    );
  });

  it("multi-code industry.codes ORs 41/42/43", async () => {
    const handlers = constructionHandlers();
    const result = await handlers.scb_query({
      objectType: "workplace",
      industry: { codes: ["41", "42", "43"] },
      geography: { type: "municipality", value: "Sundsvall" },
      employees: { min: 20, max: 30 },
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      status: string;
      filters: { categories: Array<{ values: string[] }> };
    };
    expect(payload.status).toBe("ok");
    const industry = payload.filters.categories.find((item) => item.values.includes("41"));
    expect(industry?.values).toEqual(expect.arrayContaining(["41", "42", "43"]));
  });

  it("returns impossible for empty industry discovery", async () => {
    const handlers = constructionHandlers();
    const result = await handlers.scb_query({
      objectType: "workplace",
      industry: { query: "xyzzy-not-an-sni" },
      geography: { type: "municipality", value: "Sundsvall" },
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      status: string;
      ok: boolean;
      reason: string;
      candidates: unknown[];
    };
    expect(payload.status).toBe("impossible");
    expect(payload.ok).toBe(false);
    expect(payload.reason.length).toBeGreaterThan(0);
    expect(payload.candidates).toEqual([]);
  });

  it("returns impossible for unrepresentable geography", async () => {
    const handlers = constructionHandlers();
    const result = await handlers.scb_query({
      objectType: "company",
      geography: { type: "county", value: "Narnia" },
      industry: { query: "bygg" },
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { status: string };
    expect(payload.status).toBe("impossible");
  });

  it("scb_count_then_fetch remains an alias of scb_query", async () => {
    const handlers = constructionHandlers();
    const a = await handlers.scb_query(SUNDSVALL_QUERY);
    const b = await handlers.scb_count_then_fetch(SUNDSVALL_QUERY);
    expect(JSON.parse(a.content[0]?.text ?? "{}").status).toBe("choose");
    expect(JSON.parse(b.content[0]?.text ?? "{}").status).toBe("choose");
  });

  it("scb_discover is an alias of scb_lookup_codes", async () => {
    const handlers = constructionHandlers();
    const lookup = await handlers.scb_lookup_codes({ objectType: "workplace", query: "Sundsvall" });
    const discover = await handlers.scb_discover({ objectType: "workplace", query: "Sundsvall" });
    expect(lookup.isError).toBeUndefined();
    expect(discover.isError).toBeUndefined();
    const a = JSON.parse(lookup.content[0]?.text ?? "{}") as { matches: Array<{ code: string }> };
    const b = JSON.parse(discover.content[0]?.text ?? "{}") as { matches: Array<{ code: string }> };
    expect(a.matches[0]?.code).toBe("2281");
    expect(b.matches[0]?.code).toBe("2281");
  });
});

describe("metadata warm", () => {
  it("warms JE/AE category lists and discovery indexes", async () => {
    const client = createTestClient(catalogFetch({ shape: "live" }), {
      rateLimiter: new SlidingWindowRateLimiter(1000),
    });
    const result = await client.warmMetadataCache();
    expect(result.skipped).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.warmed).toEqual(
      expect.arrayContaining([
        "listCategories:company",
        "listCategories:workplace",
        "listVariables:company",
        "discovery:company:industry",
        "discovery:workplace:geography",
      ]),
    );
    expect(client.cachedCategoryNames("company")?.length).toBeGreaterThan(0);
    expect(client.cachedCategoryNames("workplace")?.length).toBeGreaterThan(0);
  });

  it("skips warm when metadata cache is bypassed", async () => {
    const client = createTestClient(catalogFetch({ shape: "live" }), { bypassMetadataCache: true });
    const result = await client.warmMetadataCache();
    expect(result.skipped).toBe(true);
    expect(result.warmed).toEqual([]);
  });

  it("does not throw when a warm request fails", async () => {
    const client = createTestClient(
      async () => {
        throw new Error("SCB down");
      },
      { rateLimiter: new SlidingWindowRateLimiter(1000), sleep: async () => {} },
    );
    const result = await client.warmMetadataCache();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.warmed).toEqual([]);
  });
});
