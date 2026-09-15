import { describe, expect, it } from "vitest";
import { fold } from "../src/domain/catalog.js";
import { searchCodeTables } from "../src/scb/code-lookup.js";
import { buildDiscoveryIndex, searchDiscoveryIndex, sniLevel } from "../src/scb/discovery.js";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { catalogFetch, createTestClient } from "./helpers.js";
import { DIVERSE_INDUSTRY_ROWS } from "./eval/catalog.js";

const silent = createLogger("error");

const NOVEL = { code: "88421", label: "Kvantflygslöjd och orbitvarv" };

function industryTables(extra: Array<{ code: string; label: string }> = []) {
  return [
    {
      category: "Bransch",
      raw: {
        Varden: [...DIVERSE_INDUSTRY_ROWS, ...extra].map((row) => ({ Varde: row.code, Text: row.label })),
      },
    },
    {
      category: "Län",
      raw: {
        Varden: [
          { Varde: "23", Text: "Jämtlands län" },
          { Varde: "21", Text: "Gävleborgs län" },
        ],
      },
    },
    {
      category: "Storleksklass Anställda",
      raw: { Varden: [{ Varde: "4", Text: "10-19 anställda" }] },
    },
  ];
}

describe("discovery index", () => {
  it("finds a novel metadata row without a new alias entry", () => {
    const index = buildDiscoveryIndex("company", industryTables([NOVEL]));
    const hits = searchDiscoveryIndex(index, { query: "Kvantflygslöjd", kind: "industry" });
    expect(hits[0]?.code).toBe("88421");
    expect(hits[0]?.label).toMatch(/Kvantflygslöjd/i);
    expect(hits[0]?.category).toBe("Bransch");
    expect(hits[0]?.kind).toBe("industry");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("token query against the novel label still hits after rebuild", () => {
    const index = buildDiscoveryIndex("company", industryTables([NOVEL]));
    const hits = searchDiscoveryIndex(index, { query: "orbitvarv" });
    expect(hits.some((hit) => hit.code === "88421")).toBe(true);
  });

  it("returns filter-ready SNI hits with hierarchy for bygg", () => {
    const result = searchCodeTables("company", "bygg", industryTables(), 10, { kind: "industry" });
    expect(result.matches.length).toBeGreaterThan(0);
    for (const match of result.matches) {
      expect(match.category.length).toBeGreaterThan(0);
      expect(match.code.length).toBeGreaterThan(0);
      expect(match.kind).toBe("industry");
      expect(typeof match.score).toBe("number");
    }
    const labels = result.matches.map((item) => fold(item.label)).join(" ");
    expect(labels).toMatch(/bygg/);
    const top = result.matches[0];
    expect(top?.level).toBe(sniLevel(top?.code ?? ""));
    expect(typeof top?.hasChildren).toBe("boolean");
  });

  it("lists SNI children for parentCode F", () => {
    const result = searchCodeTables("company", "", industryTables(), 25, {
      kind: "industry",
      parentCode: "F",
    });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every((item) => item.parentCode === "F" || item.code.startsWith("41") || item.code.startsWith("42") || item.code.startsWith("43"))).toBe(
      true,
    );
    expect(result.matches.every((item) => item.category && item.code)).toBe(true);
  });

  it("ranks restaurang labels above unrelated industry rows", () => {
    const result = searchCodeTables("company", "restaurang", industryTables(), 8, { kind: "industry" });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.label).toMatch(/restaurang/i);
    expect(result.matches.some((item) => /restaurang/i.test(item.label))).toBe(true);
  });

  it("expands markentreprenad to Mark- och grundarbeten / anläggnings labels", () => {
    const result = searchCodeTables("company", "markentreprenad", industryTables(), 8, { kind: "industry" });
    expect(result.matches.length).toBeGreaterThan(0);
    const labels = result.matches.map((item) => item.label).join(" | ");
    expect(labels).toMatch(/mark- och grundarbeten|anläggnings/i);
    expect(result.matches.every((item) => item.category && item.code)).toBe(true);
  });

  it("expands städfirma to städning / städtjänster catalog labels", () => {
    const result = searchCodeTables("company", "städfirma", industryTables(), 8, { kind: "industry" });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.map((item) => item.label).join(" ")).toMatch(/städ|rengör/i);
    expect(result.matches.every((item) => item.category && item.code)).toBe(true);
  });
});

describe("scb_lookup_codes discovery fields", () => {
  it("returns kind, score and copies category+code for Jämtland", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({ shape: "live" })), silent);
    const result = await handlers.scb_lookup_codes({
      objectType: "company",
      query: "Jämtland",
      kind: "geography",
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      matches: Array<{ category: string; code: string; label: string; kind: string; score: number }>;
    };
    expect(payload.matches[0]?.kind).toBe("geography");
    expect(payload.matches[0]?.category.length).toBeGreaterThan(0);
    expect(payload.matches[0]?.code.length).toBeGreaterThan(0);
    expect(payload.matches[0]?.score).toBeGreaterThan(0);
    expect(payload.matches[0]?.label).toMatch(/Jämtland/i);
  });

  it("accepts empty query with parentCode", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({ shape: "live" })), silent);
    const result = await handlers.scb_lookup_codes({
      objectType: "company",
      query: "",
      kind: "industry",
      parentCode: "F",
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      matches: Array<{ code: string; parentCode?: string; category: string }>;
    };
    expect(payload.matches.length).toBeGreaterThan(0);
    expect(payload.matches.every((item) => item.category && item.code)).toBe(true);
  });
});
