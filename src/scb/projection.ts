import { fold } from "../domain/catalog.js";
import { DEFAULT_SEARCH_MAX_ROWS, type ObjectType } from "./types.js";

export { DEFAULT_SEARCH_MAX_ROWS, MAX_SEARCH_MAX_ROWS } from "./types.js";

export const REKLAM_FIELD_TOKEN = "reklam";

const COMPANY_DEFAULT_TOKENS = [
  "peorgnr",
  "orgnr",
  "foretagsnamn",
  "firma",
  "namn",
  "foretagsstatus",
  "registreringsstatus",
  "sateslan",
  "sateskommun",
  "aregion",
  "postort",
  "postnr",
  "bransch",
  "sni",
  "avdelning",
  "naringsgren",
  "storleksklass",
  "anstsme",
  REKLAM_FIELD_TOKEN,
];

const WORKPLACE_DEFAULT_TOKENS = [
  "cfarnr",
  "peorgnr",
  "orgnr",
  "benamning",
  "foretagsnamn",
  "namn",
  "arbetsstallestatus",
  "lan",
  "kommun",
  "besok",
  "aregion",
  "postort",
  "postnr",
  "bransch",
  "sni",
  "avdelning",
  "naringsgren",
  "storleksklass",
  "anstsme",
  REKLAM_FIELD_TOKEN,
];

export function defaultFieldTokens(objectType: ObjectType): string[] {
  return objectType === "workplace" ? WORKPLACE_DEFAULT_TOKENS : COMPANY_DEFAULT_TOKENS;
}

export function isReklamField(name: string): boolean {
  const folded = fold(name);
  return folded === REKLAM_FIELD_TOKEN || folded.startsWith(REKLAM_FIELD_TOKEN) || folded.endsWith(REKLAM_FIELD_TOKEN);
}

/**
 * Exact folded match, or prefix/stem match with a token boundary.
 * Does not use bidirectional `includes` (avoids "Nr"→PeOrgNr, "lan"→Plan).
 */
export function fieldMatchesToken(fieldName: string, token: string): boolean {
  const folded = fold(fieldName);
  const needle = fold(token);
  if (!folded || !needle) {
    return false;
  }
  if (folded === needle) {
    return true;
  }
  const stem = stripMetadataSuffix(folded);
  if (stem === needle) {
    return true;
  }
  if (stem.startsWith(needle)) {
    const rest = stem.slice(needle.length);
    if (rest === "" || /^\d/.test(rest) || needle.length >= 4) {
      return true;
    }
  }
  return false;
}

function stripMetadataSuffix(folded: string): string {
  return folded.replace(/(kod|text)$/u, "");
}

export function shouldKeepField(
  fieldName: string,
  objectType: ObjectType,
  requested?: string[] | undefined,
): boolean {
  if (isReklamField(fieldName)) {
    return true;
  }
  if (requested && requested.length > 0) {
    return requested.some((item) => fieldMatchesToken(fieldName, item));
  }
  return defaultFieldTokens(objectType).some((token) => fieldMatchesToken(fieldName, token));
}

export function projectRecord(
  record: unknown,
  objectType: ObjectType,
  requested?: string[] | undefined,
): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return record;
  }
  const input = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (shouldKeepField(key, objectType, requested)) {
      out[key] = value;
    }
  }
  return out;
}

export function projectSearchResults(
  results: unknown[],
  objectType: ObjectType,
  options: { fields?: string[] | undefined; maxRows?: number | undefined } = {},
): {
  results: unknown[];
  returned: number;
  fetched: number;
  omittedByMaxRows: number;
  projectedFields: string[];
  maxRows: number;
  reklamPreserved: boolean;
} {
  const maxRows = options.maxRows ?? DEFAULT_SEARCH_MAX_ROWS;
  const projected = results.map((row) => projectRecord(row, objectType, options.fields));
  const sliced = projected.slice(0, maxRows);
  const fieldNames = new Set<string>();
  let reklamPreserved = false;
  for (const row of sliced) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    for (const key of Object.keys(row)) {
      fieldNames.add(key);
      if (isReklamField(key)) {
        reklamPreserved = true;
      }
    }
  }
  if (!reklamPreserved) {
    reklamPreserved = results.some((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return false;
      }
      return Object.keys(row).some((key) => isReklamField(key));
    })
      ? sliced.some((row) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) {
            return false;
          }
          return Object.keys(row).some((key) => isReklamField(key));
        })
      : true;
  }
  return {
    results: sliced,
    returned: sliced.length,
    fetched: results.length,
    omittedByMaxRows: Math.max(0, projected.length - sliced.length),
    projectedFields: [...fieldNames].sort((a, b) => a.localeCompare(b, "sv")),
    maxRows,
    reklamPreserved,
  };
}
