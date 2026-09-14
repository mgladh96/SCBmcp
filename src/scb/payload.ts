import type { ScbFilters } from "./schemas.js";
import type { ScbLayout } from "./types.js";

/**
 * POST bodies follow SCB help examples (certificate-gated):
 * /help/exampleJe and (for AE status) /help/exampleAe.
 *
 * JE: Företagsstatus and Registreringsstatus are top-level string properties.
 * AE: Arbetsställestatus is treated as top-level by default (catalog-driven),
 * analogously to JE — sourced from SCB docs + third-party exampleAe dumps.
 * Live `/help/exampleAe` is certificate-gated; set SCB_AE_STATUS_TOP_LEVEL=false
 * to serialize Arbetsställestatus inside Kategorier[] instead.
 *
 * Other categories use Kategorier[]. Variables use lowercase `variabler`
 * with Operator / Varde1 / Varde2 / Variabel.
 */
export const JE_TOP_LEVEL_CATEGORIES = ["Företagsstatus", "Registreringsstatus"] as const;
export const AE_TOP_LEVEL_STATUS = "Arbetsställestatus";

/** @deprecated Use topLevelCategoriesFor(layout). Kept as the JE set. */
export const TOP_LEVEL_CATEGORIES = new Set<string>(JE_TOP_LEVEL_CATEGORIES);

export const AE_STATUS_LIVE_CONFIRM_NOTE =
  "Arbetsställestatus serialiseras som toppnivåfält (samma mönster som JE Företagsstatus) utifrån SCB-dokumentation och tredjeparts exampleAe. Live /help/exampleAe är certifikat-låst och inte omverifierat här. Sätt SCB_AE_STATUS_TOP_LEVEL=false för Kategorier[] i stället.";

export function aeStatusTopLevelEnabled(): boolean {
  const raw = process.env.SCB_AE_STATUS_TOP_LEVEL?.trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "kategorier";
}

export function topLevelCategoriesFor(layout: ScbLayout = "je"): ReadonlySet<string> {
  if (layout === "ae") {
    return aeStatusTopLevelEnabled() ? new Set([AE_TOP_LEVEL_STATUS]) : new Set();
  }
  return new Set<string>(JE_TOP_LEVEL_CATEGORIES);
}

export function isTopLevelCategory(name: string, layout?: ScbLayout): boolean {
  if (layout) {
    return topLevelCategoriesFor(layout).has(name);
  }
  return name === "Företagsstatus" || name === "Registreringsstatus" ||
    (aeStatusTopLevelEnabled() && name === AE_TOP_LEVEL_STATUS);
}

export function toKodtabellBody(category: string): unknown {
  return { Kategori: category };
}

export function toScbQueryBody(filters: ScbFilters, layout: ScbLayout = "je"): unknown {
  const body: Record<string, unknown> = {};
  const kategorier: Array<Record<string, unknown>> = [];
  const topLevel = topLevelCategoriesFor(layout);

  for (const item of filters.categories) {
    if (topLevel.has(item.category)) {
      const first = item.values[0];
      if (first !== undefined) {
        body[item.category] = item.values.length === 1 ? first : item.values;
      }
      continue;
    }
    const entry: Record<string, unknown> = {
      Kategori: item.category,
      Kod: item.values,
    };
    if (item.branchLevel !== undefined) {
      entry.Branschniva = item.branchLevel;
    }
    kategorier.push(entry);
  }

  if (kategorier.length > 0) {
    body.Kategorier = kategorier;
  }

  if (filters.variables.length > 0) {
    body.variabler = filters.variables.map((item) => ({
      Variabel: item.variable,
      Operator: item.operator,
      Varde1: item.value ?? "",
      Varde2: item.value2 ?? "",
    }));
  }

  return body;
}

export function parseCountResponse(payload: unknown): number {
  if (typeof payload === "number" && Number.isFinite(payload)) {
    return payload;
  }
  if (typeof payload === "string" && payload.trim() !== "") {
    const parsed = Number(payload);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["antal", "Antal", "count", "Count", "raknatAntal", "RaknatAntal"]) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
  }
  throw malformed("Could not parse SCB count response.", payload);
}

export function parseListResponse(payload: unknown): unknown {
  return payload;
}

const METADATA_ARRAY_KEYS = [
  "Kategorier",
  "kategorier",
  "Variabler",
  "variabler",
  "Koder",
  "koder",
  "Varden",
  "varden",
  "Kodtabell",
  "kodtabell",
  "items",
];

const METADATA_NAME_KEYS = ["Kategori", "Variabel", "Namn", "name", "Kod", "kod", "Text", "text"];

export type MetadataItem = {
  name: string;
  [key: string]: unknown;
};

export type MetadataEnvelope = {
  objectType: "company" | "workplace";
  items: MetadataItem[];
  raw: unknown;
};

export function toMetadataEnvelope(
  objectType: "company" | "workplace",
  raw: unknown,
): MetadataEnvelope {
  return {
    objectType,
    items: extractMetadataItems(raw),
    raw,
  };
}

export function extractMetadataItems(raw: unknown): MetadataItem[] {
  return extractMetadataRows(raw).map(toMetadataItem);
}

export function truncateMetadataItems(
  raw: unknown,
  options: {
    query?: string | undefined;
    limit?: number | undefined;
    includeAll?: boolean | undefined;
    defaultLimit: number;
  },
): {
  items: MetadataItem[];
  total: number;
  returned: number;
  truncated: boolean;
} {
  const all = extractMetadataItems(raw);
  const query = options.query?.trim() ?? "";
  const filtered =
    query.length === 0
      ? all
      : all.filter((item) => metadataItemMatches(item, query));
  const includeAll = options.includeAll === true || options.limit === 0;
  const cap = includeAll ? filtered.length : (options.limit ?? options.defaultLimit);
  const items = filtered.slice(0, cap);
  return {
    items,
    total: filtered.length,
    returned: items.length,
    truncated: items.length < filtered.length,
  };
}

function metadataItemMatches(item: MetadataItem, query: string): boolean {
  const hay = Object.values(item)
    .filter((value) => typeof value === "string")
    .join(" ");
  const needle = query.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const foldedHay = hay.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return foldedHay.includes(needle) || hay.toLowerCase().includes(query.toLowerCase());
}

function extractMetadataRows(raw: unknown): unknown[] {
  if (raw == null) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of METADATA_ARRAY_KEYS) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value) && value.length > 0 && isLikelyMetadataRow(value[0])) {
        return value;
      }
    }
  }
  return [];
}

function isLikelyMetadataRow(value: unknown): boolean {
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return METADATA_NAME_KEYS.some((key) => typeof record[key] === "string");
}

function toMetadataItem(row: unknown): MetadataItem {
  if (typeof row === "string") {
    return { name: row };
  }
  if (row && typeof row === "object") {
    const record = row as Record<string, unknown>;
    let name = "";
    for (const key of METADATA_NAME_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        name = value;
        break;
      }
    }
    return { name, ...record };
  }
  return { name: "" };
}

export function parseSearchResponse(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of [
      "foretag",
      "Foretag",
      "arbetsstallen",
      "Arbetsstallen",
      "resultat",
      "Resultat",
      "results",
      "data",
    ]) {
      const value = record[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  throw malformed("Could not parse SCB search response as a list of records.", payload);
}

function malformed(message: string, payload: unknown): Error {
  const error = new Error(message);
  (error as Error & { payload?: unknown }).payload = payload;
  return error;
}
