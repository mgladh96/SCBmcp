import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { localRateLimited, ScbError } from "../src/domain/errors.js";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { fold } from "../src/domain/catalog.js";
import { compileStructuredQuery, structuredQuerySchema } from "../src/scb/compile/index.js";
import { searchDiscoveryIndex } from "../src/scb/discovery.js";
import {
  buildCatalogFromClient,
  bundledCatalogPath,
  catalogDocCount,
  discoveryIndexFromLayout,
  loadCatalogFromDisk,
  writeCatalogToDisk,
  type CatalogMetadataSource,
} from "../src/scb/offline-catalog.js";
import { SlidingWindowRateLimiter } from "../src/scb/rate-limit.js";
import { withRateLimitRetry } from "../src/scb/rate-limit-retry.js";
import type { ObjectType } from "../src/scb/types.js";
import { fixtureCatalogArtifact, diverseCatalogSpec } from "./eval/catalog.js";
import { catalogAndSearchFetch, catalogFetch, createTestClient } from "./helpers.js";
import { LIVE_JE_SEARCH_ROW } from "./fixtures/live-scb-metadata.js";

const silent = createLogger("error");

const STAD_QUERY = {
  objectType: "company" as const,
  industry: { query: "städ" },
  geography: { type: "municipality" as const, value: "Östersund" },
  employees: { min: 5, max: 9 },
  maxRows: 50,
  fields: ["name", "organizationNumber", "municipality", "employeeCount"],
};

