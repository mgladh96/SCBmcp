import { fold, resolveCatalogName } from "../../domain/catalog.js";
import { fieldMatchesToken, isReklamField, projectSearchResults } from "../projection.js";
import type { ScbFilters } from "../schemas.js";
import type { ObjectType } from "../types.js";
import { DEFAULT_SEMANTIC_FIELDS, type ResolvedFields } from "./types.js";

/**
 * Candidate SCB names per semantic id. Catalog bind uses these; projection
 * also matches live hamta keys (JE default columns: Företagsnamn, OrgNr,
 * PeOrgNr, Säteskommun, Storleksklass / Stkl, kod — not filter Namn).
 */
const FIELD_CANDIDATES: Record<string, { company: string[]; workplace: string[] }> = {
  name: {
    company: ["Företagsnamn", "Firma", "Namn"],
    workplace: ["Benämning", "Företagsnamn", "Namn"],
  },
  organizationNumber: {
    company: ["OrgNr", "PeOrgNr", "OrgNr (10 siffror)", "OrgNr (12 siffror)"],
    workplace: ["OrgNr", "PeOrgNr", "OrgNr (12 siffror)", "OrgNr (10 siffror)"],
  },
  municipality: {
    company: ["Säteskommun", "SätesKommun"],
    workplace: ["Kommun"],
  },
  employeeCount: {
    company: ["Storleksklass", "Stkl", "Storleksklass Anställda", "Anställda", "AnstSME"],
    workplace: ["Storleksklass", "Stkl", "Storleksklass Anställda", "Anställda", "AnstSME"],
  },
  county: {
    company: ["Säteslän", "SätesLän"],
    workplace: ["Län"],
  },
  status: {
    company: ["Företagsstatus"],
    workplace: ["Arbetsställestatus"],
  },
  workplaceNumber: {
    company: [],
    workplace: ["CfarNr"],
  },
};

export function resolveSemanticFields(
  objectType: ObjectType,
  requested: string[] | undefined,
  catalogNames: string[],
): { fields: ResolvedFields; missing: string[] } {
  const ids = requested && requested.length > 0 ? requested : [...DEFAULT_SEMANTIC_FIELDS];
  const fields: ResolvedFields = {};
  const missing: string[] = [];
  for (const id of ids) {
    const resolved = resolveOneField(id, objectType, catalogNames);
    if (resolved.length === 0) {
      missing.push(id);
      continue;
    }
    fields[id] = resolved;
  }
  return { fields, missing };
}

function resolveOneField(id: string, objectType: ObjectType, catalogNames: string[]): string[] {
  const candidates = fieldCandidates(id, objectType);
  const catalogHits: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const hit = resolveCatalogName([candidate], catalogNames);
    if (!hit || seen.has(fold(hit))) {
      continue;
    }
    if (catalogNames.length > 0 && !catalogNames.some((name) => fold(name) === fold(hit))) {
      continue;
    }
    seen.add(fold(hit));
    catalogHits.push(hit);
  }
  if (catalogHits.length === 0 && catalogNames.length > 0) {
    const foldedId = fold(id);
    for (const name of catalogNames) {
      if (fold(name) === foldedId || fieldMatchesToken(name, id)) {
        if (seen.has(fold(name))) {
          continue;
        }
        seen.add(fold(name));
        catalogHits.push(name);
      }
    }
  }
  if (catalogHits.length === 0) {
    return [];
  }
  return fieldLookupNames(id, objectType, catalogHits);
}

function fieldCandidates(id: string, objectType: ObjectType): string[] {
  const spec = FIELD_CANDIDATES[id];
  return spec ? spec[objectType] : [id];
}

/**
 * Live hamta keys plus catalog-bound names. Catalog may list Namn / OrgNr (10 siffror)
 * while JE rows use Företagsnamn / OrgNr.
 */
export function fieldLookupNames(
  id: string,
  objectType: ObjectType,
  resolvedNames: string[] = [],
): string[] {
  return uniqueNames([...fieldCandidates(id, objectType), ...resolvedNames]);
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const folded = fold(name);
    if (!folded || seen.has(folded)) {
      continue;
    }
    seen.add(folded);
    out.push(name);
  }
  return out;
}

export function projectionTokens(fieldMap: ResolvedFields): string[] {
  return [...new Set(Object.values(fieldMap).flat())];
}

/**
 * Do not inject variables to "select" columns on hamta. Live JE (and AE) already
 * returns a default set (Företagsnamn, OrgNr, Säteskommun, Storleksklass, …).
 * Operator Finns on Namn/OrgNr is rejected: "Operatorn Finns kombinerad med
 * variabeln Namn får ej användas." Same for ArLikaMed used as projection.
 *
 * Kept as the fetch chokepoint so count_then_fetch cannot reintroduce illegal
 * select operators. Real filter variables stay on compiled `filters.variables`.
 */
export function selectVariablesForFetch(
  _fieldMap?: ResolvedFields,
  _variableNames?: string[],
  _categoryNames?: string[],
  _existing: ScbFilters["variables"] = [],
): ScbFilters["variables"] {
  return [];
}

export function pickSemanticValue(row: Record<string, unknown>, scbNames: string[]): unknown {
  for (const name of scbNames) {
    const keys = Object.keys(row).filter((key) => fieldMatchesToken(key, name));
    keys.sort((a, b) => keyPreference(a) - keyPreference(b));
    for (const key of keys) {
      const value = row[key];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
  }
  return undefined;
}

function keyPreference(key: string): number {
  const folded = fold(key);
  if (folded.endsWith("text")) {
    return 0;
  }
  if (folded.endsWith("kod")) {
    return 2;
  }
  return 1;
}

export function aliasRowToSemantic(
  row: unknown,
  fieldMap: ResolvedFields,
  objectType: ObjectType = "company",
): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return {};
  }
  const input = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [semantic, names] of Object.entries(fieldMap)) {
    const value = pickSemanticValue(input, fieldLookupNames(semantic, objectType, names));
    if (value !== undefined) {
      out[semantic] = value;
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (isReklamField(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function projectToSemanticFields(
  results: unknown[],
  objectType: ObjectType,
  fieldMap: ResolvedFields,
  maxRows?: number,
): {
  results: Record<string, unknown>[];
  returned: number;
  fetched: number;
  omittedByMaxRows: number;
  projectedFields: string[];
  maxRows: number;
  reklamPreserved: boolean;
} {
  const tokens = [
    ...new Set(
      Object.entries(fieldMap).flatMap(([id, names]) => fieldLookupNames(id, objectType, names)),
    ),
  ];
  const projected = projectSearchResults(results, objectType, {
    ...(tokens.length > 0 ? { fields: tokens } : {}),
    ...(maxRows !== undefined ? { maxRows } : {}),
  });
  const aliased = projected.results.map((row) =>
    aliasRowToSemantic(row, fieldMap, objectType),
  );
  const fieldNames = new Set<string>();
  for (const row of aliased) {
    for (const key of Object.keys(row)) {
      fieldNames.add(key);
    }
  }
  return {
    results: aliased,
    returned: aliased.length,
    fetched: projected.fetched,
    omittedByMaxRows: projected.omittedByMaxRows,
    projectedFields: [...fieldNames].sort((a, b) => a.localeCompare(b, "sv")),
    maxRows: projected.maxRows,
    reklamPreserved: projected.reklamPreserved,
  };
}
