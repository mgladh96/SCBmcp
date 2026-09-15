import { fold } from "../../domain/catalog.js";

/**
 * Small versioned synonym layer. SCB metadata (kodtabeller) remains source of truth —
 * do not grow this into a copy of the SCB schema.
 *
 * Construction: Swedish "bygg" / "byggverksamhet" maps to SNI section F and/or
 * 2-digit divisions 41–43 (Byggande av hus, anläggning, specialiserad bygg).
 * Live JE often has no section F; then 41/42/43 on `2-siffrig bransch *` is the
 * working path (same as `{ query: "41", level: 2 }`). Substring hits like
 * Byggplast / fartyg / handel are not construction.
 */
export const SEMANTIC_ALIAS_VERSION = 2 as const;

/** SNI 2007 section F — Construction / Byggverksamhet. */
export const CONSTRUCTION_SNI_SECTION = "F";

/** SNI 2007 construction divisions (2-digit). */
export const CONSTRUCTION_SNI_DIVISIONS = ["41", "42", "43"] as const;

export const CONSTRUCTION_SNI_CODES = [CONSTRUCTION_SNI_SECTION, ...CONSTRUCTION_SNI_DIVISIONS] as const;

const PLACE_ALIASES: Record<string, readonly string[]> = {
  jamtland: ["Jämtlands län", "Jämtland"],
  jamtlandslan: ["Jämtlands län", "Jämtland"],
  gavleborg: ["Gävleborgs län", "Gävleborg"],
  gavleborgslan: ["Gävleborgs län", "Gävleborg"],
};

const INDUSTRY_ALIASES: Record<string, readonly string[]> = {
  bygg: ["Byggverksamhet", "Bygg", ...CONSTRUCTION_SNI_CODES],
  byggverksamhet: ["Byggverksamhet", ...CONSTRUCTION_SNI_CODES],
};

const CONSTRUCTION_QUERY_FOLDS = new Set(["bygg", "byggverksamhet"]);

/** Labels that contain "bygg" but are not construction SNI (rubber, shipbuilding, trade). */
const CONSTRUCTION_NOISE_FOLDS = ["plast", "fartyg", "handel", "grossist", "detalj"];

export function isConstructionIndustryQuery(query: string): boolean {
  return CONSTRUCTION_QUERY_FOLDS.has(fold(query));
}

export function isConstructionSniCode(code: string): boolean {
  const trimmed = code.trim().toUpperCase();
  return (CONSTRUCTION_SNI_CODES as readonly string[]).includes(trimmed);
}

export function isConstructionNoiseLabel(label: string): boolean {
  const folded = fold(label);
  return CONSTRUCTION_NOISE_FOLDS.some((noise) => folded.includes(noise));
}

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
