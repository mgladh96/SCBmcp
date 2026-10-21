import { describe, expect, it } from "vitest";
import { createCompanyDirectory, type CachedCompany } from "../src/companies/directory.js";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { ScbError } from "../src/domain/errors.js";
import { buildCatalogArtifact } from "../src/scb/offline-catalog.js";
import { MAX_RESULTS } from "../src/scb/types.js";
import { createTestClient, jsonResponse } from "./helpers.js";

const silent = createLogger("error");

function voiceCompanies(): CachedCompany[] {
  return [
    {
      organizationNumber: "5560000001",
      name: "TREEAB",
      nameNormalized: "treeab",
      city: "Uppsala",
      sizeClass: "20-49 anställda",
      industry: "41200 Byggande av hus",
      status: "verksam",
    },
    {
      organizationNumber: "5560000002",
      name: "TORÉNS AB",
      nameNormalized: "torens",
      city: "Malmö",
      status: "verksam",
    },
  ];
}

function directoryOf(companies: CachedCompany[]) {
  return createCompanyDirectory({
    load: async () => companies,
  });
}

describe("MCP input validation", () => {
  it("rejects missing objectType", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => jsonResponse(200, [])),
      silent,
    );
    const result = await handlers.scb_list_categories({});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      code: string;
      nextAction?: string;
      nextTools?: string[];
      details?: { field?: string };
    };
    expect(payload.code).toBe("SCB_INVALID_QUERY");
    expect(payload.nextAction).toBe("retry_modified");
    expect(payload.nextTools).toContain("scb_list_categories");
    expect(payload.details?.field).toBe("objectType");
  });

  it("rejects unknown objectType", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => jsonResponse(200, [])),
      silent,
    );
    const result = await handlers.scb_list_categories({ objectType: "provider" });
    expect(result.isError).toBe(true);
  });

  it("requires category for scb_get_category_values", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => jsonResponse(200, [])),
      silent,
    );
    const result = await handlers.scb_get_category_values({ objectType: "company" });
    expect(result.isError).toBe(true);
  });
});

describe("MCP JE vs AE tools", () => {
  it("routes company count to JE", async () => {
    const paths: string[] = [];
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        paths.push(new URL(url).pathname);
        return jsonResponse(200, 7);
      }),
      silent,
    );
    const result = await handlers.scb_count_companies({
      filters: {
        categories: [{ category: "Företagsstatus", values: ["1"] }],
      },
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      objectType: string;
    };
    expect(payload.count).toBe(7);
    expect(payload.objectType).toBe("company");
    expect(paths[0]).toContain("/api/je/raknaforetag");
    expect(payload).not.toHaveProperty("warning");
  });

  it("routes workplace search to AE and preserves Reklam", async () => {
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        if (url.includes("raknaarbetsstallen")) {
          return jsonResponse(200, 1);
        }
        return jsonResponse(200, [{ CfarNr: "123", Reklam: "21" }]);
      }),
      silent,
    );
    const result = await handlers.scb_search_workplaces({
      filters: { categories: [{ category: "Arbetsställestatus", values: ["1"] }] },
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      results: Array<{ Reklam?: string }>;
    };
    expect(payload.results[0]?.Reklam).toBe("21");
    expect((payload as { warning?: string }).warning).toBeUndefined();
  });
});

function nameCatalog(variableNames: string[]) {
  return buildCatalogArtifact({
    source: "fixture",
    layouts: {
      company: { categoryNames: ["Företagsstatus"], variableNames, tables: [] },
      workplace: { categoryNames: [], variableNames: [], tables: [] },
    },
  });
}

