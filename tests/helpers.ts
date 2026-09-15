import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold } from "../src/domain/catalog.js";
import { fieldMatchesToken } from "../src/scb/projection.js";
import { ScbClient, type FetchLike } from "../src/scb/client.js";
import type { ScbAuthConfig } from "../src/scb/auth.js";
import {
  LIVE_NOISY_TWO_DIGIT_BRANSCH,
  LIVE_TWO_DIGIT_BRANSCH_CATEGORY,
} from "./fixtures/live-scb-metadata.js";

export function dummyCertPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "scb-cert-"));
  const path = join(dir, "dummy.pfx");
  writeFileSync(path, "not-a-real-pfx");
  return path;
}

export function testAuth(certPath = dummyCertPath()): ScbAuthConfig {
  return {
    apiId: "A12345",
    apiIdHeader: "api-id",
    certPath,
    certPassword: "secret",
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

export function createTestClient(fetchImpl: FetchLike, extras: { bypassMetadataCache?: boolean } = {}): ScbClient {
  return new ScbClient({
    baseUrl: "https://privateapi.scb.se/nv0101/v1/sokpavar",
    auth: testAuth(),
    fetch: fetchImpl,
    skipCertLoad: true,
    logLevel: "error",
    bypassMetadataCache: extras.bypassMetadataCache ?? false,
  });
}

export type MockCatalogSpec = {
  categories?: Record<"company" | "workplace", string[]>;
  variables?: Record<"company" | "workplace", string[]>;
  tables?: Record<string, Array<{ code: string; label: string }>>;
  /** Live privateapi.scb.se uses Id_Kategori_* / Varde+Text instead of Kategori/Kod. */
  shape?: "legacy" | "live";
};

/** Live-shaped catalog: no section F, 2-siffrig bransch + bygg substring noise. */
export function liveConstructionCatalogSpec(): MockCatalogSpec {
  return {
    shape: "live",
    categories: {
      company: [
        "Företagsstatus",
        "Registreringsstatus",
        "Säteslän",
        "Säteskommun",
        "Anställda",
        LIVE_TWO_DIGIT_BRANSCH_CATEGORY,
        "Bransch",
        "Omsättningsklass fin",
      ],
      workplace: [
        "Arbetsställestatus",
        "Län",
        "Kommun",
        LIVE_TWO_DIGIT_BRANSCH_CATEGORY,
        "Bransch",
        "Anställda",
      ],
    },
    variables: {
      company: ["Namn", "Firma", "OrgNr (10 siffror)", "OrgNr (12 siffror)"],
      workplace: ["Benämning", "CfarNr", "OrgNr (12 siffror)"],
    },
    tables: {
      Bransch: LIVE_NOISY_TWO_DIGIT_BRANSCH,
      [LIVE_TWO_DIGIT_BRANSCH_CATEGORY]: LIVE_NOISY_TWO_DIGIT_BRANSCH,
    },
  };
}

export function catalogFetch(spec: MockCatalogSpec): FetchLike {
  const live = spec.shape === "live";
  const defaultCategories = {
    company: [
      "Företagsstatus",
      "Registreringsstatus",
      "Säteslän",
      "Säteskommun",
      "SätesARegion",
      "Bransch",
      ...(live ? ["Omsättningsklass fin"] : []),
      "Storleksklass Anställda",
    ],
    workplace: [
      "Arbetsställestatus",
      "Län",
      "Kommun",
      "ARegion",
      "Bransch",
      ...(live ? ["Omsättningsklass fin"] : []),
      "Storleksklass Anställda",
    ],
  };
  const categories = {
    company: spec.categories?.company ?? defaultCategories.company,
    workplace: spec.categories?.workplace ?? defaultCategories.workplace,
  };
  const variables = spec.variables ?? {
    company: live
      ? ["Namn", "Firma", "Företagsnamn", "OrgNr (10 siffror)", "OrgNr (12 siffror)"]
      : ["Företagsnamn", "Firma", "PeOrgNr", "OrgNr"],
    workplace: live
      ? ["Benämning", "CfarNr", "OrgNr (12 siffror)"]
      : ["Benämning", "CfarNr", "PeOrgNr"],
  };
  const defaultTables: Record<string, Array<{ code: string; label: string }>> = {
    Företagsstatus: [
      { code: "1", label: "verksam" },
      { code: "0", label: "aldrig verksam" },
      { code: "9", label: "ej verksam" },
    ],
    Registreringsstatus: [{ code: "1", label: "skatteregistrerad" }],
    Arbetsställestatus: [{ code: "1", label: "verksam" }],
    Säteslän: [
      { code: "21", label: "Gävleborgs län" },
      { code: "01", label: "Stockholms län" },
      { code: "23", label: "Jämtlands län" },
    ],
    Län: [
      { code: "21", label: "Gävleborgs län" },
      { code: "01", label: "Stockholms län" },
      { code: "23", label: "Jämtlands län" },
    ],
    Säteskommun: [{ code: "2180", label: "Gävle" }, { code: "2380", label: "Östersund" }],
    Kommun: [{ code: "2180", label: "Gävle" }, { code: "2380", label: "Östersund" }],
    SätesARegion: [{ code: "SE322", label: "Jämtlands län" }],
    ARegion: [{ code: "SE322", label: "Jämtlands län" }],
    "Storleksklass Anställda": [
      { code: "0", label: "0 anställda" },
      { code: "1", label: "1-4 anställda" },
      { code: "2", label: "5-9 anställda" },
      { code: "4", label: "10-19 anställda" },
      { code: "5", label: "20-49 anställda" },
      { code: "6", label: "50-99 anställda" },
    ],
    Anställda: [
      { code: "0", label: "0 anställda" },
      { code: "1", label: "1-4 anställda" },
      { code: "2", label: "5-9 anställda" },
      { code: "4", label: "10-19 anställda" },
      { code: "5", label: "20-49 anställda" },
      { code: "6", label: "50-99 anställda" },
    ],
    "Omsättningsklass fin": [
      { code: "01", label: "1 - 49 tkr" },
      { code: "04", label: "10 000 - 19 999 tkr" },
      { code: "05", label: "20 000 - 49 999 tkr" },
    ],
    Bransch: live
      ? [
          { code: "F", label: "Byggverksamhet" },
          { code: "41", label: "Byggande av hus" },
          { code: "42", label: "Anläggningsarbeten" },
          { code: "43", label: "Specialiserad bygg- och anläggningsverksamhet" },
          { code: "41200", label: "Byggande av bostadshus" },
          { code: "41201", label: "Byggande av andra hus" },
          { code: "42110", label: "Anläggning av vägar och motorvägar" },
          { code: "42990", label: "Övrig bygg- och anläggningsverksamhet" },
          { code: "43120", label: "Mark- och grundarbeten för byggverksamhet" },
          { code: "43210", label: "Elinstallationer i bygg" },
          { code: "43310", label: "Puts-, fasad- och stuckatörsverksamhet" },
          { code: "43910", label: "Takarbeten inom bygg" },
          { code: "43999", label: "Annan specialiserad byggverksamhet" },
          { code: "62010", label: "Dataprogrammering" },
        ]
      : [
          { code: "F", label: "Byggverksamhet" },
          { code: "41", label: "Byggande av hus" },
          { code: "62010", label: "Dataprogrammering" },
        ],
  };
  const tables = { ...defaultTables, ...spec.tables };

  return async (url, init) => {
    const path = new URL(url).pathname;
    const objectType = path.includes("/ae/") ? "workplace" : "company";
    if (path.includes("koptakategorier")) {
      return jsonResponse(200, categoryListPayload(objectType, categories[objectType], live));
    }
    if (path.includes("koptavariabler") || path.endsWith("/variabler")) {
      return jsonResponse(200, variableListPayload(objectType, variables[objectType], live));
    }
    if (path.includes("kodtabell")) {
      const body = init.body ? (JSON.parse(init.body) as { Kategori?: string }) : {};
      const category = body.Kategori ?? "";
      if (objectType === "company" && (category === "Län" || category === "Kommun")) {
        return jsonResponse(400, { message: "Okänd kategori" });
      }
      if (objectType === "workplace" && category.startsWith("Sätes")) {
        return jsonResponse(400, { message: "Okänd kategori" });
      }
      const rows = tables[category];
      if (!rows) {
        return jsonResponse(400, { message: "Okänd kategori" });
      }
      return jsonResponse(
        200,
        live
          ? { Varden: rows.map((row) => ({ Varde: row.code, Text: row.label })) }
          : { Koder: rows.map((row) => ({ Kod: row.code, Text: row.label })) },
      );
    }
    return jsonResponse(200, []);
  };
}

export function catalogAndSearchFetch(
  spec: MockCatalogSpec,
  options: {
    count: number;
    results: unknown[];
    /**
     * Live JE omits Namn/OrgNr unless they are in POST variabler.
     * Default true so tests prove fetch requested those variables.
     */
    gateOutputVariables?: boolean;
  },
): FetchLike {
  const catalog = catalogFetch(spec);
  const gate = options.gateOutputVariables !== false;
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path.includes("rakna")) {
      return jsonResponse(200, options.count);
    }
    if (path.includes("hamta")) {
      const requested = requestedVariableNames(init.body);
      const rows = gate
        ? options.results.map((row) => gateSearchRow(row, requested))
        : options.results;
      return jsonResponse(200, rows);
    }
    return catalog(url, init);
  };
}

