import { describe, expect, it } from "vitest";
import {
  classifyCategoryKind,
  classifyVariableKind,
  codeRowMatches,
  extractCodeRows,
  filterHintsFor,
  layoutHint,
  nearestNames,
} from "../src/domain/catalog.js";
import { compactSchemaSummary } from "../src/scb/schema-summary.js";
import { lookupTargetCategories, searchCodeTables } from "../src/scb/code-lookup.js";
import { isAllowedOperator, SCB_OPERATOR_NAMES } from "../src/scb/operators.js";
import { queryTooBroad } from "../src/domain/errors.js";
import { unknownOperatorError } from "../src/domain/errors.js";

describe("catalog classification", () => {
  it("classifies status, geography, industry and size", () => {
    expect(classifyCategoryKind("Företagsstatus")).toBe("status");
    expect(classifyCategoryKind("Säteslän")).toBe("geography");
    expect(classifyCategoryKind("Län")).toBe("geography");
    expect(classifyCategoryKind("Bransch")).toBe("industry");
    expect(classifyCategoryKind("Storleksklass Anställda")).toBe("size");
    expect(classifyCategoryKind("AnstSME")).toBe("size");
    expect(classifyVariableKind("Företagsnamn")).toBe("name");
    expect(classifyVariableKind("PeOrgNr")).toBe("identity");
  });
});

describe("nearestNames and layout hints", () => {
  it("suggests Säteslän for Län on company catalog", () => {
    const names = ["Företagsstatus", "Säteslän", "Säteskommun", "Bransch"];
    expect(nearestNames("Län", names)).toContain("Säteslän");
    expect(layoutHint("Län", "company", names)).toMatch(/AE|workplace|Säteslän/i);
  });

  it("suggests close variable names", () => {
    expect(nearestNames("Foretagsnamn", ["Företagsnamn", "Firma"])).toContain("Företagsnamn");
  });
});

describe("code matching", () => {
  it("matches Gävleborg against län labels without dumping the table", () => {
    const rows = extractCodeRows({
      Koder: [
        { Kod: "21", Text: "Gävleborgs län" },
        { Kod: "01", Text: "Stockholms län" },
      ],
    });
    expect(codeRowMatches(rows[0]!, "Gävleborg")).toBeGreaterThan(0);
    expect(codeRowMatches(rows[1]!, "Gävleborg")).toBe(0);
  });

  it("uses Varde as code and Text as label on live kodtabell rows", () => {
    const rows = extractCodeRows({
      Varden: [{ Varde: "21", Text: "Gävleborg" }],
    });
    expect(rows[0]).toEqual({ code: "21", label: "Gävleborg" });
    expect(rows[0]?.code).not.toBe("Gävleborg");
  });
});

describe("schema summary", () => {
  it("builds a compact catalog with kinds, serialization and counterparts", () => {
    const summary = compactSchemaSummary(
      "company",
      {
        Kategorier: [
          { Kategori: "Företagsstatus" },
          { Kategori: "Säteslän" },
          { Kategori: "Bransch" },
        ],
      },
      { Variabler: [{ Variabel: "Företagsnamn" }] },
      new Map([
        [
          "Företagsstatus",
          { Koder: [{ Kod: "1", Text: "verksam" }, { Kod: "0", Text: "aldrig" }] },
        ],
        [
          "Bransch",
          {
            Koder: Array.from({ length: 40 }, (_, i) => ({
              Kod: String(i),
              Text: `SNI ${i} extra lång etikett som inte ska dumpas`,
            })),
          },
        ],
      ]),
    );
    const status = summary.categories.find((item) => item.name === "Företagsstatus");
    const geo = summary.categories.find((item) => item.name === "Säteslän");
    const industry = summary.categories.find((item) => item.name === "Bransch");
    expect(status?.kind).toBe("status");
    expect(status?.serialization).toBe("top-level");
    expect(status?.sampleValues?.[0]?.code).toBe("1");
    expect(geo?.kind).toBe("geography");
    expect(geo?.serialization).toBe("Kategorier");
    expect(geo?.counterpartOnWorkplace).toBe("Län");
    expect(industry?.kind).toBe("industry");
    expect(industry?.sampleValues).toBeUndefined();
    expect(JSON.stringify(summary).length).toBeLessThan(20_000);
    expect(summary.operators.map((item) => item.name)).toEqual([...SCB_OPERATOR_NAMES]);
    expect(summary.variables[0]?.typicalOperators).toContain("Innehaller");
    expect(summary.filterHints.length).toBeGreaterThan(0);
  });
});

describe("code lookup", () => {
  it("searches cached tables for labels", () => {
    const targets = lookupTargetCategories({
      Kategorier: [{ Kategori: "Län" }, { Kategori: "Juridisk form" }, { Kategori: "Bransch" }],
    });
    expect(targets).toEqual(["Län", "Bransch"]);
    const result = searchCodeTables(
      "workplace",
      "Gävleborg",
      [{ category: "Län", raw: { Koder: [{ Kod: "21", Text: "Gävleborgs län" }] } }],
      25,
    );
    expect(result.matches[0]).toMatchObject({
      objectType: "workplace",
      category: "Län",
      code: "21",
      label: "Gävleborgs län",
      kind: "geography",
    });
  });
});

describe("operators", () => {
  it("accepts Innehaller and rejects Contains", () => {
    expect(isAllowedOperator("Innehaller")).toBe(true);
    expect(isAllowedOperator("Contains")).toBe(false);
    const error = unknownOperatorError("Contains");
    expect(error.code).toBe("SCB_INVALID_QUERY");
    expect(error.details.allowedOperators).toContain("Innehaller");
  });
});

describe("QUERY_TOO_BROAD catalog names", () => {
  it("uses actual category names from the catalog", () => {
    const error = queryTooBroad(3000, 2000, {
      objectType: "workplace",
      catalogCategoryNames: ["Arbetsställestatus", "Län", "Kommun", "Bransch"],
    });
    const dimensions = error.details.candidateNarrowingDimensions as Array<{
      dimension: string;
      categoryHint?: string;
      categoryNames?: string[];
    }>;
    const geo = dimensions.find((item) => item.dimension === "geography");
    expect(geo?.categoryNames).toEqual(expect.arrayContaining(["Län", "Kommun"]));
    expect(geo?.categoryHint).toMatch(/Län/);
  });
});

describe("filter hints", () => {
  it("returns the analysis table for a question class", () => {
    const hints = filterHintsFor("workplace", "workplaces_in_region");
    expect(hints[0]?.recommendedCategories).toEqual(
      expect.arrayContaining(["Län", "Kommun", "Arbetsställestatus"]),
    );
    expect(hints[0]?.defaultStatus?.value).toBe("1");
  });
});