describe("offline catalog load", () => {
  it("round-trips a fixture artifact from disk", () => {
    const artifact = fixtureCatalogArtifact();
    expect(artifact.formatVersion).toBe(1);
    expect(artifact.source).toBe("fixture");
    expect(artifact.builtAt).toMatch(/^\d{4}-/);
    expect(artifact.sourceVersion.length).toBeGreaterThan(0);
    expect(catalogDocCount(artifact)).toBeGreaterThan(20);

    const dir = join(tmpdir(), `scb-catalog-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "catalog.json");
    writeCatalogToDisk(path, artifact);
    const loaded = loadCatalogFromDisk(path);
    expect(loaded?.builtAt).toBe(artifact.builtAt);
    expect(loaded?.layouts.company.tables.some((table) => table.kind === "industry")).toBe(true);
    expect(loaded?.layouts.company.tables.some((table) => table.kind === "geography")).toBe(true);
    expect(loaded?.layouts.company.tables.some((table) => table.kind === "size")).toBe(true);
    const size = loaded?.layouts.company.tables.find((table) => table.kind === "size");
    expect(size?.rows.find((row) => /5-9/.test(row.label))?.code).toBe("3");
    expect(size?.rows.find((row) => /1-4/.test(row.label))?.code).toBe("2");
  });

  it("bundled snapshot is loadable when present", () => {
    const bundled = loadCatalogFromDisk(bundledCatalogPath());
    if (!bundled) {
      return;
    }
    expect(bundled.layouts.company.categoryNames.length).toBeGreaterThan(0);
    expect(catalogDocCount(bundled)).toBeGreaterThan(0);
    expect(bundled.source).toBe("fixture");
    const size = bundled.layouts.company.tables.find((table) => table.kind === "size");
    expect(size?.rows.find((row) => /5-9/.test(row.label))?.code).toBe("3");
    expect(size?.rows.find((row) => /1-4/.test(row.label))?.code).toBe("2");
  });
});

describe("local catalog search", () => {
  const catalog = fixtureCatalogArtifact();
  const index = discoveryIndexFromLayout(catalog.layouts.company);

  it("finds the cleaning/facility branch for städ and städning", () => {
    for (const query of ["städ", "städning"]) {
      const hits = searchDiscoveryIndex(index, { query, kind: "industry" });
      expect(hits.length).toBeGreaterThan(0);
      const labels = hits.map((hit) => hit.label).join(" ");
      expect(labels).toMatch(/städ|rengör|fastighetsservice/i);
      expect(hits.some((hit) => hit.code === "81" || hit.code.startsWith("81") || hit.code === "N")).toBe(true);
      expect(hits[0]?.category).toBeTruthy();
      expect(hits[0]?.code).toBeTruthy();
    }
  });

  it("resolves Östersund to municipality code 2380", () => {
    const hits = searchDiscoveryIndex(index, { query: "Östersund", kind: "geography" });
    expect(hits[0]?.code).toBe("2380");
    expect(hits[0]?.label).toMatch(/Östersund/i);
  });
});

describe("compile against local catalog", () => {
  it("maps employees 5–9 to the exact SCB band without live listCategories", async () => {
    const catalog = fixtureCatalogArtifact();
    const client = createTestClient(
      async () => {
        throw new Error("live metadata should not be called");
      },
      { offlineCatalog: catalog },
    );
    const spy = vi.spyOn(client, "listCategories");
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "company",
        employees: { min: 5, max: 9 },
        status: "any",
      }),
      client,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(compiled.ok).toBe(true);
    const emp = compiled.coverage.find((item) => item.constraint === "employees");
    expect(emp?.relation).toBe("exact");
    expect(emp?.exact).toBe(true);
    expect(compiled.resolved.employees?.bands.map((band) => band.code)).toEqual(["3"]);
    spy.mockRestore();
  });

  it("scb_query uses the catalog and does not call listCategories", async () => {
    const catalog = fixtureCatalogArtifact();
    const client = createTestClient(
      catalogAndSearchFetch(diverseCatalogSpec(), { count: 2, results: [LIVE_JE_SEARCH_ROW] }),
      { offlineCatalog: catalog },
    );
    const listSpy = vi.spyOn(client, "listCategories");
    const valuesSpy = vi.spyOn(client, "getCategoryValues");
    const handlers = createToolHandlers(client, silent);
    const result = await handlers.scb_query(STAD_QUERY);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      status: string;
      ok: boolean;
      count?: number;
      filters: { categories: Array<{ category: string; values: string[] }> };
      resolved: {
        geography?: { codes: Array<{ code: string }> };
        industry?: { codes: Array<{ code: string; label: string }> };
        employees?: { bands: Array<{ code: string; label: string }> };
      };
      coverage: Array<{ constraint: string; relation: string; exact: boolean }>;
      candidates?: Array<{ code: string }>;
    };
    expect(listSpy).not.toHaveBeenCalled();
    expect(valuesSpy).not.toHaveBeenCalled();
    expect(payload.status === "ok" || payload.status === "choose").toBe(true);
    expect(payload.resolved.geography?.codes.some((item) => item.code === "2380")).toBe(true);
    expect(payload.coverage.some((item) => item.constraint === "employees" && item.relation === "exact")).toBe(
      true,
    );
    expect(fold(payload.filters.categories.find((item) => fold(item.category).includes("kommun"))?.category ?? "")).toBe(
      fold("Säteskommun"),
    );

    if (payload.status === "ok") {
      expect(payload.ok).toBe(true);
      expect(payload.count).toBe(2);
      const labels = (payload.resolved.industry?.codes ?? []).map((item) => item.label).join(" ");
      expect(labels).toMatch(/städ|rengör|fastighetsservice/i);
    } else {
      expect(payload.candidates?.some((item) => item.code.startsWith("81") || item.code === "N")).toBe(true);
      const second = await handlers.scb_query({
        ...STAD_QUERY,
        industry: { codes: ["81"] },
      });
      const again = JSON.parse(second.content[0]?.text ?? "{}") as { status: string; ok: boolean };
      expect(again.status).toBe("ok");
      expect(again.ok).toBe(true);
    }
    listSpy.mockRestore();
    valuesSpy.mockRestore();
  });
});

describe("withRateLimitRetry", () => {
  it("waits retryAfterMs and retries once on SCB_RATE_LIMITED", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const slept: number[] = [];
    const value = await withRateLimitRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw localRateLimited(42, 10);
        }
        return "ok";
      },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
        onWait: (waitMs) => {
          waits.push(waitMs);
        },
      },
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(2);
    expect(waits).toEqual([42]);
    expect(slept).toEqual([42]);
  });

  it("does not retry non-rate-limit errors", async () => {
    const error = new ScbError("SCB_UNKNOWN_CATEGORY", "unknown", false);
    await expect(
      withRateLimitRetry(async () => {
        throw error;
      }, { sleep: async () => {} }),
    ).rejects.toBe(error);
  });
});

describe("catalog refresh rate-limit wait", () => {
  it("retries listCategories after SCB_RATE_LIMITED", async () => {
    const attempts: Record<ObjectType, number> = { company: 0, workplace: 0 };
    const catalog = await buildCatalogFromClient(stubCatalogSource({
      listCategories: async (objectType) => {
        attempts[objectType] += 1;
        if (attempts[objectType] === 1) {
          throw localRateLimited(5, 10);
        }
        return categoryListFor(objectType);
      },
    }), { sleep: async () => {} });
    expect(attempts.company).toBe(2);
    expect(attempts.workplace).toBe(2);
    expect(catalog.layouts.company.tables.some((table) => table.category === "Säteskommun")).toBe(true);
    expect(catalog.layouts.workplace.tables.some((table) => table.category === "Kommun")).toBe(true);
  });

  it("retries getCategoryValues after SCB_RATE_LIMITED instead of skipping the table", async () => {
    let geographyAttempts = 0;
    const catalog = await buildCatalogFromClient(stubCatalogSource({
      getCategoryValues: async (_objectType, category) => {
        if (category === "Säteskommun" || category === "Kommun") {
          geographyAttempts += 1;
          if (geographyAttempts === 1) {
            throw localRateLimited(10, 10);
          }
        }
        return codeTableFor(category);
      },
    }), { sleep: async () => {} });
    expect(geographyAttempts).toBeGreaterThan(1);
    expect(catalog.layouts.company.tables.find((table) => table.category === "Säteskommun")?.rows).toEqual([
      { code: "2380", label: "Östersund" },
    ]);
  });

  it("rethrows SCB_RATE_LIMITED from getCategoryValues after retry is exhausted", async () => {
    await expect(
      buildCatalogFromClient(stubCatalogSource({
        getCategoryValues: async () => {
          throw localRateLimited(10, 10);
        },
      }), { sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "SCB_RATE_LIMITED" });
  });

  it("still skips unknown-category kodtabell failures", async () => {
    const catalog = await buildCatalogFromClient(stubCatalogSource({
      getCategoryValues: async (_objectType, category) => {
        if (category === "Bransch") {
          throw new ScbError("SCB_UNKNOWN_CATEGORY", "unknown", false);
        }
        return codeTableFor(category);
      },
    }), { sleep: async () => {} });
    expect(catalog.layouts.company.tables.some((table) => table.category === "Bransch")).toBe(false);
    expect(catalog.layouts.company.tables.some((table) => table.category === "Säteskommun")).toBe(true);
  });

  it("buildCatalogFromClient waits and retries under the 10 calls / 10s limiter", async () => {
    let now = 1_000_000;
    const waits: number[] = [];
    const client = createTestClient(catalogFetch({ shape: "live" }), {
      offlineCatalog: false,
      rateLimiter: new SlidingWindowRateLimiter(10, 10_000, () => now),
    });
    const catalog = await buildCatalogFromClient(client, {
      sleep: async (ms) => {
        now += ms;
      },
      onRateLimitWait: (waitMs) => {
        waits.push(waitMs);
      },
    });
    expect(waits.length).toBeGreaterThan(0);
    expect(waits[0]).toBeGreaterThan(0);
    expect(catalog.layouts.company.tables).toHaveLength(7);
    expect(catalog.layouts.workplace.tables).toHaveLength(6);
    expect(catalog.layouts.company.tables.some((table) => table.kind === "industry")).toBe(true);
    expect(catalog.layouts.workplace.tables.some((table) => table.kind === "industry")).toBe(true);
    expect(catalog.layouts.company.tables.some((table) => table.kind === "geography")).toBe(true);
    expect(catalog.layouts.workplace.tables.some((table) => table.kind === "geography")).toBe(true);
  });
});

function categoryListFor(objectType: ObjectType): unknown {
  return {
    Kategorier:
      objectType === "company"
        ? [{ Kategori: "Säteskommun" }, { Kategori: "Bransch" }, { Kategori: "Företagsstatus" }]
        : [{ Kategori: "Kommun" }, { Kategori: "Bransch" }, { Kategori: "Arbetsställestatus" }],
  };
}

function codeTableFor(category: string): unknown {
  if (category === "Säteskommun" || category === "Kommun") {
    return { Koder: [{ Kod: "2380", Text: "Östersund" }] };
  }
  if (category === "Bransch") {
    return { Koder: [{ Kod: "81", Text: "Städtjänster" }] };
  }
  return { Koder: [{ Kod: "1", Text: "verksam" }] };
}

function stubCatalogSource(
  overrides: Partial<CatalogMetadataSource> = {},
): CatalogMetadataSource {
  return {
    listCategories: async (objectType) => categoryListFor(objectType),
    listVariables: async () => ({ Variabler: [{ Variabel: "Namn" }] }),
    getCategoryValues: async (_objectType, category) => codeTableFor(category),
    ...overrides,
  };
}
