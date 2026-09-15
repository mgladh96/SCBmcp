import { describe, expect, it } from "vitest";
import { detectFalseExact, loadEvalCases, runMockedEval } from "./runner.js";
import { structuredQuerySchema } from "../../src/scb/compile/index.js";

describe("blind eval case bank", () => {
  const cases = loadEvalCases();

  it("has 20–30 cases with unique ids and golden vs blind tiers", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(30);
    const ids = new Set(cases.map((item) => item.id));
    expect(ids.size).toBe(cases.length);
    expect(cases.some((item) => item.tier === "golden")).toBe(true);
    expect(cases.filter((item) => item.tier === "blind").length).toBeGreaterThanOrEqual(20);
    expect(cases.filter((item) => item.tier === "golden").every((item) => item.id.startsWith("golden-"))).toBe(true);
  });

  it("covers JE/AE, county/municipality, industries, employee relations, and fail paths", () => {
    const objectTypes = new Set(cases.map((item) => item.query && typeof item.query === "object" ? (item.query as { objectType?: string }).objectType : undefined));
    expect(objectTypes.has("company")).toBe(true);
    expect(objectTypes.has("workplace")).toBe(true);

    const geoTypes = new Set(
      cases
        .map((item) => {
          const query = item.query as { geography?: { type?: string } };
          return query.geography?.type;
        })
        .filter(Boolean),
    );
    expect(geoTypes.has("county")).toBe(true);
    expect(geoTypes.has("municipality")).toBe(true);

    const industries = cases
      .map((item) => {
        const query = item.query as { industry?: { query?: string } };
        return query.industry?.query?.toLowerCase();
      })
      .filter((value): value is string => Boolean(value));
    expect(industries.some((item) => item.includes("bygg"))).toBe(true);
    expect(industries.some((item) => item.includes("restaurang") || item.includes("café") || item.includes("kafé"))).toBe(
      true,
    );
    expect(industries.some((item) => item.includes("data") || item.includes("konsult"))).toBe(true);
    expect(industries.some((item) => item.includes("transport"))).toBe(true);
    expect(industries.some((item) => item.includes("handel"))).toBe(true);

    const relations = new Set(cases.map((item) => item.expect.employeeRelation).filter(Boolean));
    expect(relations.has("exact")).toBe(true);
    expect(relations.has("superset")).toBe(true);
    expect(relations.has("subset")).toBe(true);
    expect(relations.has("unrepresentable")).toBe(true);

    const outcomes = new Set(cases.map((item) => item.expect.fetchOutcome));
    expect(outcomes.has("success")).toBe(true);
    expect(outcomes.has("no_matches")).toBe(true);
    expect(outcomes.has("too_broad")).toBe(true);
    expect(outcomes.has("compile_fail")).toBe(true);

    expect(cases.some((item) => item.live === true && item.tier === "golden")).toBe(true);
  });
});

describe("false exact policy", () => {
  it("fails hard when employees coverage claims exact for a wider SCB class", () => {
    const query = structuredQuerySchema.parse({
      objectType: "company",
      employees: { min: 10, max: 15 },
    });
    expect(
      detectFalseExact(
        {
          coverage: [
            {
              constraint: "employees",
              requested: { min: 10, max: 15 },
              applied: { category: "Anställda", bands: [{ min: 10, max: 19 }] },
              relation: "exact",
              exact: true,
              message: "wrongly claimed exact",
            },
          ],
          resolved: {
            employees: { category: "Anställda", bands: [{ code: "4", label: "10-19 anställda", min: 10, max: 19 }] },
          },
        },
        query,
      ),
    ).toBe(true);
  });

  it("does not flag an honest superset (10–15 vs 10–19)", () => {
    const query = structuredQuerySchema.parse({
      objectType: "company",
      employees: { min: 10, max: 15 },
    });
    expect(
      detectFalseExact(
        {
          coverage: [
            {
              constraint: "employees",
              requested: { min: 10, max: 15 },
              applied: { category: "Anställda", bands: [{ min: 10, max: 19 }] },
              relation: "superset",
              exact: false,
              message: "superset",
            },
          ],
          resolved: {
            employees: { category: "Anställda", bands: [{ code: "4", label: "10-19 anställda", min: 10, max: 19 }] },
          },
        },
        query,
      ),
    ).toBe(false);
  });
});

describe("mocked blind eval runner", () => {
  it("hard-fails only on falseExact or golden regression", async () => {
    const summary = await runMockedEval();
    expect(summary.falseExactCount, summary.cases.filter((item) => item.falseExact).map((item) => item.id).join(", ")).toBe(
      0,
    );
    expect(summary.goldenPass, summary.cases.filter((item) => item.tier === "golden" && !item.e2e).flatMap((item) => item.failures).join("; ")).toBe(
      summary.goldenTotal,
    );
    expect(summary.hardFail).toBe(false);
    expect(summary.blindTotal).toBeGreaterThanOrEqual(20);
  });
});
