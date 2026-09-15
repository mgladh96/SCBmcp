import { fold } from "../../domain/catalog.js";

/**
 * Small versioned synonym layer. SCB metadata (kodtabeller) remains source of truth —
 * do not grow this into a copy of the SCB schema.
 */
export const SEMANTIC_ALIAS_VERSION = 1 as const;

const PLACE_ALIASES: Record<string, readonly string[]> = {
  jamtland: ["Jämtlands län", "Jämtland"],
  jamtlandslan: ["Jämtlands län", "Jämtland"],
  gavleborg: ["Gävleborgs län", "Gävleborg"],
  gavleborgslan: ["Gävleborgs län", "Gävleborg"],
};

const INDUSTRY_ALIASES: Record<string, readonly string[]> = {
  bygg: ["Byggverksamhet", "Bygg"],
  byggverksamhet: ["Byggverksamhet"],
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
