import { describe, expect, it } from "vitest";
import { ScbError } from "../src/domain/errors.js";
import { voiceCompanyPayload } from "../src/mcp/voice-companies.js";
import { lookupCompaniesByName, type NameLookupIo } from "../src/scb/name-lookup.js";
import type { ScbFilters } from "../src/scb/schemas.js";
import { createTestClient, jsonResponse } from "./helpers.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function operator(filters: ScbFilters): string {
  return filters.variables[0]?.operator ?? "";
}

function sizeCodes(filters: ScbFilters): string[] | undefined {
  return filters.categories.find((item) => item.category === "Storleksklass Anställda")?.values;
}

const company = (name: string, org: string, size: string, status = "1", city = "Östersund") => ({
  Företagsnamn: name,
  OrgNr: org,
  Säteskommun: city,
  Företagsstatus: status,
  Storleksklass: size,
});

describe("lookupCompaniesByName", () => {
  it("resolves a multi-word name from prefix and exact lookups", async () => {
    const fetches: string[] = [];
    const started = Date.now();
    const result = await lookupCompaniesByName(io({
      count: async () => {
        await delay(800);
        return 2;
      },
      fetch: async (filters) => {
        fetches.push(operator(filters));
        if (operator(filters) === "Innehaller") {
          await delay(2_000);
          return [];
        }
        return [company("Anders Westlunds Entreprenad AB", "5560000001", "5-9 anställda")];
      },
    }), { nameVariable: "Namn", name: "Anders Westlunds Entreprenad", limit: 3 });

    expect(Date.now() - started).toBeLessThan(600);
    expect(fetches).not.toContain("Innehaller");
    expect(result.strategy).toBe("prefix");
    expect(result.results).toHaveLength(1);
  });

  it("does not download the zero-employee band when three larger Swedish companies exist", async () => {
    const bands: string[][] = [];
    let fullContains = false;
    const result = await lookupCompaniesByName(io({
      count: async () => 246,
      fetch: async (filters) => {
        const op = operator(filters);
        if (op !== "Innehaller") {
          return [company("Westlund AB", "1", "0 anställda")];
        }
        const codes = sizeCodes(filters);
        if (!codes) {
          fullContains = true;
          return [];
        }
        bands.push(codes);
        if (codes.includes("4")) {
          return [
            company("Westlund Bygg AB", "10", "50-99 anställda"),
            company("Westlund Entreprenad AB", "11", "20-49 anställda"),
            company("Westlund Maskin AB", "12", "10-19 anställda"),
          ];
        }
        throw new Error(`unexpected size band ${codes.join(",")}`);
      },
    }), { nameVariable: "Namn", name: "Westlund", limit: 3 });

    expect(fullContains).toBe(false);
    expect(bands).toEqual([SIZE_10]);
    expect(result.strategy).toBe("employed");
    expect(result.count).toBe(246);
    expect(result.results.map((row) => (row as { OrgNr: string }).OrgNr).sort()).toEqual(["1", "10", "11", "12"]);
  });

  it("keeps a larger infix company ahead of a smaller prefix hit", async () => {
    const result = await lookupCompaniesByName(io({
      count: async () => 8,
      fetch: async (filters) => {
        const op = operator(filters);
        if (op === "BorjarPa" || op === "ArLikaMed") {
          return [company("Westlund AB", "1", "0 anställda")];
        }
        const codes = sizeCodes(filters);
        if (codes?.includes("4")) {
          return [company("Westlund Holding AB", "2", "100-199 anställda")];
        }
        if (codes?.includes("2")) {
          return [company("Anders Westlunds Entreprenad AB", "3", "5-9 anställda")];
        }
        return [];
      },
    }), { nameVariable: "Namn", name: "Westlund", limit: 3 });

    const ranked = voiceCompanyPayload(result.results, { count: result.count, nameQuery: "Westlund" });
    expect(ranked.results.map((row) => row.name)).toEqual([
      "Westlund Holding AB",
      "Anders Westlunds Entreprenad AB",
      "Westlund AB",
    ]);
  });

  it("falls back to the full contains set when nothing active and Swedish is found", async () => {
    let full = 0;
    const result = await lookupCompaniesByName(io({
      count: async () => 2,
      fetch: async (filters) => {
        if (operator(filters) === "Innehaller" && filters.categories.length === 0) {
          full += 1;
          return [company("Westlund GmbH", "9", "1-4 anställda", "1", "Utlandet")];
        }
        return [];
      },
    }), { nameVariable: "Namn", name: "Westlund", limit: 3 });

    expect(full).toBe(1);
    expect(result.strategy).toBe("broad");
    expect(result.results).toHaveLength(1);
  });
});

describe("findCompaniesByName cache", () => {
  it("reuses the candidate rows for the same name", async () => {
    let counts = 0;
    let fetches = 0;
    const client = createTestClient(async (url) => {
      if (url.includes("raknaforetag")) {
        counts += 1;
        return jsonResponse(200, 4);
      }
      fetches += 1;
      return jsonResponse(200, [company("Anders Westlunds Entreprenad AB", "5560000001", "5-9 anställda")]);
    });
    const first = await client.findCompaniesByName("Namn", "Anders Westlunds Entreprenad", 3);
    const fetchesAfterFirst = fetches;
    const countsAfterFirst = counts;
    const second = await client.findCompaniesByName("Namn", "Anders Westlunds Entreprenad", 3);
    expect(first.results).toHaveLength(1);
    expect(second.cacheHit).toBe(true);
    expect(second.results).toEqual(first.results);
    expect(counts).toBe(countsAfterFirst);
    expect(fetches).toBe(fetchesAfterFirst);
    expect(countsAfterFirst).toBe(1);
  });
});

const SIZE_10 = ["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16"];

function io(partial: NameLookupIo): NameLookupIo {
  return partial;
}

describe("name lookup errors", () => {
  it("surfaces an unknown name variable instead of swallowing it", async () => {
    const result = lookupCompaniesByName({
      count: async () => {
        throw new ScbError("SCB_UNKNOWN_VARIABLE", "Variabeln Namn kan inte hittas", false, { field: "variable" });
      },
      fetch: async () => {
        throw new ScbError("SCB_UNKNOWN_VARIABLE", "Variabeln Namn kan inte hittas", false, { field: "variable" });
      },
    }, { nameVariable: "Namn", name: "Westlund", limit: 3 });
    await expect(result).rejects.toMatchObject({ code: "SCB_UNKNOWN_VARIABLE" });
  });
});
