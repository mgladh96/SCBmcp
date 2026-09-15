import { describe, expect, it } from "vitest";
import { fold } from "../src/domain/catalog.js";
import {
  compileStructuredQuery,
  CONSTRUCTION_SNI_DIVISIONS,
  expandIndustryAliases,
  isMonetaryLabel,
  parseEmployeeBand,
  parseSwedishInt,
  pickGeographyCategory,
  pickIndustryCategory,
  pickSizeCategory,
  rangeRelation,
  selectIndustryCodes,
  selectVariablesForFetch,
  structuredQuerySchema,
} from "../src/scb/compile/index.js";
import { catalogFetch, createTestClient, liveConstructionCatalogSpec } from "./helpers.js";
import { LIVE_TWO_DIGIT_BRANSCH_CATEGORY } from "./fixtures/live-scb-metadata.js";

const GOLDEN_QUERY = {
  objectType: "company" as const,
  industry: { query: "bygg" },
  geography: { type: "county" as const, value: "Jämtland" },
  employees: { min: 10, max: 15 },
  maxRows: 50,
  fields: ["name", "organizationNumber", "municipality", "employeeCount"],
};

function liveClient() {
  return createTestClient(catalogFetch({ shape: "live" }));
}

describe("StructuredQuery schema", () => {
  it("requires objectType and object-shaped industry", () => {
    expect(structuredQuerySchema.safeParse({ industry: { query: "bygg" } }).success).toBe(false);
    expect(
      structuredQuerySchema.safeParse({ objectType: "company", industry: "bygg" }).success,
    ).toBe(false);
    expect(
      structuredQuerySchema.safeParse({ objectType: "company", industry: { query: "bygg" } }).success,
    ).toBe(true);
  });

  it("defaults status to active", () => {
    const parsed = structuredQuerySchema.parse({ objectType: "workplace" });
    expect(parsed.status).toBe("active");
  });
});

describe("geography category picker", () => {
  const je = ["Företagsstatus", "Säteslän", "Säteskommun", "SätesARegion", "Bransch", "Län"];
  const ae = ["Arbetsställestatus", "Län", "Kommun", "ARegion", "Säteslän", "Bransch"];

  it("maps company county to Säteslän, never Län", () => {
    expect(pickGeographyCategory(je, "company", "county")).toBe("Säteslän");
    expect(pickGeographyCategory(je, "company", "county")).not.toBe("Län");
    expect(pickGeographyCategory(["SätesLän", "Län"], "company", "county")).toBe("SätesLän");
  });

  it("maps workplace county to Län, not Säteslän", () => {
    expect(pickGeographyCategory(ae, "workplace", "county")).toBe("Län");
  });

  it("maps aregion from live-like names", () => {
    expect(pickGeographyCategory(je, "company", "aregion")).toBe("SätesARegion");
    expect(pickGeographyCategory(ae, "workplace", "aregion")).toBe("ARegion");
  });
});

describe("employee band coverage", () => {
  it("parses SCB class labels", () => {
    expect(parseEmployeeBand({ code: "4", label: "10-19 anställda" })).toEqual({
      code: "4",
      label: "10-19 anställda",
      min: 10,
      max: 19,
    });
    expect(parseEmployeeBand({ code: "9", label: "500+ anställda" })?.max).toBeNull();
  });

  it("rejects monetary labels and parses space-grouped Swedish numbers", () => {
    expect(isMonetaryLabel("1 - 49 tkr")).toBe(true);
    expect(isMonetaryLabel("10 000 - 19 999 tkr")).toBe(true);
    expect(isMonetaryLabel("10-19 anställda")).toBe(false);
    expect(parseEmployeeBand({ code: "01", label: "1 - 49 tkr" })).toBeUndefined();
    expect(parseEmployeeBand({ code: "04", label: "10 000 - 19 999 tkr" })).toBeUndefined();
    expect(parseSwedishInt("10 000")).toBe(10_000);
    expect(parseEmployeeBand({ code: "x", label: "10 000 - 19 999 anställda" })).toEqual({
      code: "x",
      label: "10 000 - 19 999 anställda",
      min: 10_000,
      max: 19_999,
    });
  });

  it("treats 10–15 vs 10–19 as superset, never exact", () => {
    expect(rangeRelation(10, 15, 10, 19)).toBe("superset");
    expect(rangeRelation(10, 19, 10, 19)).toBe("exact");
    expect(rangeRelation(5, 100, 10, 19)).toBe("subset");
  });

  it("never picks Omsättningsklass for employees", () => {
    expect(
      pickSizeCategory(["Omsättningsklass fin", "Omsättningsklass grov", "Anställda", "Bransch"]),
    ).toBe("Anställda");
    expect(pickSizeCategory(["Omsättningsklass fin", "Storleksklass Anställda"])).toBe(
      "Storleksklass Anställda",
    );
    expect(pickSizeCategory(["Omsättningsklass fin"])).toBeUndefined();
  });
});

