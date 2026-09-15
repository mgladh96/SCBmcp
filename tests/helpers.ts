import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScbClient, type FetchLike } from "../src/scb/client.js";
import type { ScbAuthConfig } from "../src/scb/auth.js";

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

export function catalogFetch(spec: MockCatalogSpec): FetchLike {
  const categories = spec.categories ?? {
    company: ["Företagsstatus", "Registreringsstatus", "Säteslän", "Säteskommun", "Bransch", "Storleksklass Anställda"],
    workplace: ["Arbetsställestatus", "Län", "Kommun", "Bransch", "Storleksklass Anställda"],
  };
  const live = spec.shape === "live";
  const variables = spec.variables ?? {
    company: live
      ? ["Företagsnamn", "Firma", "OrgNr (10 siffror)", "OrgNr (12 siffror)"]
      : ["Företagsnamn", "Firma", "PeOrgNr", "OrgNr"],
    workplace: live
      ? ["Benämning", "CfarNr", "OrgNr (12 siffror)"]
      : ["Benämning", "CfarNr", "PeOrgNr"],
  };
  const tables = spec.tables ?? {
    Företagsstatus: [
      { code: "1", label: "verksam" },
      { code: "0", label: "aldrig verksam" },
      { code: "9", label: "ej verksam" },
    ],
    Registreringsstatus: [{ code: "1", label: "skatteregistrerad" }],
    Arbetsställestatus: [{ code: "1", label: "verksam" }],
    Säteslän: [{ code: "21", label: "Gävleborgs län" }, { code: "01", label: "Stockholms län" }],
    Län: [{ code: "21", label: "Gävleborgs län" }, { code: "01", label: "Stockholms län" }],
    Säteskommun: [{ code: "2180", label: "Gävle" }],
    Kommun: [{ code: "2180", label: "Gävle" }],
    "Storleksklass Anställda": [
      { code: "4", label: "10-19 anställda" },
      { code: "5", label: "20-49 anställda" },
    ],
    Bransch: [
      { code: "F", label: "Byggverksamhet" },
      { code: "41", label: "Byggande av hus" },
      { code: "62010", label: "Dataprogrammering" },
    ],
  };

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
