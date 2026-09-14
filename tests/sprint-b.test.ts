import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { MAX_RESULTS } from "../src/scb/types.js";
import { catalogFetch, createTestClient, jsonResponse } from "./helpers.js";

const silent = createLogger("error");

describe("scb_schema_summary", () => {
  it("returns a compact JE catalog from mocked koptakategorier", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({})), silent);
    const result = await handlers.scb_schema_summary({ objectType: "company" });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      objectType: string;
      layout: string;
      categories: Array<{
        name: string;
        kind: string;
        serialization: string;
        counterpartOnWorkplace?: string;
        sampleValues?: unknown[];
      }>;
      variables: Array<{ name: string; typicalOperators: string[] }>;
      operators: Array<{ name: string }>;
      warnings: string[];
    };
    expect(payload.objectType).toBe("company");
    expect(payload.layout).toBe("je");
    const status = payload.categories.find((item) => item.name === "Företagsstatus");
    const geo = payload.categories.find((item) => item.name === "Säteslän");
    const sni = payload.categories.find((item) => item.name === "Bransch");
    expect(status?.kind).toBe("status");
    expect(status?.serialization).toBe("top-level");
    expect(status?.sampleValues?.length).toBeGreaterThan(0);
    expect(geo?.kind).toBe("geography");
    expect(geo?.counterpartOnWorkplace).toBe("Län");
    expect(sni?.kind).toBe("industry");
    expect(sni?.sampleValues).toBeUndefined();
    expect(payload.operators.some((item) => item.name === "Innehaller")).toBe(true);
    expect(payload.variables[0]?.typicalOperators).toContain("Innehaller");
    expect(payload.warnings.join(" ")).toMatch(/säte/i);
    expect(result.content[0]?.text.length ?? 0).toBeLessThan(25_000);
  });
});

describe("scb_lookup_codes", () => {
  it("resolves Gävleborg on AE without dumping the table", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({})), silent);
    const result = await handlers.scb_lookup_codes({
      objectType: "workplace",
      query: "Gävleborg",
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      matches: Array<{ category: string; code: string; label: string }>;
      returned: number;
    };
    expect(payload.matches[0]).toMatchObject({
      category: "Län",
      code: "21",
      label: "Gävleborgs län",
    });
    expect(payload.returned).toBeGreaterThan(0);
    expect(payload.returned).toBeLessThanOrEqual(25);
  });

  it("finds status, size and SNI text", async () => {
    const verksam = await createToolHandlers(createTestClient(catalogFetch({})), silent).scb_lookup_codes({
      objectType: "company",
      query: "verksam",
    });
    const size = await createToolHandlers(createTestClient(catalogFetch({})), silent).scb_lookup_codes({
      objectType: "company",
      query: "10-19",
    });
    const sni = await createToolHandlers(createTestClient(catalogFetch({})), silent).scb_lookup_codes({
      objectType: "workplace",
      query: "Bygg",
    });
    expect(JSON.parse(verksam.content[0]?.text ?? "{}").matches[0].code).toBe("1");
    expect(JSON.parse(size.content[0]?.text ?? "{}").matches[0].label).toMatch(/10-19/);
    expect(JSON.parse(sni.content[0]?.text ?? "{}").matches[0].label).toMatch(/Bygg/i);
  });
});

describe("scb_get_category_values query/limit", () => {
  it("truncates and filters instead of dumping the full table", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({})), silent);
    const filtered = await handlers.scb_get_category_values({
      objectType: "workplace",
      category: "Län",
      query: "Gävle",
      limit: 1,
    });
    const payload = JSON.parse(filtered.content[0]?.text ?? "{}") as {
      total: number;
      returned: number;
      truncated: boolean;
      items: Array<{ name: string }>;
      raw?: unknown;
    };
    expect(payload.total).toBe(1);
    expect(payload.returned).toBe(1);
    expect(payload.items[0]?.name).toBe("21");
    expect(payload.raw).toBeUndefined();

    const truncated = await handlers.scb_get_category_values({
      objectType: "workplace",
      category: "Bransch",
      limit: 1,
    });
    const truncatedPayload = JSON.parse(truncated.content[0]?.text ?? "{}") as {
      total: number;
      returned: number;
      truncated: boolean;
    };
    expect(truncatedPayload.total).toBe(3);
    expect(truncatedPayload.returned).toBe(1);
    expect(truncatedPayload.truncated).toBe(true);
  });
});

describe("operator validation", () => {
  it("rejects Contains with allowedOperators", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({})), silent);
    const result = await handlers.scb_count_companies({
      filters: {
        variables: [{ variable: "Firma", operator: "Contains", value: "Bygg" }],
      },
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      code: string;
      details: { allowedOperators?: string[]; field?: string };
    };
    expect(payload.code).toBe("SCB_INVALID_QUERY");
    expect(payload.details.allowedOperators).toContain("Innehaller");
  });
});

describe("nearestNames on unknown category", () => {
  it("includes catalog suggestions after a warm list", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({})), silent);
    await handlers.scb_list_categories({ objectType: "company" });
    const result = await handlers.scb_get_category_values({
      objectType: "company",
      category: "Län",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      code: string;
      details: { nearestNames?: string[]; layoutHint?: string };
    };
    expect(payload.code).toBe("SCB_UNKNOWN_CATEGORY");
    expect(payload.details.nearestNames).toEqual(expect.arrayContaining(["Säteslän"]));
    expect(payload.details.layoutHint).toMatch(/Säteslän|workplace/i);
  });
});

describe("QUERY_TOO_BROAD uses catalog names when cached", () => {
  it("fills categoryHint from koptakategorier", async () => {
    const fetchImpl = catalogFetch({});
    const client = createTestClient(async (url, init) => {
      if (url.includes("raknaforetag")) {
        return jsonResponse(200, MAX_RESULTS + 50);
      }
      return fetchImpl(url, init);
    });
    const handlers = createToolHandlers(client, silent);
    await handlers.scb_list_categories({ objectType: "company" });
    const result = await handlers.scb_search_companies({
      filters: { categories: [{ category: "Företagsstatus", values: ["1"] }] },
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      details: { candidateNarrowingDimensions: Array<{ dimension: string; categoryHint?: string }> };
    };
    const geo = payload.details.candidateNarrowingDimensions.find((item) => item.dimension === "geography");
    expect(geo?.categoryHint).toMatch(/Säteslän/);
  });
});

describe("branchLevel warning", () => {
  it("warns when Branschniva is set on a geography category", async () => {
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        if (url.includes("raknaforetag")) {
          return jsonResponse(200, 3);
        }
        return jsonResponse(200, []);
      }),
      silent,
    );
    const result = await handlers.scb_count_companies({
      filters: {
        categories: [{ category: "Säteslän", values: ["21"], branchLevel: 2 }],
      },
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { warning?: string; warnings?: string[] };
    expect(payload.warning).toMatch(/Branschniva|branchLevel/);
    expect(payload.warnings?.join(" ")).toMatch(/geography|geografi|bransch/i);
  });
});

describe("scb_filter_hints", () => {
  it("returns recommended categories for industry_and_place", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({})), silent);
    const result = await handlers.scb_filter_hints({ questionClass: "industry_and_place" });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      hints: Array<{ objectType: string; recommendedCategories: string[] }>;
    };
    expect(payload.hints[0]?.objectType).toBe("workplace");
    expect(payload.hints[0]?.recommendedCategories.join(" ")).toMatch(/Län|Bransch/);
  });
});