describe("compileStructuredQuery golden path (live-shaped metadata)", () => {
  it("compiles JE + Säteslän (not Län) + industry codes + non-exact employee band", async () => {
    const compiled = await compileStructuredQuery(structuredQuerySchema.parse(GOLDEN_QUERY), liveClient());
    expect(compiled.ok).toBe(true);
    expect(compiled.objectType).toBe("company");
    expect(compiled.resolved.layout).toBe("je");

    const geo = compiled.filters.categories.find((item) => fold(item.category).includes("sateslan"));
    expect(geo).toBeDefined();
    expect(geo?.category).not.toBe("Län");
    expect(fold(geo?.category ?? "")).toBe(fold("SätesLän"));
    expect(geo?.values).toContain("23");
    expect(compiled.filters.categories.some((item) => item.category === "Län")).toBe(false);

    const industry = compiled.filters.categories.find((item) => fold(item.category).includes("bransch"));
    expect(industry?.values.length).toBeGreaterThan(0);
    expect(industry?.values.length).toBeLessThanOrEqual(8);
    expect(industry?.values).toContain("F");
    expect(industry?.branchLevel).toBe(1);
    expect(industry?.values.every((code) => !/^\d{5}$/u.test(code))).toBe(true);

    const size = compiled.filters.categories.find(
      (item) =>
        fold(item.category).includes("storleksklass") || fold(item.category).includes("anstalld"),
    );
    expect(size?.values).toContain("4");
    expect(fold(size?.category ?? "")).not.toMatch(/omsattning/);
    expect(size?.category).not.toMatch(/Omsättningsklass/i);
    const emp = compiled.coverage.find((item) => item.constraint === "employees");
    expect(emp?.relation).toBe("superset");
    expect(emp?.exact).toBe(false);
    expect(emp?.message).toMatch(/10–15|10-15/);
    expect(emp?.message).toMatch(/10-19/);

    const status = compiled.filters.categories.find((item) => fold(item.category).includes("foretagsstatus"));
    expect(status?.values).toEqual(["1"]);

    expect(compiled.resolved.fields.name).toEqual(expect.arrayContaining(["Företagsnamn"]));
    expect(compiled.resolved.fields.organizationNumber?.some((name) => name.includes("OrgNr"))).toBe(true);
    expect(compiled.resolved.fields.municipality?.some((name) => fold(name).includes("sateskommun"))).toBe(true);

    const json = JSON.stringify(compiled);
    expect(json).not.toMatch(/Id_Kategori/);
    expect(json.toLowerCase()).not.toContain("kategorigrupp");
  });

  it("maps workplace county Jämtland to Län", async () => {
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "workplace",
        geography: { type: "county", value: "Jämtland" },
      }),
      liveClient(),
    );
    const geo = compiled.filters.categories.find((item) => fold(item.category) === "lan");
    expect(geo?.category).toBe("Län");
    expect(geo?.values).toContain("23");
    expect(compiled.filters.categories.some((item) => fold(item.category).includes("sateslan"))).toBe(false);
  });

  it("resolves bygg to industry codes", async () => {
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({ objectType: "company", industry: { query: "bygg" }, status: "any" }),
      liveClient(),
    );
    expect(compiled.ok).toBe(true);
    const industry = compiled.coverage.find((item) => item.constraint === "industry");
    expect(industry?.applied).toMatchObject({ category: "Bransch", branchLevel: 1 });
    const codes = compiled.resolved.industry?.codes.map((item) => item.code) ?? [];
    expect(codes).toEqual(["F"]);
    const filter = compiled.filters.categories.find((item) => item.category === "Bransch");
    expect(filter?.branchLevel).toBe(1);
    expect(filter?.values).toEqual(["F"]);
  });

  it("resolves semantic fields per objectType", async () => {
    const company = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "company",
        status: "any",
        fields: ["name", "organizationNumber", "municipality", "employeeCount"],
      }),
      liveClient(),
    );
    expect(company.resolved.fields.name).toContain("Företagsnamn");
    expect(company.resolved.fields.municipality?.some((name) => fold(name).includes("sateskommun"))).toBe(true);

    const workplace = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "workplace",
        status: "any",
        fields: ["name", "organizationNumber", "municipality", "employeeCount"],
      }),
      liveClient(),
    );
    expect(workplace.resolved.fields.name).toContain("Benämning");
    expect(workplace.resolved.fields.municipality).toContain("Kommun");
  });

  it("marks unknown geography as unresolved/unrepresentable", async () => {
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "company",
        geography: { type: "county", value: "Narnia" },
      }),
      liveClient(),
    );
    expect(compiled.ok).toBe(false);
    expect(compiled.unresolved.some((item) => item.constraint === "geography")).toBe(true);
    const geo = compiled.coverage.find((item) => item.constraint === "geography");
    expect(geo?.exact).toBe(false);
    expect(geo?.relation === "unrepresentable" || geo?.relation === "partial").toBe(true);
  });

  it("marks a non-overlapping employee range as unrepresentable", async () => {
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "company",
        employees: { min: 5000, max: 8000 },
        status: "any",
      }),
      liveClient(),
    );
    expect(compiled.ok).toBe(false);
    const emp = compiled.coverage.find((item) => item.constraint === "employees");
    expect(emp?.relation).toBe("unrepresentable");
    expect(emp?.exact).toBe(false);
  });

  it("marks unknown industry as unresolved", async () => {
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "company",
        industry: { query: "xyzzy-not-an-sni" },
        status: "any",
      }),
      liveClient(),
    );
    expect(compiled.ok).toBe(false);
    expect(compiled.unresolved.some((item) => item.constraint === "industry")).toBe(true);
  });

  it("maps employees 10–15 to Anställda (not Omsättningsklass) with superset coverage", async () => {
    const client = createTestClient(
      catalogFetch({
        shape: "live",
        categories: {
          company: [
            "Företagsstatus",
            "Omsättningsklass fin",
            "Omsättningsklass grov",
            "Anställda",
            "Säteslän",
            "Säteskommun",
            "Bransch",
          ],
          workplace: ["Arbetsställestatus", "Län", "Omsättningsklass fin", "Anställda", "Bransch"],
        },
      }),
    );
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "company",
        employees: { min: 10, max: 15 },
        status: "any",
      }),
      client,
    );
    expect(compiled.ok).toBe(true);
    const size = compiled.filters.categories.find((item) =>
      compiled.resolved.employees ? item.category === compiled.resolved.employees.category : false,
    );
    expect(size?.category).toBe("Anställda");
    expect(size?.category).not.toMatch(/Omsättningsklass/i);
    expect(size?.values).toEqual(["4"]);
    expect(compiled.resolved.employees?.bands).toEqual([
      expect.objectContaining({ code: "4", min: 10, max: 19 }),
    ]);
    const emp = compiled.coverage.find((item) => item.constraint === "employees");
    expect(emp?.relation).toBe("superset");
    expect(emp?.exact).toBe(false);
    expect(JSON.stringify(compiled.filters)).not.toMatch(/Omsättningsklass/i);
  });

  it("sets Branschniva 1–3 on Bransch and prefers section F over noisy 5-digit bygg hits", async () => {
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({ objectType: "company", industry: { query: "bygg" }, status: "any" }),
      liveClient(),
    );
    const filter = compiled.filters.categories.find((item) => item.category === "Bransch");
    expect(filter?.branchLevel).toBeGreaterThanOrEqual(1);
    expect(filter?.branchLevel).toBeLessThanOrEqual(3);
    expect(filter?.values).toEqual(["F"]);
    expect(filter?.values.some((code) => /^\d{5}$/u.test(code))).toBe(false);
    expect(compiled.coverage.find((item) => item.constraint === "industry")?.relation).toBe("exact");
  });

  it("honours industry.level 2 as Branschniva 2 with 2-digit codes", async () => {
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "company",
        industry: { query: "bygg", level: 2 },
        status: "any",
      }),
      liveClient(),
    );
    const filter = compiled.filters.categories.find((item) => item.category === "Bransch");
    expect(filter?.branchLevel).toBe(2);
    expect(filter?.values.length).toBeGreaterThan(0);
    expect(filter?.values.every((code) => /^\d{2}$/u.test(code))).toBe(true);
    expect(filter?.values).toContain("41");
  });

  it("clamps industry.level 5 to Branschniva 3", async () => {
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "company",
        industry: { query: "bygg", level: 5 },
        status: "any",
      }),
      liveClient(),
    );
    const filter = compiled.filters.categories.find((item) => item.category === "Bransch");
    expect(filter?.branchLevel).toBe(3);
    expect(filter?.values.every((code) => /^\d{5}$/u.test(code))).toBe(true);
    expect(compiled.warnings.some((item) => /klampades|Branschniva 3/u.test(item))).toBe(true);
  });
});

