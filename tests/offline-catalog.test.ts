import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { fold } from "../src/domain/catalog.js";
import { compileStructuredQuery, structuredQuerySchema } from "../src/scb/compile/index.js";
import { searchDiscoveryIndex } from "../src/scb/discovery.js";
import {
  bundledCatalogPath,
  catalogDocCount,
  discoveryIndexFromLayout,
  loadCatalogFromDisk,
  writeCatalogToDisk,
} from "../src/scb/offline-catalog.js";
import { fixtureCatalogArtifact, diverseCatalogSpec } from "./eval/catalog.js";
import { catalogAndSearchFetch, createTestClient } from "./helpers.js";
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
  });

  it("bundled snapshot is loadable when present", () => {
    const bundled = loadCatalogFromDisk(bundledCatalogPath());
    if (!bundled) {
      return;
    }
    expect(bundled.layouts.company.categoryNames.length).toBeGreaterThan(0);
    expect(catalogDocCount(bundled)).toBeGreaterThan(0);
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
    expect(compiled.resolved.employees?.bands.map((band) => band.code)).toEqual(["2"]);
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