describe("scb_find_company", () => {
  it("searches by name and organisation number and caps rows for a voice agent", async () => {
    const bodies: unknown[] = [];
    const handlers = createToolHandlers(
      createTestClient(async (url, init) => {
        if (url.includes("hamtaforetag")) {
          bodies.push(JSON.parse(init.body ?? "{}"));
          return jsonResponse(200, [{ "Företagsnamn": "Testbolaget AB", OrgNr: "5560747569", Reklam: "21" }]);
        }
        return jsonResponse(200, 1);
      }),
      silent,
    );
    const result = await handlers.scb_find_company({
      name: "Testbolaget",
      organizationNumber: "5560747569",
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      returned: number;
      results: Array<{ organizationNumber?: string; name?: string; status?: string }>;
    };
    expect(payload.count).toBe(1);
    expect(payload.returned).toBe(1);
    expect(payload).toMatchObject({ source: "scb", attribution: "Källa: SCB" });
    expect(payload.results).toEqual([
      { organizationNumber: "5560747569", name: "Testbolaget AB" },
    ]);
    expect(bodies[0]).toMatchObject({
      variabler: [
        { Variabel: "Namn", Operator: "Innehaller", Varde1: "Testbolaget" },
        { Variabel: "OrgNr (10 siffror)", Operator: "ArLikaMed", Varde1: "5560747569" },
      ],
    });
  });

  it("ranks IKEA hits and returns at most three compact voice rows", async () => {
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        if (url.includes("hamtaforetag")) {
          return jsonResponse(200, [
            {
              Företagsnamn: "IKEA GmbH",
              OrgNr: "5560000001",
              Säteskommun: "Utlandet",
              Företagsstatus: "9",
              Storleksklass: "0 anställda",
              Bransch: "46900",
              "Bransch, text": "Partihandel",
            },
            {
              Företagsnamn: "IKEA of Sweden AB",
              OrgNr: "5560747569",
              Säteskommun: "Älmhult",
              Säteslän: "Kronobergs län",
              Företagsstatus: "1",
              Storleksklass: "5000-9999 anställda",
              Bransch: "47191",
              "Bransch, text": "Specialiserad butikshandel med möbler",
            },
            {
              Företagsnamn: "IKEA AB",
              OrgNr: "5560743089",
              Säteskommun: "Älmhult",
              Företagsstatus: "verksam",
              Storleksklass: "1000-1499 anställda",
              Bransch: "47191",
              "Bransch, text": "Specialiserad butikshandel med möbler",
            },
            {
              Företagsnamn: "Något IKEA Café AB",
              OrgNr: "5560743090",
              Säteskommun: "Helsingborg",
              Företagsstatus: "1",
              "Stkl, kod": "2",
              Bransch: "56100",
            },
            {
              Företagsnamn: "IKEA Retail AB",
              OrgNr: "5560743091",
              Säteskommun: "0180",
              Företagsstatus: "1",
              Storleksklass: "200-499 anställda",
            },
          ]);
        }
        return jsonResponse(200, 57);
      }),
      silent,
    );
    const result = await handlers.scb_find_company({ name: "IKEA" });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      returned: number;
      note?: string;
      results: Array<{ name?: string; city?: string; sizeClass?: string; industry?: string; status?: string }>;
    };
    expect(payload.count).toBe(57);
    expect(payload.returned).toBe(3);
    expect(payload.note).toBe("Visar verksamma företag med säte i Sverige.");
    expect(payload.results.map((row) => row.name)).toEqual([
      "IKEA of Sweden AB",
      "IKEA AB",
      "IKEA Retail AB",
    ]);
    expect(payload.results[0]).toEqual({
      organizationNumber: "5560747569",
      name: "IKEA of Sweden AB",
      city: "Älmhult",
      sizeClass: "5000-9999 anställda",
      industry: "47191 Specialiserad butikshandel med möbler",
      status: "verksam",
    });
    expect(payload.results[2]?.city).toBeUndefined();
    expect(payload.results.every((row) => row.status === "verksam")).toBe(true);
    expect(JSON.stringify(payload.results)).not.toContain("Utlandet");
    expect(JSON.stringify(payload.results)).not.toContain("Reklam");
  });

  it("filters IKEA on Namn even when the catalog also lists Företagsnamn", async () => {
    const bodies: unknown[] = [];
    const handlers = createToolHandlers(
      createTestClient(
        async (url, init) => {
          if (url.includes("hamtaforetag")) {
            bodies.push(JSON.parse(init.body ?? "{}"));
            return jsonResponse(200, [{ Företagsnamn: "IKEA of Sweden AB", OrgNr: "5560747569" }]);
          }
          return jsonResponse(200, 1);
        },
        {
          offlineCatalog: nameCatalog(["Företagsnamn", "Namn", "OrgNr (10 siffror)"]),
        },
      ),
      silent,
    );
    const result = await handlers.scb_find_company({ name: "IKEA" });
    expect(result.isError).toBeUndefined();
    const variabler = (bodies[0] as { variabler: Array<{ Variabel: string }> }).variabler;
    expect(variabler).toEqual([{ Variabel: "Namn", Operator: "Innehaller", Varde1: "IKEA", Varde2: "" }]);
    expect(variabler.map((item) => item.Variabel)).not.toContain("Företagsnamn");
  });

  it("does not send Företagsnamn when that is the only catalog name", async () => {
    const bodies: unknown[] = [];
    const handlers = createToolHandlers(
      createTestClient(
        async (url, init) => {
          if (url.includes("hamtaforetag")) {
            bodies.push(JSON.parse(init.body ?? "{}"));
            return jsonResponse(200, []);
          }
          return jsonResponse(200, 1);
        },
        { offlineCatalog: nameCatalog(["Företagsnamn"]) },
      ),
      silent,
    );
    await handlers.scb_find_company({ name: "IKEA" });
    expect((bodies[0] as { variabler: Array<{ Variabel: string }> }).variabler[0]?.Variabel).toBe("Namn");
  });

  it("uses Firma when the purchased list has Firma and not Namn", async () => {
    const bodies: unknown[] = [];
    const handlers = createToolHandlers(
      createTestClient(
        async (url, init) => {
          if (url.includes("hamtaforetag")) {
            bodies.push(JSON.parse(init.body ?? "{}"));
            return jsonResponse(200, []);
          }
          return jsonResponse(200, 1);
        },
        { offlineCatalog: nameCatalog(["Firma", "OrgNr (10 siffror)"]) },
      ),
      silent,
    );
    await handlers.scb_find_company({ name: "IKEA" });
    expect((bodies[0] as { variabler: Array<{ Variabel: string }> }).variabler[0]?.Variabel).toBe("Firma");
  });

  it("returns a short voice error when SCB rejects the variable", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () =>
        jsonResponse(400, {
          message: "Variabeln Företagsnamn kan inte hittas",
          nearestNames: ["Namn", "Firma", "OrgNr (10 siffror)"],
        }),
      ),
      silent,
    );
    const result = await handlers.scb_find_company({ name: "IKEA" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({
      code: "SCB_UNKNOWN_VARIABLE",
      message: "Namnsökningen gick inte igenom. Prova organisationsnummer.",
    });
    expect(result.content[0]?.text.length).toBeLessThan(120);
    expect(payload).not.toHaveProperty("details");
    expect(payload).not.toHaveProperty("nearestNames");
  });

  it("answers a spoken name from the local index and does not call SCB", async () => {
    let called = false;
    const handlers = createToolHandlers(
      createTestClient(async () => {
        called = true;
        return jsonResponse(200, 0);
      }),
      silent,
      { companies: directoryOf(voiceCompanies()) },
    );
    const result = await handlers.scb_find_company({ name: "Treab" });
    expect(called).toBe(false);
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      returned: number;
      source?: string;
      attribution?: string;
      results: Array<{ organizationNumber?: string; name?: string; city?: string; industry?: string; status?: string }>;
    };
    expect(payload).toMatchObject({
      source: "cache",
      attribution: "Källa: SCB",
      count: 1,
      returned: 1,
    });
    expect(payload.results[0]).toEqual({
      organizationNumber: "5560000001",
      name: "TREEAB",
      city: "Uppsala",
      sizeClass: "20-49 anställda",
      industry: "41200 Byggande av hus",
      status: "verksam",
    });
  });

  it("resolves an organisation number from the local index before SCB", async () => {
    let called = false;
    const handlers = createToolHandlers(
      createTestClient(async () => {
        called = true;
        return jsonResponse(200, 0);
      }),
      silent,
      { companies: directoryOf(voiceCompanies()) },
    );
    const result = await handlers.scb_find_company({ organizationNumber: "165560000001" });
    expect(called).toBe(false);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { source?: string; results: Array<{ name?: string }> };
    expect(payload.source).toBe("cache");
    expect(payload.results[0]?.name).toBe("TREEAB");
  });

  it("falls back to SCB when the local index has no reasonable name", async () => {
    const bodies: unknown[] = [];
    const handlers = createToolHandlers(
      createTestClient(async (url, init) => {
        if (url.includes("hamtaforetag")) {
          bodies.push(JSON.parse(init.body ?? "{}"));
          return jsonResponse(200, [{ Företagsnamn: "IKEA of Sweden AB", OrgNr: "5560747569" }]);
        }
        return jsonResponse(200, 1);
      }),
      silent,
      { companies: directoryOf(voiceCompanies()) },
    );
    const result = await handlers.scb_find_company({ name: "IKEA" });
    expect(result.isError).toBeUndefined();
    expect(bodies).toHaveLength(1);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { source?: string; results: Array<{ name?: string }> };
    expect(payload.source).toBe("scb");
    expect(payload.results[0]?.name).toBe("IKEA of Sweden AB");
  });

  it("gives up on a slow live name search before the voice agent is stuck", async () => {
    const handlers = createToolHandlers(
      createTestClient(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
            });
          }),
      ),
      silent,
      {
        companies: directoryOf([]),
        liveNameTimeoutMs: 40,
      },
    );
    const started = Date.now();
    const result = await handlers.scb_find_company({ name: "IKEA" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { code?: string; message?: string };
    expect(payload.code).toBe("SCB_UNAVAILABLE");
    expect(payload.message).toBe("Företagsregistret svarar inte just nu.");
  });

  it("requires a name or an organisation number", async () => {
    const handlers = createToolHandlers(createTestClient(async () => jsonResponse(200, 0)), silent);
    const result = await handlers.scb_find_company({});
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { code: string; message: string };
    expect(payload.code).toBe("SCB_INVALID_QUERY");
    expect(payload.message).toBe("Ange företagsnamn eller organisationsnummer.");
    expect(payload).not.toHaveProperty("details");
  });
});

