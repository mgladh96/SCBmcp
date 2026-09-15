import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import {
  extractCodeRows,
  filterHintsFor,
  nearestNames,
} from "../src/domain/catalog.js";
import { extractMetadataItems, truncateMetadataItems } from "../src/scb/payload.js";
import { compactSchemaSummary } from "../src/scb/schema-summary.js";
import { lookupTargetCategories, searchCodeTables } from "../src/scb/code-lookup.js";
import { catalogFetch, createTestClient } from "./helpers.js";
import {
  LIVE_AE_CATEGORY_LIST,
  LIVE_AE_VARIABLE_LIST,
  LIVE_JE_CATEGORY_LIST,
  LIVE_JE_VARIABLE_LIST,
  LIVE_LAN_KODTABELL,
  LIVE_STATUS_KODTABELL,
} from "./fixtures/live-scb-metadata.js";

const silent = createLogger("error");

describe("live SCB metadata field names", () => {
  it("extracts JE and AE category names from Id_Kategori_* (no Kategori/Namn)", () => {
    expect(extractMetadataItems(LIVE_AE_CATEGORY_LIST).map((item) => item.name)).toEqual([
      "Län",
      "Företagsstatus",
      "Arbetsställestatus",
      "Kommun",
      "Bransch",
      "Storleksklass Anställda",
    ]);
    expect(extractMetadataItems(LIVE_JE_CATEGORY_LIST).map((item) => item.name)).toEqual([
      "Företagsstatus",
      "Registreringsstatus",
      "Säteslän",
      "Säteskommun",
      "Bransch",
      "Storleksklass Anställda",
    ]);
  });

  it("extracts variable names from Id_Variabel_JE / Id_Variabel_AE / Id_Variabel", () => {
    expect(extractMetadataItems(LIVE_AE_VARIABLE_LIST).map((item) => item.name)).toEqual([
      "Benämning",
      "CfarNr",
      "PeOrgNr",
      "BesöksPostOrt",
    ]);
    expect(extractMetadataItems(LIVE_JE_VARIABLE_LIST).map((item) => item.name)).toEqual([
      "Företagsnamn",
      "Firma",
      "PeOrgNr",
      "OrgNr",
    ]);
  });

  it("treats Varde as code and Text as label, not the reverse", () => {
    const rows = extractCodeRows(LIVE_LAN_KODTABELL);
    expect(rows).toEqual([
      { code: "21", label: "Gävleborg" },
      { code: "01", label: "Stockholm" },
    ]);
  });

  it("keeps get_category_values items[].name as the code (Varde)", () => {
    const truncated = truncateMetadataItems(LIVE_LAN_KODTABELL, {
      query: "Gävleborg",
      defaultLimit: 50,
    });
    expect(truncated.items).toHaveLength(1);
    expect(truncated.items[0]?.name).toBe("21");
  });
});

