import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { compactSchemaSummary } from "../src/scb/schema-summary.js";
import { catalogFetch, createTestClient, jsonResponse } from "./helpers.js";

const silent = createLogger("error");

describe("search projection and result budget", () => {
  it("projects default fields, keeps Reklam, and truncates with omittedByMaxRows", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      PeOrgNr: `16${i}`,
      Företagsnamn: `Bolag ${i}`,
      Reklam: "11",
      Telefon: "secret-extra",
      Extra: "drop-me",
    }));
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        if (url.includes("raknaforetag")) {
          return jsonResponse(200, rows.length);
        }
        return jsonResponse(200, rows);
      }),
      silent,
    );
    const result = await handlers.scb_search_companies({
      filters: { categories: [{ category: "Företagsstatus", values: ["1"] }] },
      maxRows: 2,
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      fetched?: number;
      returned: number;
      omitted?: number;
      omittedByMaxRows?: number;
      results: Array<Record<string, unknown>>;
      warning?: string;
    };
    expect(payload.count).toBe(5);
    expect(payload.fetched).toBe(5);
    expect(payload.returned).toBe(2);
    expect(payload.omittedByMaxRows).toBe(3);
    expect(payload.omitted).toBeUndefined();
    expect(payload.results[0]?.Reklam).toBe("11");
    expect(payload.results[0]?.Företagsnamn).toBe("Bolag 0");
    expect(payload.results[0]?.Telefon).toBeUndefined();
    expect(payload.results[0]?.Extra).toBeUndefined();
    expect(payload.warning).toMatch(/maxRows/);
  });

  it("does not treat count−fetched as omittedByMaxRows", async () => {
    const rows = [{ PeOrgNr: "165560747569", Företagsnamn: "A", Reklam: "11" }];
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        if (url.includes("raknaforetag")) {
          return jsonResponse(200, 10);
        }
        return jsonResponse(200, rows);
      }),
      silent,
    );
    const result = await handlers.scb_search_companies({
      filters: { categories: [{ category: "Företagsstatus", values: ["1"] }] },
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      fetched?: number;
      returned: number;
      omitted?: number;
      omittedByMaxRows?: number;
    };
    expect(payload.count).toBe(10);
    expect(payload.fetched).toBe(1);
    expect(payload.returned).toBe(1);
    expect(payload.omittedByMaxRows).toBeUndefined();
    expect(payload.omitted).toBeUndefined();
  });

  it("never strips Reklam even when fields[] omits it", async () => {
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        if (url.includes("raknaarbetsstallen")) {
          return jsonResponse(200, 1);
        }
        return jsonResponse(200, [{ CfarNr: "12345678", Benämning: "X", Reklam: "21", Telefon: "0" }]);
      }),
      silent,
    );
    const result = await handlers.scb_search_workplaces({
      filters: { categories: [{ category: "Arbetsställestatus", values: ["1"] }] },
      fields: ["CfarNr"],
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      results: Array<Record<string, unknown>>;
    };
    expect(payload.results[0]?.CfarNr).toBe("12345678");
    expect(payload.results[0]?.Reklam).toBe("21");
    expect(payload.results[0]?.Benämning).toBeUndefined();
    expect(payload.results[0]?.Telefon).toBeUndefined();
  });
});