describe("construction SNI alias layer", () => {
  const NOISE = ["22", "30", "16", "23", "25", "28", "46"];

  it("expands bygg to construction codes 41/42/43 and section F", () => {
    const aliases = expandIndustryAliases("bygg");
    expect(aliases).toEqual(expect.arrayContaining(["bygg", "Byggverksamhet", "F", "41", "42", "43"]));
    expect(CONSTRUCTION_SNI_DIVISIONS).toEqual(["41", "42", "43"]);
  });

  it("selectIndustryCodes prefers 41/42/43 over plast/fartyg/handel", () => {
    const selected = selectIndustryCodes(
      [
        { code: "22", label: "Tillverkning av byggplast" },
        { code: "30", label: "Byggande av fartyg och båtar" },
        { code: "41", label: "Byggande av hus" },
        { code: "42", label: "Anläggningsarbeten" },
        { code: "43", label: "Specialiserad bygg- och anläggningsverksamhet" },
        { code: "46", label: "Partihandel med byggvaror" },
      ],
      undefined,
      expandIndustryAliases("bygg"),
    );
    expect(selected.codes.map((item) => item.code).sort()).toEqual(["41", "42", "43"]);
    expect(selected.branchLevel).toBe(2);
  });

  it("falls back from level 1 to 41/42/43 when section F is missing", () => {
    const selected = selectIndustryCodes(
      [
        { code: "22", label: "Tillverkning av byggplast" },
        { code: "41", label: "Byggande av hus" },
        { code: "42", label: "Anläggningsarbeten" },
        { code: "43", label: "Specialiserad byggverksamhet" },
      ],
      1,
      expandIndustryAliases("bygg"),
    );
    expect(selected.codes.map((item) => item.code).sort()).toEqual(["41", "42", "43"]);
    expect(selected.branchLevel).toBe(2);
  });

  it("compiles live-shaped bygg (no section F) to 2-siffrig 41/42/43", async () => {
    const client = createTestClient(catalogFetch(liveConstructionCatalogSpec()));
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({ objectType: "company", industry: { query: "bygg" }, status: "any" }),
      client,
    );
    expect(compiled.ok).toBe(true);
    const filter = compiled.filters.categories.find((item) => fold(item.category).includes("bransch"));
    expect(filter?.category).toBe(LIVE_TWO_DIGIT_BRANSCH_CATEGORY);
    expect(filter?.branchLevel).toBeUndefined();
    expect([...filter?.values ?? []].sort()).toEqual(["41", "42", "43"]);
    expect(filter?.values.some((code) => NOISE.includes(code))).toBe(false);
    const industry = compiled.coverage.find((item) => item.constraint === "industry");
    expect(industry?.relation).toBe("partial");
    expect(industry?.exact).toBe(false);
  });

  it("maps Byggverksamhet and level 1 to construction 41/42/43 when F is absent", async () => {
    const client = createTestClient(catalogFetch(liveConstructionCatalogSpec()));
    for (const industry of [{ query: "Byggverksamhet" }, { query: "bygg", level: 1 }] as const) {
      const compiled = await compileStructuredQuery(
        structuredQuerySchema.parse({ objectType: "company", industry, status: "any" }),
        client,
      );
      expect(compiled.ok).toBe(true);
      const filter = compiled.filters.categories.find((item) => fold(item.category).includes("bransch"));
      expect([...filter?.values ?? []].sort()).toEqual(["41", "42", "43"]);
      expect(filter?.values.some((code) => NOISE.includes(code))).toBe(false);
    }
  });

  it("uses 2-siffrig bransch for query 41 level 2", async () => {
    const client = createTestClient(catalogFetch(liveConstructionCatalogSpec()));
    const compiled = await compileStructuredQuery(
      structuredQuerySchema.parse({
        objectType: "company",
        industry: { query: "41", level: 2 },
        status: "any",
      }),
      client,
    );
    const filter = compiled.filters.categories.find((item) => fold(item.category).includes("bransch"));
    expect(filter?.category).toBe(LIVE_TWO_DIGIT_BRANSCH_CATEGORY);
    expect(filter?.values).toEqual(["41"]);
    expect(compiled.coverage.find((item) => item.constraint === "industry")?.relation).toBe("exact");
  });

  it("prefers 2-siffrig category when level is 2", () => {
    expect(
      pickIndustryCategory(["Bransch", LIVE_TWO_DIGIT_BRANSCH_CATEGORY, "Säteslän"], 2),
    ).toBe(LIVE_TWO_DIGIT_BRANSCH_CATEGORY);
  });
});

describe("selectVariablesForFetch", () => {
  it("requests name/orgnr variables and skips category-only municipality/employees", () => {
    const selected = selectVariablesForFetch(
      {
        name: ["Namn", "Firma"],
        organizationNumber: ["OrgNr (10 siffror)", "OrgNr (12 siffror)"],
        municipality: ["Säteskommun"],
        employeeCount: ["Anställda"],
      },
      ["Namn", "Firma", "OrgNr (10 siffror)", "OrgNr (12 siffror)"],
      ["Säteskommun", "Anställda", "Företagsstatus"],
    );
    expect(selected.map((item) => item.variable)).toEqual([
      "Namn",
      "Firma",
      "OrgNr (10 siffror)",
      "OrgNr (12 siffror)",
    ]);
    expect(selected.every((item) => item.operator === "Finns")).toBe(true);
  });
});
