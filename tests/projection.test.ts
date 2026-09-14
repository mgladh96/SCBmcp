import { describe, expect, it } from "vitest";
import {
  fieldMatchesToken,
  projectRecord,
  projectSearchResults,
  shouldKeepField,
} from "../src/scb/projection.js";

describe("fieldMatchesToken", () => {
  it("keeps exact folded names and kod/text stems", () => {
    expect(fieldMatchesToken("Företagsnamn", "Företagsnamn")).toBe(true);
    expect(fieldMatchesToken("Län, kod", "lan")).toBe(true);
    expect(fieldMatchesToken("Län, text", "Län")).toBe(true);
    expect(fieldMatchesToken("Bransch_1, kod", "bransch")).toBe(true);
    expect(fieldMatchesToken("PeOrgNr", "peorgnr")).toBe(true);
  });

  it("does not keep unrelated fields by substring overlap", () => {
    expect(fieldMatchesToken("Plan", "lan")).toBe(false);
    expect(fieldMatchesToken("Land", "lan")).toBe(false);
    expect(fieldMatchesToken("PeOrgNr", "Nr")).toBe(false);
    expect(fieldMatchesToken("Organisationsnamn", "orgnr")).toBe(false);
  });
});

describe("shouldKeepField", () => {
  it("keeps default identity/name/geo/SNI and always keeps Reklam", () => {
    expect(shouldKeepField("Företagsnamn", "company")).toBe(true);
    expect(shouldKeepField("Län, kod", "workplace")).toBe(true);
    expect(shouldKeepField("Bransch_1, kod", "company")).toBe(true);
    expect(shouldKeepField("Reklam", "company", ["CfarNr"])).toBe(true);
    expect(shouldKeepField("Telefon", "company")).toBe(false);
  });

  it("rejects false-positive substring matches against default tokens", () => {
    expect(shouldKeepField("Plan", "workplace")).toBe(false);
    expect(shouldKeepField("Land", "workplace")).toBe(false);
  });

  it("rejects requested Nr matching PeOrgNr", () => {
    expect(shouldKeepField("PeOrgNr", "company", ["Nr"])).toBe(false);
    expect(shouldKeepField("PeOrgNr", "company", ["PeOrgNr"])).toBe(true);
  });
});

describe("projectRecord", () => {
  it("does not keep Plan/Land when fields request lan", () => {
    const projected = projectRecord(
      { Plan: "drop", Land: "drop", "Län, kod": "21", PeOrgNr: "16" },
      "workplace",
      ["lan"],
    ) as Record<string, unknown>;
    expect(projected["Län, kod"]).toBe("21");
    expect(projected.Plan).toBeUndefined();
    expect(projected.Land).toBeUndefined();
    expect(projected.PeOrgNr).toBeUndefined();
  });
});

describe("projectSearchResults envelope", () => {
  it("sets omittedByMaxRows only when maxRows clips fetched rows", () => {
    const rows = [
      { PeOrgNr: "1", Extra: "x" },
      { PeOrgNr: "2", Extra: "x" },
      { PeOrgNr: "3", Extra: "x" },
    ];
    const clipped = projectSearchResults(rows, "company", { maxRows: 2 });
    expect(clipped.fetched).toBe(3);
    expect(clipped.returned).toBe(2);
    expect(clipped.omittedByMaxRows).toBe(1);

    const unclipped = projectSearchResults(rows, "company", { maxRows: 75 });
    expect(unclipped.fetched).toBe(3);
    expect(unclipped.returned).toBe(3);
    expect(unclipped.omittedByMaxRows).toBe(0);
  });
});