describe("live catalog consumers", () => {
  it("builds schema_summary with non-empty live names and Varde sample codes", () => {
    const summary = compactSchemaSummary(
      "workplace",
      LIVE_AE_CATEGORY_LIST,
      LIVE_AE_VARIABLE_LIST,
      new Map<string, unknown>([
        ["Län", LIVE_LAN_KODTABELL],
        ["Arbetsställestatus", LIVE_STATUS_KODTABELL],
      ]),
    );
    expect(summary.categories.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Län", "Arbetsställestatus", "Kommun", "Bransch"]),
    );
    expect(summary.categories.every((item) => item.name.length > 0)).toBe(true);
    expect(summary.variables.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Benämning", "CfarNr", "PeOrgNr"]),
    );
    const lan = summary.categories.find((item) => item.name === "Län");
    expect(lan?.kind).toBe("geography");
    expect(lan?.sampleValues?.[0]).toEqual({ code: "21", label: "Gävleborg" });
    const status = summary.categories.find((item) => item.name === "Arbetsställestatus");
    expect(status?.serialization).toBe("top-level");
    expect(summary.filterHints.length).toBeGreaterThan(0);
    expect(summary.filterHints.some((hint) => hint.recommendedCategories.includes("Län"))).toBe(
      true,
    );
  });

  it('looks up Gävleborg as code "21" on category Län', () => {
    expect(lookupTargetCategories(LIVE_AE_CATEGORY_LIST)).toEqual(
      expect.arrayContaining(["Län", "Arbetsställestatus"]),
    );
    const result = searchCodeTables(
      "workplace",
      "Gävleborg",
      [{ category: "Län", raw: LIVE_LAN_KODTABELL }],
      25,
    );
    expect(result.matches[0]).toMatchObject({
      objectType: "workplace",
      category: "Län",
      code: "21",
      label: "Gävleborg",
      kind: "geography",
    });
    expect(result.matches[0]?.code).not.toBe("Gävleborg");
  });

  it("binds filter hints and nearestNames to live category names", () => {
    const categoryNames = extractMetadataItems(LIVE_AE_CATEGORY_LIST)
      .map((item) => item.name)
      .filter((name) => name.length > 0);
    const variableNames = extractMetadataItems(LIVE_AE_VARIABLE_LIST)
      .map((item) => item.name)
      .filter((name) => name.length > 0);
    expect(nearestNames("Lan", categoryNames)).toContain("Län");
    const hints = filterHintsFor("workplace", "workplaces_in_region", {
      categoryNames,
      variableNames,
    });
    expect(hints[0]?.recommendedCategories).toEqual(
      expect.arrayContaining(["Län", "Kommun", "Arbetsställestatus"]),
    );
    expect(hints[0]?.recommendedVariables).toContain("BesöksPostOrt");
    expect(hints[0]?.defaultStatus?.category).toBe("Arbetsställestatus");
  });
});

describe("MCP tools with live-shaped catalog payloads", () => {
  it("lists categories, summarizes schema, and looks up Gävleborg → 21 / Län", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({ shape: "live" })), silent);

    const listed = await handlers.scb_list_categories({ objectType: "workplace" });
    const listedPayload = JSON.parse(listed.content[0]?.text ?? "{}") as {
      items: Array<{ name: string }>;
    };
    expect(listedPayload.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Län", "Arbetsställestatus", "Kommun"]),
    );
    expect(listedPayload.items.every((item) => item.name.length > 0)).toBe(true);

    const summary = await handlers.scb_schema_summary({ objectType: "workplace" });
    const summaryPayload = JSON.parse(summary.content[0]?.text ?? "{}") as {
      categories: Array<{ name: string; sampleValues?: Array<{ code: string; label: string }> }>;
      variables: Array<{ name: string }>;
      filterHints: Array<{ recommendedCategories: string[] }>;
    };
    expect(summaryPayload.categories.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Län", "Arbetsställestatus"]),
    );
    expect(summaryPayload.variables.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Benämning", "CfarNr"]),
    );
    const lan = summaryPayload.categories.find((item) => item.name === "Län");
    expect(lan?.sampleValues?.[0]?.code).toBe("21");
    expect(summaryPayload.filterHints.some((hint) => hint.recommendedCategories.includes("Län"))).toBe(
      true,
    );

    const lookup = await handlers.scb_lookup_codes({
      objectType: "workplace",
      query: "Gävleborg",
    });
    const lookupPayload = JSON.parse(lookup.content[0]?.text ?? "{}") as {
      matches: Array<{ category: string; code: string; label: string }>;
    };
    expect(lookupPayload.matches[0]).toMatchObject({
      category: "Län",
      code: "21",
    });
    expect(lookupPayload.matches[0]?.code).not.toBe(lookupPayload.matches[0]?.label);
  });

  it("lists JE categories from Id_Kategori_JE", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({ shape: "live" })), silent);
    const listed = await handlers.scb_list_categories({ objectType: "company" });
    const payload = JSON.parse(listed.content[0]?.text ?? "{}") as { items: Array<{ name: string }> };
    expect(payload.items.map((item) => item.name)).toEqual(
      expect.arrayContaining(["Företagsstatus", "Säteslän"]),
    );
  });
});