describe("MCP QUERY_TOO_BROAD", () => {
  it("returns structured QUERY_TOO_BROAD without fetching rows", async () => {
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        if (url.includes("hamta")) {
          throw new Error("should not fetch");
        }
        return jsonResponse(200, MAX_RESULTS + 100);
      }),
      silent,
    );
    const result = await handlers.scb_search_companies({
      filters: { categories: [{ category: "Företagsstatus", values: ["1"] }] },
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      code: string;
      nextAction?: string;
      nextTools?: string[];
      details: {
        count: number;
        maxResults: number;
        suggestion: string;
        appliedFilters?: unknown;
        candidateNarrowingDimensions?: unknown[];
        objectType?: string;
        layout?: string;
      };
    };
    expect(payload.code).toBe("QUERY_TOO_BROAD");
    expect(payload.nextAction).toBe("retry_modified");
    expect(payload.nextTools).toContain("scb_count_companies");
    expect(payload.details.count).toBe(MAX_RESULTS + 100);
    expect(payload.details.objectType).toBe("company");
    expect(payload.details.layout).toBe("je");
    expect(payload.details.appliedFilters).toEqual({
      categories: [{ category: "Företagsstatus", values: ["1"] }],
      variables: [],
    });
    expect(payload.details.candidateNarrowingDimensions?.length).toBeGreaterThan(0);
    expect(payload.details.suggestion).toMatch(/Smalna|paginera inte/i);
  });
});