function requestedVariableNames(body: string | undefined): string[] {
  if (!body) {
    return [];
  }
  try {
    const parsed = JSON.parse(body) as { variabler?: Array<{ Variabel?: string }> };
    return (parsed.variabler ?? []).map((item) => item.Variabel ?? "").filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

function gateSearchRow(row: unknown, requested: string[]): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }
  const input = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (keepSearchField(key, requested)) {
      out[key] = value;
    }
  }
  return out;
}

function keepSearchField(key: string, requested: string[]): boolean {
  const folded = fold(key);
  if (folded === "reklam" || folded.startsWith("reklam") || folded.endsWith("reklam")) {
    return true;
  }
  if (isNameOutputField(key)) {
    return requested.some((name) => isNameOutputField(name) || fieldMatchesToken(key, name));
  }
  if (isOrgNrOutputField(key)) {
    return requested.some((name) => isOrgNrOutputField(name) || fieldMatchesToken(key, name));
  }
  return true;
}

function isNameOutputField(name: string): boolean {
  const n = fold(name);
  return (
    n.includes("foretagsnamn") ||
    n.includes("firma") ||
    n === "namn" ||
    n.startsWith("namn") ||
    n.includes("benamning")
  );
}

function isOrgNrOutputField(name: string): boolean {
  const n = fold(name);
  return n.includes("orgnr") || n.includes("peorgnr");
}

function categoryListPayload(
  objectType: "company" | "workplace",
  names: string[],
  live: boolean,
): Record<string, unknown> {
  if (!live) {
    return { Kategorier: names.map((name) => ({ Kategori: name })) };
  }
  return {
    KategoriGrupp: objectType === "workplace" ? "KategoriAE" : "KategoriJE",
    HemTyp: objectType === "workplace" ? "HemTagValAE" : "HemTagValJE",
    Kategorier: names.map((name) => {
      const jeName =
        name === "Företagsstatus" ||
        name === "Registreringsstatus" ||
        name.startsWith("Sätes");
      const key =
        objectType === "company" || jeName ? "Id_Kategori_JE" : "Id_Kategori_AE";
      return { [key]: name, TillaggsGrupp: "BasUtbud" };
    }),
  };
}

function variableListPayload(
  objectType: "company" | "workplace",
  names: string[],
  live: boolean,
): Record<string, unknown> {
  if (!live) {
    return { Variabler: names.map((name) => ({ Variabel: name })) };
  }
  const key = objectType === "workplace" ? "Id_Variabel_AE" : "Id_Variabel_JE";
  return { Variabler: names.map((name) => ({ [key]: name })) };
}
