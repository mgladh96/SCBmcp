import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { fold } from "../src/domain/catalog.js";
import { MAX_RESULTS } from "../src/scb/types.js";
import { catalogAndSearchFetch, catalogFetch, createTestClient, jsonResponse, liveConstructionCatalogSpec } from "./helpers.js";
import { LIVE_TWO_DIGIT_BRANSCH_CATEGORY } from "./fixtures/live-scb-metadata.js";

const silent = createLogger("error");

const GOLDEN_QUERY = {
  objectType: "company" as const,
  industry: { query: "bygg" },
  geography: { type: "county" as const, value: "Jämtland" },
  employees: { min: 10, max: 15 },
  maxRows: 50,
  fields: ["name", "organizationNumber", "municipality", "employeeCount"],
};

const GOLDEN_ROW = {
  Företagsnamn: "Jämtlands Bygg AB",
  Namn: "Jämtlands Bygg AB",
  "OrgNr (10 siffror)": "5560747569",
  "Säteskommun, text": "Östersund",
  "Säteskommun, kod": "2380",
  "Storleksklass Anställda, text": "10-19 anställda",
  "Storleksklass Anställda, kod": "4",
  Reklam: "11",
  Telefon: "should-not-leak",
};

const LIVE_FETCH_ROW = {
  Namn: "Jämtlands Bygg AB",
  "OrgNr (10 siffror)": "5560747569",
  "Säteskommun, text": "Östersund",
  "Säteskommun, kod": "2380",
  Anställda: "10-19 anställda",
  Reklam: "11",
  Telefon: "should-not-leak",
};

function goldenHandlers(count = 1, results: unknown[] = [GOLDEN_ROW]) {
  return createToolHandlers(
    createTestClient(catalogAndSearchFetch({ shape: "live" }, { count, results })),
    silent,
  );
}

describe("scb_compile_query", () => {
  it("rejects NL text and bare industry strings", async () => {
    const handlers = goldenHandlers();
    const text = await handlers.scb_compile_query({
      objectType: "company",
      text: "byggföretag i Jämtland",
    });
    expect(text.isError).toBe(true);
    expect(JSON.parse(text.content[0]?.text ?? "{}").details.origin).toBe("nl_rejected");

    const bare = await handlers.scb_compile_query({ objectType: "company", industry: "bygg" });
    expect(bare.isError).toBe(true);
  });

  it("returns compact compiled filters without a catalog dump", async () => {
    const handlers = goldenHandlers();
    const result = await handlers.scb_compile_query(GOLDEN_QUERY);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      ok: boolean;
      layout: string;
      filters: { categories: Array<{ category: string; values: string[] }> };
      coverage: Array<{ constraint: string; exact: boolean; relation: string }>;
      resolved: { fields: Record<string, string[]> };
    };
    expect(payload.ok).toBe(true);
    expect(payload.layout).toBe("je");
    expect(payload.filters.categories.some((item) => fold(item.category).includes("sateslan"))).toBe(true);
    expect(payload.filters.categories.some((item) => item.category === "Län")).toBe(false);
    expect(payload.coverage.some((item) => item.constraint === "employees" && item.relation === "superset" && item.exact === false)).toBe(
      true,
    );
    expect(payload.resolved.fields.name).toBeDefined();
    expect(result.content[0]?.text ?? "").not.toMatch(/Id_Kategori/);
    expect(result.content[0]?.text?.length ?? 0).toBeLessThan(15_000);
  });
});

