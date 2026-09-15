import { describe, expect, it } from "vitest";
import { fold } from "../src/domain/catalog.js";
import {
  compileStructuredQuery,
  pickGeographyCategory,
  rangeRelation,
  structuredQuerySchema,
} from "../src/scb/compile/index.js";
import { parseEmployeeBand } from "../src/scb/compile/bands.js";
import { catalogFetch, createTestClient } from "./helpers.js";

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

  it("treats 10–15 vs 10–19 as superset, never exact", () => {
    expect(rangeRelation(10, 15, 10, 19)).toBe("superset");
    expect(rangeRelation(10, 19, 10, 19)).toBe("exact");
    expect(rangeRelation(5, 100, 10, 19)).toBe("subset");
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
    expect(industry?.values).toContain("F");

    const size = compiled.filters.categories.find((item) => fold(item.category).includes("storleksklass"));
    expect(size?.values).toContain("4");
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
    expect(industry?.applied).toMatchObject({ category: "Bransch" });
    const codes = compiled.resolved.industry?.codes.map((item) => item.code) ?? [];
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.some((code) => code === "F" || code === "41")).toBe(true);
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
});
