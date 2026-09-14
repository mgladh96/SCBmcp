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
});