describe("scb_count_then_fetch", () => {
  it("preserves coverage and projects semantic keys on the golden path", async () => {
    const handlers = goldenHandlers();
    const result = await handlers.scb_count_then_fetch(GOLDEN_QUERY);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      ok: boolean;
      count: number;
      coverage: Array<{ constraint: string; relation: string; exact: boolean }>;
      resolved: { fields: Record<string, string[]>; geography?: { category: string } };
      results: Array<Record<string, unknown>>;
      projectedFields: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.coverage.some((item) => item.constraint === "employees" && item.relation === "superset")).toBe(
      true,
    );
    expect(payload.resolved.geography?.category).not.toBe("Län");
    expect(fold(payload.resolved.geography?.category ?? "")).toBe(fold("SätesLän"));
    expect(payload.results[0]).toMatchObject({
      name: "Jämtlands Bygg AB",
      organizationNumber: "5560747569",
      municipality: "Östersund",
      employeeCount: "10-19 anställda",
      Reklam: "11",
    });
    expect(payload.results[0]?.Telefon).toBeUndefined();
    expect(payload.projectedFields).toEqual(
      expect.arrayContaining(["name", "organizationNumber", "municipality", "employeeCount", "Reklam"]),
    );
    expect(result.content[0]?.text ?? "").not.toMatch(/Id_Kategori/);
  });

  it("returns SCB_NO_MATCHES with coverage and no hamta when count is 0", async () => {
    const paths: string[] = [];
    const catalog = catalogFetch({ shape: "live" });
    const handlers = createToolHandlers(
      createTestClient(async (url, init) => {
        paths.push(new URL(url).pathname);
        if (url.includes("rakna")) {
          return jsonResponse(200, 0);
        }
        if (url.includes("hamta")) {
          throw new Error("should not fetch");
        }
        return catalog(url, init);
      }),
      silent,
    );
    const result = await handlers.scb_count_then_fetch(GOLDEN_QUERY);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      code: string;
      nextAction: string;
      details: { coverage?: unknown[]; count?: number };
    };
    expect(payload.code).toBe("SCB_NO_MATCHES");
    expect(payload.nextAction).toBe("retry_modified");
    expect(payload.details.coverage?.length).toBeGreaterThan(0);
    expect(payload.details.count).toBe(0);
    expect(paths.some((path) => path.includes("hamta"))).toBe(false);
  });

  it("attaches coverage to QUERY_TOO_BROAD", async () => {
    const catalog = catalogFetch({ shape: "live" });
    const handlers = createToolHandlers(
      createTestClient(async (url, init) => {
        if (url.includes("rakna")) {
          return jsonResponse(200, MAX_RESULTS + 10);
        }
        if (url.includes("hamta")) {
          throw new Error("should not fetch");
        }
        return catalog(url, init);
      }),
      silent,
    );
    const result = await handlers.scb_count_then_fetch(GOLDEN_QUERY);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      code: string;
      details: { coverage?: Array<{ constraint: string }>; resolved?: unknown };
    };
    expect(payload.code).toBe("QUERY_TOO_BROAD");
    expect(payload.details.coverage?.some((item) => item.constraint === "employees")).toBe(true);
    expect(payload.details.resolved).toBeDefined();
  });

  it("accepts already-compiled filters", async () => {
    const handlers = goldenHandlers(2, [GOLDEN_ROW, GOLDEN_ROW]);
    const result = await handlers.scb_count_then_fetch({
      objectType: "company",
      filters: {
        categories: [{ category: "Företagsstatus", values: ["1"] }],
      },
      fields: ["name", "organizationNumber"],
      maxRows: 50,
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      coverage: unknown[];
      results: Array<Record<string, unknown>>;
      warnings: string[];
    };
    expect(payload.coverage.length).toBeGreaterThan(0);
    expect(payload.results[0]?.name).toBe("Jämtlands Bygg AB");
    expect(payload.warnings.join(" ")).toMatch(/redan kompilerade/i);
  });

  it("omits Namn/OrgNr until hamta requests those variables; municipality still returns", async () => {
    const catalog = catalogFetch({ shape: "live" });
    const hamtaBodies: unknown[] = [];
    const handlers = createToolHandlers(
      createTestClient(async (url, init) => {
        const path = new URL(url).pathname;
        if (path.includes("rakna")) {
          return jsonResponse(200, 1);
        }
        if (path.includes("hamta")) {
          const body = init.body ? JSON.parse(init.body) : {};
          hamtaBodies.push(body);
          const requested = ((body as { variabler?: Array<{ Variabel?: string }> }).variabler ?? []).map(
            (item) => item.Variabel ?? "",
          );
          const row: Record<string, unknown> = {
            "Säteskommun, text": "Östersund",
            Reklam: "11",
          };
          if (requested.some((name) => /namn|firma/i.test(name))) {
            row.Namn = "Jämtlands Bygg AB";
          }
          if (requested.some((name) => /orgnr/i.test(name))) {
            row["OrgNr (10 siffror)"] = "5560747569";
          }
          return jsonResponse(200, [row]);
        }
        return catalog(url, init);
      }),
      silent,
    );

    const result = await handlers.scb_count_then_fetch(GOLDEN_QUERY);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      results: Array<Record<string, unknown>>;
      warnings: string[];
    };
    const hamta = hamtaBodies[0] as { variabler?: Array<{ Variabel: string; Operator: string }> };
    expect(hamta.variabler?.some((item) => /namn|firma|företagsnamn/i.test(item.Variabel))).toBe(true);
    expect(hamta.variabler?.some((item) => /orgnr/i.test(item.Variabel))).toBe(true);
    expect(hamta.variabler?.every((item) => item.Operator === "Finns")).toBe(true);
    expect(hamta.variabler?.some((item) => /sateskommun|anstalld/i.test(fold(item.Variabel)))).toBe(false);
    expect(payload.results[0]).toMatchObject({
      name: "Jämtlands Bygg AB",
      organizationNumber: "5560747569",
      municipality: "Östersund",
      Reklam: "11",
    });
    expect(payload.warnings.join(" ")).toMatch(/Finns/);
  });

  it("golden bygg without section F uses 41/42/43 and projects Namn/OrgNr", async () => {
    const handlers = createToolHandlers(
      createTestClient(
        catalogAndSearchFetch(liveConstructionCatalogSpec(), { count: 14, results: [LIVE_FETCH_ROW] }),
      ),
      silent,
    );
    const result = await handlers.scb_count_then_fetch(GOLDEN_QUERY);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      ok: boolean;
      count: number;
      filters: { categories: Array<{ category: string; values: string[]; branchLevel?: number }> };
      coverage: Array<{ constraint: string; relation: string; exact: boolean }>;
      results: Array<Record<string, unknown>>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(14);
    const industry = payload.filters.categories.find((item) => fold(item.category).includes("bransch"));
    expect(industry?.category).toBe(LIVE_TWO_DIGIT_BRANSCH_CATEGORY);
    expect([...industry?.values ?? []].sort()).toEqual(["41", "42", "43"]);
    expect(industry?.values.some((code) => ["22", "30", "46"].includes(code))).toBe(false);
    expect(payload.coverage.find((item) => item.constraint === "industry")?.relation).toBe("partial");
    expect(payload.results[0]).toMatchObject({
      name: "Jämtlands Bygg AB",
      organizationNumber: "5560747569",
      municipality: "Östersund",
      Reklam: "11",
    });
  });
});