describe("MCP error passthrough", () => {
  it("returns SCB_UNAVAILABLE for HTTP 503", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => new Response("http ERROR 503", { status: 503 })),
      silent,
    );
    const result = await handlers.scb_list_variables({ objectType: "workplace" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as ScbError;
    expect(payload.code).toBe("SCB_UNAVAILABLE");
    expect(payload.nextAction).toBe("retry_same");
  });

  it("includes unknownName on SCB_UNKNOWN_CATEGORY", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => jsonResponse(400, { message: "Okänd kategori" })),
      silent,
    );
    const result = await handlers.scb_get_category_values({
      objectType: "company",
      category: "Bransch",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      code: string;
      nextAction?: string;
      nextTools?: string[];
      details: { unknownName?: string; field?: string };
    };
    expect(payload.code).toBe("SCB_UNKNOWN_CATEGORY");
    expect(payload.nextAction).toBe("retry_modified");
    expect(payload.nextTools).toEqual(
      expect.arrayContaining(["scb_list_categories", "scb_schema_summary", "scb_lookup_codes"]),
    );
    expect(payload.details.unknownName).toBe("Bransch");
    expect(payload.details.field).toBe("category");
  });
});

describe("MCP metadata envelope", () => {
  it("returns items + raw for list categories", async () => {
    const handlers = createToolHandlers(
      createTestClient(async () => jsonResponse(200, { Kategorier: [{ Kategori: "Företagsstatus" }] })),
      silent,
    );
    const result = await handlers.scb_list_categories({ objectType: "company" });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      items: Array<{ name: string }>;
      categories: { Kategorier: unknown[] };
      raw: { Kategorier: unknown[] };
    };
    expect(payload.items[0]?.name).toBe("Företagsstatus");
    expect(payload.raw.Kategorier).toHaveLength(1);
    expect(payload.categories.Kategorier).toHaveLength(1);
  });
});

describe("MCP empty filters warning", () => {
  it("warns on unbounded count but still calls SCB", async () => {
    const paths: string[] = [];
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        paths.push(new URL(url).pathname);
        return jsonResponse(200, 12);
      }),
      silent,
    );
    const result = await handlers.scb_count_companies({ filters: {} });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      warning?: string;
    };
    expect(payload.count).toBe(12);
    expect(payload.warning).toMatch(/Obegränsad fråga/);
    expect(paths[0]).toContain("/api/je/raknaforetag");
  });
});

describe("MCP search count zero", () => {
  it("returns empty results without fetching when count is 0", async () => {
    const paths: string[] = [];
    const handlers = createToolHandlers(
      createTestClient(async (url) => {
        paths.push(new URL(url).pathname);
        return jsonResponse(200, 0);
      }),
      silent,
    );
    const result = await handlers.scb_search_companies({
      filters: { categories: [{ category: "Företagsstatus", values: ["1"] }] },
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      count: number;
      returned: number;
      skippedFetch?: boolean;
    };
    expect(payload.count).toBe(0);
    expect(payload.returned).toBe(0);
    expect(payload.skippedFetch).toBe(true);
    expect(paths.some((path) => path.includes("hamta"))).toBe(false);
  });
});
