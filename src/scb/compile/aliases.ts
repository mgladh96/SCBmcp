import { fold } from "../../domain/catalog.js";

/**
 * Small versioned synonym layer. SCB metadata (kodtabeller) remains source of truth —
 * do not grow this into a copy of the SCB schema.
 *
 * Language aliases expand to **search terms only** (labels/tokens). Never expand a
 * query to SNI codes (F, 41, 42, 43, …). Ranking comes from metadata search.
 */
export const SEMANTIC_ALIAS_VERSION = 5 as const;

const PLACE_ALIASES: Record<string, readonly string[]> = {
  jamtland: ["Jämtlands län", "Jämtland"],
  jamtlandslan: ["Jämtlands län", "Jämtland"],
  gavleborg: ["Gävleborgs län", "Gävleborg"],
  gavleborgslan: ["Gävleborgs län", "Gävleborg"],
};

/** Catalog/SCB label text for everyday cleaning-company words. Not SNI codes. */
const CLEANING_LABELS = ["Städning", "Städtjänster", "Lokalvård"] as const;
/** Catalog/SCB label text for earthworks / groundwork colloquialisms. Not SNI codes. */
const GROUNDWORK_LABELS = ["Mark- och grundarbeten", "mark", "Anläggningsarbeten"] as const;

/** Language → extra lexical search terms. Values must not be SNI codes. */
const INDUSTRY_ALIASES: Record<string, readonly string[]> = {
  bygg: ["Byggverksamhet", "Byggnad", "Byggande"],
  byggverksamhet: ["Byggverksamhet", "Byggnad", "Byggande"],
  restaurang: ["Restaurangverksamhet", "Restauranger", "Café", "Kafé"],
  cafe: ["Café", "Kafé", "Restaurangverksamhet"],
  kafe: ["Kafé", "Café", "Restaurangverksamhet"],
  transport: ["Transport", "Landtransport", "Magasinering", "Godstransport"],
  it: ["Informationsteknik", "Dataprogrammering", "Datakonsult", "Kommunikation"],
  stad: [...CLEANING_LABELS, "Rengöring", "Fastighetsservice"],
  stadning: [...CLEANING_LABELS, "Rengöring"],
  stadforetag: CLEANING_LABELS,
  stadfirma: CLEANING_LABELS,
  stadbolag: CLEANING_LABELS,
  lokalvardare: CLEANING_LABELS,
  lokalvard: CLEANING_LABELS,
  markentreprenad: GROUNDWORK_LABELS,
  markentreprenader: GROUNDWORK_LABELS,
  schakt: GROUNDWORK_LABELS,
  grav: GROUNDWORK_LABELS,
};

export function expandPlaceAliases(value: string, geoType: "county" | "municipality" | "aregion"): string[] {
  const out = [value, ...((PLACE_ALIASES[fold(value)] ?? []) as string[])];
  if (geoType === "county" && !fold(value).includes("lan")) {
    out.push(`${value}s län`, `${value} län`);
  }
  return uniqueKeepOrder(out);
}

export function expandIndustryAliases(query: string): string[] {
  const extra = INDUSTRY_ALIASES[fold(query)] ?? [];
  return uniqueKeepOrder([query, ...extra]);
}

/** Query expansion for discovery search: industry + place **terms**, never SNI codes. */
export function expandSearchTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  return uniqueKeepOrder([
    ...expandIndustryAliases(trimmed),
    ...(PLACE_ALIASES[fold(trimmed)] ?? []),
  ]);
}

function uniqueKeepOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = fold(value);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(value);
  }
  return result;
}
