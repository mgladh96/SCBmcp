import { describe, expect, it } from "vitest";
import { extractMetadataItems, toMetadataEnvelope, toScbQueryBody } from "../src/scb/payload.js";

describe("metadata envelope", () => {
  it("normalizes { Kategorier } into items with name", () => {
    const raw = { Kategorier: [{ Kategori: "Företagsstatus" }, { Kategori: "Säteslän" }] };
    const envelope = toMetadataEnvelope("company", raw);
    expect(envelope.objectType).toBe("company");
    expect(envelope.raw).toBe(raw);
    expect(envelope.items.map((item) => item.name)).toEqual(["Företagsstatus", "Säteslän"]);
  });

  it("normalizes { Variabler } and arrays", () => {
    expect(extractMetadataItems({ Variabler: [{ Variabel: "Företagsnamn" }] }).map((item) => item.name)).toEqual([
      "Företagsnamn",
    ]);
    expect(extractMetadataItems(["Län", "Kommun"]).map((item) => item.name)).toEqual(["Län", "Kommun"]);
  });

  it("keeps kodtabell rows and prefers Kategori/Kod names", () => {
    const items = extractMetadataItems({
      Koder: [
        { Kod: "21", Text: "Gävleborgs län" },
        { Kod: "01", Text: "Stockholms län" },
      ],
    });
    expect(items[0]?.name).toBe("21");
  });
});

describe("SCB query payload", () => {
  it("serializes empty filters as an empty body", () => {
    expect(toScbQueryBody({ categories: [], variables: [] })).toEqual({});
  });
});
