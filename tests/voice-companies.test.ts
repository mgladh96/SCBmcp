import { describe, expect, it } from "vitest";
import { voiceCompanyPayload } from "../src/mcp/voice-companies.js";

const ikeaRows = [
  {
    Företagsnamn: "IKEA GmbH",
    OrgNr: "1",
    Säteskommun: "Utlandet",
    Företagsstatus: "9",
    Storleksklass: "0 anställda",
  },
  {
    Företagsnamn: "IKEA of Sweden AB",
    OrgNr: "2",
    Säteskommun: "Älmhult",
    Företagsstatus: "1",
    Storleksklass: "5000-9999 anställda",
  },
  {
    Företagsnamn: "IKEA AB",
    OrgNr: "3",
    Säteskommun: "Älmhult",
    Företagsstatus: "verksam",
    Storleksklass: "1000-1499 anställda",
  },
  {
    Företagsnamn: "IKEA Family AB",
    OrgNr: "4",
    Säteskommun: "Helsingborg",
    Företagsstatus: "1",
    Storleksklass: "1-4 anställda",
  },
];

describe("voice company ranking", () => {
  it("puts a larger active Swedish company ahead of a smaller exact name", () => {
    const payload = voiceCompanyPayload(ikeaRows, { count: 57, nameQuery: "IKEA" });
    expect(payload.results.map((row) => row.name)).toEqual([
      "IKEA of Sweden AB",
      "IKEA AB",
      "IKEA Family AB",
    ]);
    expect(payload.returned).toBe(3);
    expect(payload.count).toBe(57);
  });

  it("prefers an exact or legal-form name when size is equal", () => {
    const payload = voiceCompanyPayload(
      [
        {
          Företagsnamn: "IKEA Retail AB",
          OrgNr: "1",
          Säteskommun: "Malmö",
          Företagsstatus: "1",
          Storleksklass: "50-99 anställda",
        },
        {
          Företagsnamn: "IKEA AB",
          OrgNr: "2",
          Säteskommun: "Älmhult",
          Företagsstatus: "1",
          Storleksklass: "50-99 anställda",
        },
        {
          Företagsnamn: "IKEA",
          OrgNr: "3",
          Säteskommun: "Älmhult",
          Företagsstatus: "1",
          Storleksklass: "50-99 anställda",
        },
      ],
      { count: 3, nameQuery: "IKEA" },
    );
    expect(payload.results.map((row) => row.name)).toEqual(["IKEA", "IKEA AB", "IKEA Retail AB"]);
  });

  it("keeps a Swedish active company and drops inactive and foreign hits", () => {
    const payload = voiceCompanyPayload(
      [
        { Företagsnamn: "IKEA GmbH", OrgNr: "1", Säteskommun: "0000", Företagsstatus: "1", Storleksklass: "16" },
        { Företagsnamn: "Gamla IKEA AB", OrgNr: "2", Säteskommun: "Älmhult", Företagsstatus: "9", Storleksklass: "4" },
        { Företagsnamn: "IKEA AB", OrgNr: "3", Säteskommun: "Älmhult", Företagsstatus: "1", "Stkl, kod": "7" },
      ],
      { count: 3, nameQuery: "IKEA" },
    );
    expect(payload.results).toEqual([
      {
        organizationNumber: "3",
        name: "IKEA AB",
        city: "Älmhult",
        sizeClass: "100-199 anställda",
        status: "verksam",
      },
    ]);
    expect(payload.note).toBe("Visar verksamma företag med säte i Sverige.");
  });

  it("falls back to inactive and foreign companies when nothing else is left", () => {
    const payload = voiceCompanyPayload(
      [
        {
          Företagsnamn: "IKEA GmbH",
          OrgNr: "1",
          Säteslän: "Utlandet",
          Företagsstatus: "aldrig verksam",
          Storleksklass: "1-4 anställda",
        },
        {
          Företagsnamn: "IKEA Ltd",
          OrgNr: "2",
          Säteskommun: "Utlandet",
          Företagsstatus: "1",
          Storleksklass: "200-499 anställda",
        },
      ],
      { count: 2, nameQuery: "IKEA" },
    );
    expect(payload.note).toBe("Inga verksamma svenska träffar.");
    expect(payload.results.map((row) => row.name)).toEqual(["IKEA Ltd", "IKEA GmbH"]);
    expect(payload.results[1]?.status).toBe("aldrig verksam");
  });

  it("resolves a Swedish municipality code and a SNI label", () => {
    const payload = voiceCompanyPayload(
      [
        {
          Företagsnamn: "IKEA of Sweden AB",
          OrgNr: "5560747569",
          Säteskommun: "0765",
          Företagsstatus: "1",
          Storleksklass: "15",
          Bransch: "47191",
          "Bransch, text": "Specialiserad butikshandel med möbler",
        },
      ],
      {
        count: 1,
        nameQuery: "IKEA",
        municipalityLabels: new Map([["0765", "Älmhult"]]),
      },
    );
    expect(payload.results[0]).toEqual({
      organizationNumber: "5560747569",
      name: "IKEA of Sweden AB",
      city: "Älmhult",
      sizeClass: "5000-9999 anställda",
      industry: "47191 Specialiserad butikshandel med möbler",
      status: "verksam",
    });
    expect(payload.note).toBeUndefined();
  });

  it("says when the name matches nothing", () => {
    expect(voiceCompanyPayload([], { count: 0, nameQuery: "IKEA" })).toEqual({
      count: 0,
      returned: 0,
      results: [],
      message: "Inget företag hittades.",
    });
  });

  it("honors a smaller voice limit", () => {
    const payload = voiceCompanyPayload(ikeaRows, { count: 4, nameQuery: "IKEA", limit: 1 });
    expect(payload.returned).toBe(1);
    expect(payload.results[0]?.name).toBe("IKEA of Sweden AB");
  });
});
