import { describe, expect, it } from "vitest";
import { toScbQueryBody } from "../src/scb/payload.js";

describe("SCB query payload", () => {
  it("matches SCB exampleJe top-level status fields", () => {
    expect(
      toScbQueryBody({
        categories: [
          { category: "Företagsstatus", values: ["1"] },
          { category: "Registreringsstatus", values: ["1"] },
        ],
        variables: [],
      }),
    ).toEqual({
      Företagsstatus: "1",
      Registreringsstatus: "1",
    });
  });

  it("matches SCB exampleJe Kategorier and variabler", () => {
    expect(
      toScbQueryBody({
        categories: [
          { category: "Företagsstatus", values: ["1"] },
          { category: "Registreringsstatus", values: ["1"] },
          { category: "SätesKommun", values: ["0180"], branchLevel: 1 },
        ],
        variables: [
          { variable: "Firma", operator: "Innehaller", value: "ask", value2: "" },
        ],
      }),
    ).toEqual({
      Företagsstatus: "1",
      Registreringsstatus: "1",
      Kategorier: [{ Kategori: "SätesKommun", Kod: ["0180"], Branschniva: 1 }],
      variabler: [
        { Variabel: "Firma", Operator: "Innehaller", Varde1: "ask", Varde2: "" },
      ],
    });
  });

  it("matches SCB exampleAe top-level Arbetsställestatus", () => {
    expect(
      toScbQueryBody(
        {
          categories: [
            { category: "Arbetsställestatus", values: ["1"] },
            { category: "Län", values: ["21"] },
          ],
          variables: [],
        },
        "ae",
      ),
    ).toEqual({
      Arbetsställestatus: "1",
      Kategorier: [{ Kategori: "Län", Kod: ["21"] }],
    });
  });

  it("does not lift JE status fields on AE layout", () => {
    expect(
      toScbQueryBody(
        {
          categories: [{ category: "Företagsstatus", values: ["1"] }],
          variables: [],
        },
        "ae",
      ),
    ).toEqual({
      Kategorier: [{ Kategori: "Företagsstatus", Kod: ["1"] }],
    });
  });

  it("does not lift Arbetsställestatus on JE layout", () => {
    expect(
      toScbQueryBody(
        {
          categories: [{ category: "Arbetsställestatus", values: ["1"] }],
          variables: [],
        },
        "je",
      ),
    ).toEqual({
      Kategorier: [{ Kategori: "Arbetsställestatus", Kod: ["1"] }],
    });
  });

  it("can serialize AE status as Kategorier when SCB_AE_STATUS_TOP_LEVEL=false", () => {
    const previous = process.env.SCB_AE_STATUS_TOP_LEVEL;
    process.env.SCB_AE_STATUS_TOP_LEVEL = "false";
    try {
      expect(
        toScbQueryBody(
          {
            categories: [{ category: "Arbetsställestatus", values: ["1"] }],
            variables: [],
          },
          "ae",
        ),
      ).toEqual({
        Kategorier: [{ Kategori: "Arbetsställestatus", Kod: ["1"] }],
      });
    } finally {
      if (previous === undefined) {
        delete process.env.SCB_AE_STATUS_TOP_LEVEL;
      } else {
        process.env.SCB_AE_STATUS_TOP_LEVEL = previous;
      }
    }
  });
});
