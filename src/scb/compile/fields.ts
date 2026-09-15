import { fold, resolveCatalogName } from "../../domain/catalog.js";
import { fieldMatchesToken, isReklamField, projectSearchResults } from "../projection.js";
import type { ObjectType } from "../types.js";
import { DEFAULT_SEMANTIC_FIELDS, type ResolvedFields } from "./types.js";

/**
 * Candidate SCB names per semantic id. Resolved against live catalog (variables + categories).
 * Not a full SCB schema copy — only enough aliases to bind semantic slots.
 */
const FIELD_CANDIDATES: Record<string, { company: string[]; workplace: string[] }> = {
  name: {
    company: ["Företagsnamn", "Firma", "Namn"],
    workplace: ["Benämning", "Företagsnamn", "Namn"],
  },
  organizationNumber: {
    company: ["OrgNr (10 siffror)", "OrgNr (12 siffror)", "PeOrgNr", "OrgNr"],
    workplace: ["OrgNr (12 siffror)", "OrgNr (10 siffror)", "PeOrgNr", "OrgNr"],
  },
  municipality: {
    company: ["Säteskommun", "SätesKommun"],
    workplace: ["Kommun"],
  },
  employeeCount: {
    company: ["Storleksklass Anställda", "Anställda", "AnstSME"],
    workplace: ["Storleksklass Anställda", "Anställda", "AnstSME"],
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
  const spec = FIELD_CANDIDATES[id];
  const candidates = spec
    ? spec[objectType]
    : [id];
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const hit = resolveCatalogName([candidate], catalogNames);
    if (!hit || seen.has(hit)) {
      continue;
    }
    if (catalogNames.length > 0 && !catalogNames.some((name) => fold(name) === fold(hit))) {
      continue;
    }
    seen.add(hit);
    resolved.push(hit);
  }
  if (resolved.length === 0 && catalogNames.length > 0) {
    const foldedId = fold(id);
    for (const name of catalogNames) {
      if (fold(name) === foldedId || fieldMatchesToken(name, id)) {
        resolved.push(name);
      }
    }
  }
  return resolved;
}

export function projectionTokens(fieldMap: ResolvedFields): string[] {
  return [...new Set(Object.values(fieldMap).flat())];
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
): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return {};
  }
  const input = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [semantic, names] of Object.entries(fieldMap)) {
    const value = pickSemanticValue(input, names);
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
  const tokens = projectionTokens(fieldMap);
  const projected = projectSearchResults(results, objectType, {
    ...(tokens.length > 0 ? { fields: tokens } : {}),
    ...(maxRows !== undefined ? { maxRows } : {}),
  });
  const aliased = projected.results.map((row) => aliasRowToSemantic(row, fieldMap));
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
