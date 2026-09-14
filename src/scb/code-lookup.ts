import {
  classifyCategoryKind,
  codeRowMatches,
  DEFAULT_LOOKUP_LIMIT,
  extractCodeRows,
  LOOKUP_KINDS,
  type CategoryKind,
} from "../domain/catalog.js";
import { extractMetadataItems } from "./payload.js";
import type { ObjectType } from "./types.js";

export type CodeLookupMatch = {
  objectType: ObjectType;
  category: string;
  code: string;
  label: string;
  kind?: CategoryKind;
};

export type CodeLookupResult = {
  query: string;
  objectType: ObjectType;
  matches: CodeLookupMatch[];
  total: number;
  returned: number;
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
): CodeLookupResult {
  const scored: Array<CodeLookupMatch & { score: number }> = [];
  for (const table of tables) {
    const kind = classifyCategoryKind(table.category);
    for (const row of extractCodeRows(table.raw)) {
      const score = codeRowMatches(row, query);
      if (score <= 0) {
        continue;
      }
      scored.push({
        objectType,
        category: table.category,
        code: row.code,
        label: row.label,
        kind,
        score,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.category.localeCompare(b.category, "sv") || a.code.localeCompare(b.code));
  const matches = scored.slice(0, limit).map(({ score: _score, ...match }) => match);
  return {
    query,
    objectType,
    matches,
    total: scored.length,
    returned: matches.length,
  };
}