describe("identity on search", () => {
  it("normalizes 10-digit orgnr before the SCB POST", async () => {
    const bodies: unknown[] = [];
    const handlers = createToolHandlers(
      createTestClient(async (url, init) => {
        if (init.body) {
          bodies.push(JSON.parse(init.body));
        }
        if (url.includes("raknaforetag")) {
          return jsonResponse(200, 1);
        }
        return jsonResponse(200, [{ PeOrgNr: "165560747569", Reklam: "11" }]);
      }),
      silent,
    );
    const result = await handlers.scb_search_companies({
      filters: {
        variables: [{ variable: "PeOrgNr", operator: "ArLikaMed", value: "556074-7569" }],
      },
    });
    expect(result.isError).toBeUndefined();
    expect(bodies[0]).toMatchObject({
      variabler: [{ Variabel: "PeOrgNr", Operator: "ArLikaMed", Varde1: "165560747569" }],
    });
  });

  it("rejects garbage orgnr without calling SCB fetch", async () => {
    let calls = 0;
    const handlers = createToolHandlers(
      createTestClient(async () => {
        calls += 1;
        return jsonResponse(200, 1);
      }),
      silent,
    );
    const result = await handlers.scb_search_companies({
      filters: {
        variables: [{ variable: "PeOrgNr", operator: "ArLikaMed", value: "nope" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}").code).toBe("SCB_INVALID_QUERY");
    expect(calls).toBe(0);
  });
});

describe("scb_explain_query", () => {
  it("returns serialized body and endpoints without SCB HTTP", async () => {
    let calls = 0;
    const handlers = createToolHandlers(
      createTestClient(async () => {
        calls += 1;
        return jsonResponse(200, []);
      }),
      silent,
    );
    const result = await handlers.scb_explain_query({
      objectType: "workplace",
      filters: {
        categories: [
          { category: "Arbetsställestatus", values: ["1"] },
          { category: "Län", values: ["21"] },
        ],
      },
    });
    expect(calls).toBe(0);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      dryRun: boolean;
      layout: string;
      endpoints: { count: string; fetch: string };
      serializedBody: Record<string, unknown>;
      operatorValidation: { ok: boolean };
      serialization: { aeStatusEnvVar?: string; aeStatusNote?: string; liveConfirm?: string };
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.layout).toBe("ae");
    expect(payload.endpoints.count).toContain("raknaarbetsstallen");
    expect(payload.endpoints.fetch).toContain("hamtaarbetsstallen");
    expect(payload.serializedBody.Arbetsställestatus).toBe("1");
    expect(payload.serializedBody.Kategorier).toEqual([{ Kategori: "Län", Kod: ["21"] }]);
    expect(payload.operatorValidation.ok).toBe(true);
    expect(payload.serialization.aeStatusEnvVar).toBe("SCB_AE_STATUS_TOP_LEVEL");
    expect(payload.serialization.aeStatusNote).toMatch(/SCB_AE_STATUS_TOP_LEVEL=false/);
    expect(payload.serialization.liveConfirm).toMatch(/exampleAe/);
  });

  it("warns on empty filters, JE/AE geography, and operator arity", async () => {
    const handlers = createToolHandlers(createTestClient(async () => jsonResponse(200, [])), silent);
    const empty = await handlers.scb_explain_query({ objectType: "company", filters: {} });
    const emptyPayload = JSON.parse(empty.content[0]?.text ?? "{}") as { warnings: string[] };
    expect(emptyPayload.warnings.join(" ")).toMatch(/Obegränsad/);

    const geo = await handlers.scb_explain_query({
      objectType: "company",
      filters: { categories: [{ category: "Län", values: ["21"] }] },
    });
    expect(JSON.parse(geo.content[0]?.text ?? "{}").warnings.join(" ")).toMatch(/Säteslän|workplace/i);

    const op = await handlers.scb_explain_query({
      objectType: "company",
      filters: { variables: [{ variable: "Firma", operator: "Mellan", value: "a" }] },
    });
    const opPayload = JSON.parse(op.content[0]?.text ?? "{}") as {
      operatorValidation: { ok: boolean; issues: unknown[] };
    };
    expect(opPayload.operatorValidation.ok).toBe(false);
  });
});

describe("AE status in schema_summary", () => {
  it("marks Arbetsställestatus as top-level on workplace", () => {
    const summary = compactSchemaSummary(
      "workplace",
      { Kategorier: [{ Kategori: "Arbetsställestatus" }, { Kategori: "Län" }] },
      { Variabler: [{ Variabel: "CfarNr" }] },
    );
    const status = summary.categories.find((item) => item.name === "Arbetsställestatus");
    expect(status?.serialization).toBe("top-level");
    expect(summary.warnings.join(" ")).toMatch(/exampleAe|toppnivå/i);
  });
});

describe("catalog lookup still used by eval helpers", () => {
  it("resolves Gävleborg via mocked catalog", async () => {
    const handlers = createToolHandlers(createTestClient(catalogFetch({})), silent);
    const result = await handlers.scb_lookup_codes({ objectType: "workplace", query: "Gävleborg" });
    expect(JSON.parse(result.content[0]?.text ?? "{}").matches[0].code).toBe("21");
  });
});
