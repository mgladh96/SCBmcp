import {
  classifyCategoryKind,
  DEFAULT_LOOKUP_LIMIT,
  LOOKUP_KINDS,
  type CategoryKind,
} from "../domain/catalog.js";
import { buildDiscoveryIndex, searchDiscoveryIndex, type DiscoveryHit } from "./discovery.js";
import { extractMetadataItems } from "./payload.js";
import type { ObjectType } from "./types.js";

export type CodeLookupMatch = {
  objectType: ObjectType;
  category: string;
  code: string;
  label: string;
  kind?: CategoryKind;
  level?: number | undefined;
  parentCode?: string | undefined;
  hasChildren?: boolean | undefined;
  score?: number | undefined;
};

export type CodeLookupResult = {
  query: string;
  objectType: ObjectType;
  matches: CodeLookupMatch[];
  total: number;
  returned: number;
};

export type CodeLookupSearchOptions = {
  kind?: CategoryKind | undefined;
  category?: string | undefined;
  parentCode?: string | undefined;
  limit?: number | undefined;
};

export function lookupTargetCategories(categoriesRaw: unknown, specified?: string): string[] {
  return lookupCategoryGroups(categoriesRaw, specified).flat();
}

export function lookupCategoryGroups(categoriesRaw: unknown, specified?: string): string[][] {
  const names = extractMetadataItems(categoriesRaw)
    .map((item) => item.name)
    .filter((name) => name.length > 0);
  if (specified) {
    const exact = names.find((name) => name === specified);
    return [[exact ?? specified]];
  }
  return LOOKUP_KINDS.map((kind) => names.filter((name) => classifyCategoryKind(name) === kind)).filter(
    (group) => group.length > 0,
  );
}

export function searchCodeTables(
  objectType: ObjectType,
  query: string,
  tables: Array<{ category: string; raw: unknown }>,
  limit = DEFAULT_LOOKUP_LIMIT,
  options: CodeLookupSearchOptions = {},
): CodeLookupResult {
  const index = buildDiscoveryIndex(objectType, tables);
  return searchIndex(index, query, { ...options, limit });
}

export function searchIndex(
  index: ReturnType<typeof buildDiscoveryIndex>,
  query: string,
  options: CodeLookupSearchOptions = {},
): CodeLookupResult {
  const limit = options.limit ?? DEFAULT_LOOKUP_LIMIT;
  const hits = searchDiscoveryIndex(index, {
    query,
    kind: options.kind,
    category: options.category,
    parentCode: options.parentCode,
  });
  const matches = hits.slice(0, limit).map(hitToMatch);
  return {
    query,
    objectType: index.objectType,
    matches,
    total: hits.length,
    returned: matches.length,
  };
}

function hitToMatch(hit: DiscoveryHit): CodeLookupMatch {
  const match: CodeLookupMatch = {
    objectType: hit.objectType,
    category: hit.category,
    code: hit.code,
    label: hit.label,
    kind: hit.kind,
    score: hit.score,
  };
  if (hit.level !== undefined) {
    match.level = hit.level;
  }
  if (hit.parentCode !== undefined) {
    match.parentCode = hit.parentCode;
  }
  if (hit.hasChildren !== undefined) {
    match.hasChildren = hit.hasChildren;
  }
  return match;
}
