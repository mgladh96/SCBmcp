import { classifyCategoryKind, extractCodeRows, fold } from "../../domain/catalog.js";
import { ScbError } from "../../domain/errors.js";
import { extractMetadataItems } from "../payload.js";
import type { CodeLookupMatch, CodeLookupResult } from "../code-lookup.js";
import { sniLevel } from "../discovery.js";
import type { ScbFilters } from "../schemas.js";
import { layoutFor, type ObjectType } from "../types.js";
import { expandIndustryAliases, expandPlaceAliases } from "./aliases.js";
import {
  formatBound,
  parseEmployeeBands,
  rangeRelation,
  selectOverlappingBands,
  unionBandRange,
} from "./bands.js";
import { resolveSemanticFields } from "./fields.js";
import {
  categoryNeedsBranchLevel,
  isRevenueCategory,
  isTwoDigitIndustryCategory,
  pickGeographyCategory,
  pickSizeCategory,
  pickStatusCategory,
  rankIndustryCategories,
} from "./geography.js";
import type { StructuredQuery } from "./schema.js";
import type {
  CompileMetadataSource,
  CompileResult,
  CoverageEntry,
  ResolvedCode,
  ResolvedMappings,
  UnresolvedConstraint,
} from "./types.js";

export async function compileStructuredQuery(
  query: StructuredQuery,
  client: CompileMetadataSource,
): Promise<CompileResult> {
  const objectType = query.objectType;
  const categoryNames = namesFrom(await client.listCategories(objectType, false));
  const variableNames = namesFrom(await client.listVariables(objectType, false));
  const catalogNames = unique([...categoryNames, ...variableNames]);

  const filters: ScbFilters = { categories: [], variables: [] };
  const coverage: CoverageEntry[] = [];
  const unresolved: UnresolvedConstraint[] = [];
  const warnings: string[] = [];
  const resolved: ResolvedMappings = {
    layout: layoutFor(objectType),
    fields: {},
  };

  await applyStatus(query, client, objectType, categoryNames, filters, resolved, coverage, unresolved, warnings);
  await applyGeography(query, client, objectType, categoryNames, filters, resolved, coverage, unresolved, warnings);
  await applyIndustry(query, client, objectType, categoryNames, filters, resolved, coverage, unresolved, warnings);
  await applyEmployees(query, client, objectType, categoryNames, filters, resolved, coverage, unresolved, warnings);
  applyFields(query, objectType, catalogNames, resolved, coverage, unresolved, warnings);

  const ok =
    unresolved.length === 0 && coverage.every((entry) => entry.relation !== "unrepresentable");

  return { ok, objectType, filters, resolved, coverage, warnings, unresolved };
}

function namesFrom(raw: unknown): string[] {
  return extractMetadataItems(raw)
    .map((item) => item.name)
    .filter((name) => name.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function applyStatus(
  query: StructuredQuery,
  client: CompileMetadataSource,
  objectType: ObjectType,
  categoryNames: string[],
  filters: ScbFilters,
  resolved: ResolvedMappings,
  coverage: CoverageEntry[],
  unresolved: UnresolvedConstraint[],
  warnings: string[],
): Promise<void> {
  const requested = query.status;
  if (requested === "any") {
    coverage.push({
      constraint: "status",
      requested,
      applied: null,
      relation: "exact",
      exact: true,
      message: "Ingen statusfiltrering (status=any).",
    });
    return;
  }

  const category = pickStatusCategory(categoryNames, objectType);
  if (!category) {
    unresolved.push({
      constraint: "status",
      requested,
      reason: "Ingen statuskategori i SCB-katalogen för objectType.",
    });
    coverage.push({
      constraint: "status",
      requested,
      applied: null,
      relation: "unrepresentable",
      exact: false,
      message: "Ingen Företagsstatus/Arbetsställestatus i metadata.",
    });
    return;
  }

  let rows: ReturnType<typeof extractCodeRows> = [];
  try {
    rows = extractCodeRows(await client.getCategoryValues(objectType, category));
  } catch (error) {
    if (error instanceof ScbError) {
      unresolved.push({
        constraint: "status",
        requested,
        reason: error.message,
      });
      return;
    }
    throw error;
  }

  const active =
    rows.find((row) => {
      const label = fold(row.label);
      return label === "verksam" || label.startsWith("verksam") || label === "aktiv";
    }) ?? rows.find((row) => row.code === "1");

  if (!active) {
    unresolved.push({
      constraint: "status",
      requested,
      reason: `Hittade inte verksam/aktiv i ${category}.`,
    });
    return;
  }

  filters.categories.push({ category, values: [active.code] });
  resolved.status = { category, value: active.code, label: active.label };
  coverage.push({
    constraint: "status",
    requested,
    applied: { category, value: active.code, label: active.label },
    relation: "exact",
    exact: true,
    message: `${category}=${active.code} (${active.label}).`,
  });
  warnings.push(`Standardstatus active → ${category}=${active.code} (${active.label}).`);
}

async function applyGeography(
  query: StructuredQuery,
  client: CompileMetadataSource,
  objectType: ObjectType,
  categoryNames: string[],
  filters: ScbFilters,
  resolved: ResolvedMappings,
  coverage: CoverageEntry[],
  unresolved: UnresolvedConstraint[],
  warnings: string[],
): Promise<void> {
  const slot = query.geography;
  if (!slot) {
    return;
  }

  const category = pickGeographyCategory(categoryNames, objectType, slot.type);
  if (!category) {
    const reason =
      objectType === "company" && slot.type === "county"
        ? "JE-katalog saknar Säteslän/SätesLän (använd inte AE-kategorin Län)."
        : `Ingen SCB-kategori för geography.type=${slot.type} på ${objectType}.`;
    unresolved.push({ constraint: "geography", requested: slot, reason });
    coverage.push({
      constraint: "geography",
      requested: slot,
      applied: null,
      relation: "unrepresentable",
      exact: false,
      message: reason,
    });
    return;
  }

  const matches = await lookupAliased(
    client,
    objectType,
    expandPlaceAliases(slot.value, slot.type),
    category,
  );
  const chosen = pickBestCodes(matches, slot.value);
  if (chosen.length === 0) {
    unresolved.push({
      constraint: "geography",
      requested: slot,
      reason: `Ingen kod för "${slot.value}" i ${category}.`,
    });
    coverage.push({
      constraint: "geography",
      requested: slot,
      applied: { category, codes: [] },
      relation: "unrepresentable",
      exact: false,
      message: `Kunde inte slå upp ${slot.type} "${slot.value}" i ${category}.`,
    });
    return;
  }

  filters.categories.push({ category, values: chosen.map((item) => item.code) });
  resolved.geography = { category, type: slot.type, codes: chosen };

  const labelFold = fold(chosen[0]?.label ?? "");
  const valueFold = fold(slot.value);
  const exactLabel =
    chosen.length === 1 &&
    (labelFold === valueFold || labelFold.includes(valueFold) || valueFold.includes(labelFold) || chosen[0]?.code === slot.value.trim());

  coverage.push({
    constraint: "geography",
    requested: slot,
    applied: { category, codes: chosen },
    relation: exactLabel ? "exact" : "partial",
    exact: exactLabel,
    message: exactLabel
      ? `${slot.type} "${slot.value}" → ${category} kod ${chosen.map((item) => item.code).join(", ")} (${chosen.map((item) => item.label).join(", ")}).`
      : `Geografi "${slot.value}" approximerades mot ${category}.`,
  });

  if (objectType === "company" && slot.type === "county") {
    warnings.push(`JE-geografi är säte: ${category} (inte AE-kategorin Län).`);
  } else if (objectType === "workplace" && slot.type === "county") {
    warnings.push(`AE-geografi är belägenhet: ${category} (inte JE-säte).`);
  }
}

async function applyIndustry(
  query: StructuredQuery,
  client: CompileMetadataSource,
  objectType: ObjectType,
  categoryNames: string[],
  filters: ScbFilters,
  resolved: ResolvedMappings,
  coverage: CoverageEntry[],
  unresolved: UnresolvedConstraint[],
  warnings: string[],
): Promise<void> {
  const slot = query.industry;
  if (!slot) {
    return;
  }

  const requestedLevel = slot.level !== undefined ? clampBranchLevel(slot.level) : undefined;
  const ranked = rankIndustryCategories(categoryNames, slot.level);
  if (ranked.length === 0) {
    const reason = "Ingen bransch/SNI-kategori i SCB-katalogen.";
    unresolved.push({ constraint: "industry", requested: slot, reason });
    coverage.push({
      constraint: "industry",
      requested: slot,
      applied: null,
      relation: "unrepresentable",
      exact: false,
      message: reason,
    });
    return;
  }

  const aliases = expandIndustryAliases(slot.query);
  const matches = await lookupIndustryMatches(client, objectType, slot.query, ranked);
  let codes = uniqueCodes(
    matches.filter(
      (item) =>
        ranked.some((category) => fold(item.category) === fold(category)) ||
        classifyCategoryKind(item.category) === "industry",
    ),
  );
  if (codes.length === 0) {
    codes = uniqueCodes(matches);
  }

  const selected = selectIndustryCodes(codes, slot.level);
  codes = selected.codes;
  const category = pickCategoryForSelectedIndustry(codes, matches, ranked);

  if (codes.length === 0 || !category) {
    unresolved.push({
      constraint: "industry",
      requested: slot,
      reason:
        slot.level !== undefined
          ? `Inga SNI-koder på nivå ${slot.level} för "${slot.query}".`
          : `Ingen branschkod för "${slot.query}" i ${ranked[0]}.`,
    });
    coverage.push({
      constraint: "industry",
      requested: slot,
      applied: { category: category ?? ranked[0], codes: [] },
      relation: "unrepresentable",
      exact: false,
      message: `Kunde inte slå upp bransch "${slot.query}" i ${category ?? ranked[0]}.`,
    });
    return;
  }

  // Dedicated 2-siffrig tables encode level in the name — Branschniva 400s there.
  const branchLevel = categoryNeedsBranchLevel(category) ? selected.branchLevel : undefined;

  const filter: ScbFilters["categories"][number] = {
    category,
    values: codes.map((item) => item.code),
  };
  if (branchLevel !== undefined) {
    filter.branchLevel = branchLevel;
  }
  filters.categories.push(filter);

  const industryResolved: NonNullable<ResolvedMappings["industry"]> = { category, codes };
  if (branchLevel !== undefined) {
    industryResolved.branchLevel = branchLevel;
  }
  resolved.industry = industryResolved;

  const exact =
    codes.length === 1 &&
    aliases.some(
      (alias) => fold(alias) === fold(codes[0]?.label ?? "") || fold(alias) === fold(codes[0]?.code ?? ""),
    );

  coverage.push({
    constraint: "industry",
    requested: slot,
    applied: { category, codes, ...(branchLevel !== undefined ? { branchLevel } : {}) },
    relation: exact ? "exact" : "partial",
    exact,
    message: exact
      ? `"${slot.query}" → ${category} ${codes[0]?.code} (${codes[0]?.label}), Branschniva ${branchLevel ?? "—"}.`
      : `"${slot.query}" matchade ${codes.length} SNI/branschkoder i ${category} på Branschniva ${branchLevel ?? "—"} (${codes.map((item) => item.code).join(", ")}).`,
  });

  if (!exact) {
    warnings.push(
      `Branschfrågan "${slot.query}" är inte ett SCB-kodvärde; den expanderades mot kodtabellen ${category}.`,
    );
  }
  if (requestedLevel !== undefined && requestedLevel !== slot.level) {
    warnings.push(
      `industry.level ${slot.level} klampades till Branschniva ${requestedLevel} (SCB Bransch tillåter 1–3).`,
    );
  }
  if (slot.level === 1 && selected.branchLevel !== 1) {
    warnings.push(
      `industry.level 1 (avdelning/sektion) saknas i metadata; använde ${category} koder ${codes.map((item) => item.code).join(", ")}.`,
    );
  }
}

async function applyEmployees(
  query: StructuredQuery,
  client: CompileMetadataSource,
  objectType: ObjectType,
  categoryNames: string[],
  filters: ScbFilters,
  resolved: ResolvedMappings,
  coverage: CoverageEntry[],
  unresolved: UnresolvedConstraint[],
  warnings: string[],
): Promise<void> {
  const slot = query.employees;
  if (!slot) {
    return;
  }
  if (slot.min === undefined && slot.max === undefined) {
    unresolved.push({
      constraint: "employees",
      requested: slot,
      reason: "employees kräver min och/eller max.",
    });
    return;
  }
  if (slot.min !== undefined && slot.max !== undefined && slot.min > slot.max) {
    unresolved.push({
      constraint: "employees",
      requested: slot,
      reason: "employees.min får inte vara större än employees.max.",
    });
    return;
  }

  const category = pickSizeCategory(categoryNames);
  if (!category || isRevenueCategory(category)) {
    const reason = "Ingen storleksklass för anställda i SCB-katalogen.";
    unresolved.push({ constraint: "employees", requested: slot, reason });
    coverage.push({
      constraint: "employees",
      requested: slot,
      applied: null,
      relation: "unrepresentable",
      exact: false,
      message: reason,
    });
    return;
  }

  let rows: ReturnType<typeof extractCodeRows> = [];
  try {
    rows = extractCodeRows(await client.getCategoryValues(objectType, category));
  } catch (error) {
    if (error instanceof ScbError) {
      unresolved.push({ constraint: "employees", requested: slot, reason: error.message });
      return;
    }
    throw error;
  }

  const bands = parseEmployeeBands(rows);
  const selected = selectOverlappingBands(bands, slot.min, slot.max);
  const requestedMin = slot.min ?? 0;
  const requestedMax = slot.max ?? Number.POSITIVE_INFINITY;

  if (selected.length === 0) {
    const reason = `Ingen storleksklass överlappar ${formatBound(slot.min)}–${formatBound(slot.max)} anställda.`;
    unresolved.push({ constraint: "employees", requested: slot, reason });
    coverage.push({
      constraint: "employees",
      requested: slot,
      applied: { category, bands: [] },
      relation: "unrepresentable",
      exact: false,
      message: reason,
    });
    return;
  }

  const union = unionBandRange(selected);
  const relation = union
    ? rangeRelation(requestedMin, requestedMax, union.min, union.max)
    : "unrepresentable";
  const exact = relation === "exact";

  filters.categories.push({ category, values: selected.map((band) => band.code) });
  resolved.employees = { category, bands: selected };

  const appliedLabel = selected.map((band) => band.label).join(", ");
  const message =
    relation === "exact"
      ? `Anställda ${formatBound(slot.min)}–${formatBound(slot.max)} matchar ${category} (${appliedLabel}).`
      : `Begärt ${formatBound(slot.min)}–${formatBound(slot.max)} anställda; SCB har klass(er) ${appliedLabel} (${formatBound(union?.min)}–${formatBound(union?.max)}). relation=${relation}, exact=false.`;

  coverage.push({
    constraint: "employees",
    requested: slot,
    applied: { category, bands: selected },
    relation,
    exact,
    message,
  });

  if (!exact) {
    warnings.push(message);
  }
}

function applyFields(
  query: StructuredQuery,
  objectType: ObjectType,
  catalogNames: string[],
  resolved: ResolvedMappings,
  coverage: CoverageEntry[],
  unresolved: UnresolvedConstraint[],
  warnings: string[],
): void {
  const requested = query.fields;
  const { fields, missing } = resolveSemanticFields(objectType, requested, catalogNames);
  resolved.fields = fields;
  const usedDefault = !requested || requested.length === 0;
  if (missing.length > 0 && requested && requested.length > 0) {
    unresolved.push({
      constraint: "fields",
      requested: missing,
      reason: `Okända semantiska fält för ${objectType}: ${missing.join(", ")}.`,
    });
  } else if (missing.length > 0) {
    warnings.push(`Standardfält som saknas i katalogen hoppades över: ${missing.join(", ")}.`);
  }
  coverage.push({
    constraint: "fields",
    requested: usedDefault ? { default: true, ids: requested ?? ["name", "organizationNumber", "municipality", "employeeCount"] } : requested,
    applied: fields,
    relation: missing.length === 0 ? "exact" : requested && requested.length > 0 ? "partial" : "partial",
    exact: missing.length === 0,
    message:
      missing.length === 0
        ? `Semantiska fält → SCB-namn för ${objectType}.`
        : `Fält utan katalogträff: ${missing.join(", ")}.`,
  });
}

async function lookupIndustryMatches(
  client: CompileMetadataSource,
  objectType: ObjectType,
  query: string,
  rankedCategories: string[],
): Promise<CodeLookupMatch[]> {
  let result: CodeLookupResult;
  try {
    result = await client.lookupCodes(objectType, query, { kind: "industry", limit: 50 });
  } catch (error) {
    if (error instanceof ScbError && (error.code === "SCB_UNKNOWN_CATEGORY" || error.code === "SCB_INVALID_QUERY")) {
      return [];
    }
    throw error;
  }
  const rankedFold = new Set(rankedCategories.map((name) => fold(name)));
  const inRanked = result.matches.filter((match) => rankedFold.has(fold(match.category)));
  return inRanked.length > 0 ? inRanked : result.matches;
}

async function lookupAliased(
  client: CompileMetadataSource,
  objectType: ObjectType,
  queries: string[],
  category: string,
): Promise<CodeLookupMatch[]> {
  const merged: CodeLookupMatch[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    let result: CodeLookupResult;
    try {
      result = await client.lookupCodes(objectType, q, { category, limit: 25 });
    } catch (error) {
      if (error instanceof ScbError && (error.code === "SCB_UNKNOWN_CATEGORY" || error.code === "SCB_INVALID_QUERY")) {
        continue;
      }
      throw error;
    }
    for (const match of result.matches) {
      const key = `${match.category}:${match.code}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(match);
    }
  }
  return merged;
}

function pickCategoryForSelectedIndustry(
  codes: ResolvedCode[],
  matches: CodeLookupMatch[],
  ranked: string[],
): string | undefined {
  if (ranked.length === 0) {
    return undefined;
  }
  const selected = new Set(codes.map((item) => item.code));
  const catsWithHits = ranked.filter((category) =>
    matches.some((match) => fold(match.category) === fold(category) && selected.has(match.code)),
  );
  const allTwoDigit = codes.length > 0 && codes.every((item) => sniLevel(item.code) === 2);
  if (allTwoDigit) {
    const twoDigit =
      catsWithHits.find((name) => isTwoDigitIndustryCategory(name)) ??
      ranked.find((name) => isTwoDigitIndustryCategory(name));
    if (twoDigit) {
      return twoDigit;
    }
  }
  return catsWithHits[0] ?? ranked[0];
}

function pickBestCodes(matches: CodeLookupMatch[], requested: string): ResolvedCode[] {
  if (matches.length === 0) {
    return [];
  }
  const trimmed = requested.trim();
  const exactCode = matches.filter((item) => item.code === trimmed);
  if (exactCode.length > 0) {
    return uniqueCodes(exactCode);
  }
  const folded = fold(requested);
  const exactLabel = matches.filter((item) => fold(item.label) === folded);
  if (exactLabel.length > 0) {
    return uniqueCodes(exactLabel);
  }
  return uniqueCodes(matches.slice(0, 1));
}

function uniqueCodes(matches: Array<{ code: string; label: string; score?: number | undefined }>): Array<ResolvedCode & { score?: number | undefined }> {
  const seen = new Set<string>();
  const codes: Array<ResolvedCode & { score?: number | undefined }> = [];
  for (const match of matches) {
    if (seen.has(match.code)) {
      continue;
    }
    seen.add(match.code);
    const item: ResolvedCode & { score?: number | undefined } = { code: match.code, label: match.label };
    if (match.score !== undefined) {
      item.score = match.score;
    }
    codes.push(item);
  }
  return codes;
}

export const BRANSCH_API_LEVEL_MIN = 1;
export const BRANSCH_API_LEVEL_MAX = 3;
const MAX_INDUSTRY_CODES = 8;

export function clampBranchLevel(level: number): number {
  return Math.min(BRANSCH_API_LEVEL_MAX, Math.max(BRANSCH_API_LEVEL_MIN, Math.trunc(level)));
}

export { sniLevel };

/** SCB Branschniva on category Bransch is 1–3 (letter→1, 2-digit→2, 3+→3). */
export function branschLevelForCode(code: string): number | undefined {
  const level = sniLevel(code);
  if (level === undefined) {
    return undefined;
  }
  return clampBranchLevel(level);
}

type AnnotatedIndustryCode = ResolvedCode & { sni: number | undefined; api: number | undefined; score: number };

/**
 * Pick ranked discovery hits at one Branschniva. Ranking comes from metadata search —
 * no query→SNI-code special cases.
 */
export function selectIndustryCodes(
  codes: Array<ResolvedCode & { score?: number | undefined }>,
  requestedLevel: number | undefined,
): { codes: ResolvedCode[]; branchLevel: number } {
  const annotated: AnnotatedIndustryCode[] = codes.map((item) => ({
    ...item,
    sni: sniLevel(item.code),
    api: branschLevelForCode(item.code),
    score: item.score ?? 0,
  }));
  annotated.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code, "sv", { numeric: true }));

  if (requestedLevel !== undefined) {
    const apiLevel = clampBranchLevel(requestedLevel);
    let filtered = annotated.filter((item) => item.sni === requestedLevel);
    if (filtered.length === 0 && apiLevel === BRANSCH_API_LEVEL_MAX) {
      filtered = annotated.filter((item) => (item.sni ?? 0) >= BRANSCH_API_LEVEL_MAX);
    }
    if (filtered.length === 0) {
      filtered = annotated.filter((item) => item.api === apiLevel);
    }
    if (filtered.length === 0) {
      const fallback = takeTopRelevant(annotated);
      if (fallback.length > 0) {
        return takeCoarsestLevel(fallback);
      }
      return { codes: [], branchLevel: apiLevel };
    }
    const take = takeTopRelevant(filtered);
    const branchLevel = branschLevelForCode(take[0]?.code ?? "") ?? apiLevel;
    return { codes: stripScores(uniqueCodes(take)), branchLevel };
  }

  const top = takeTopRelevant(annotated);
  if (top.length === 0) {
    return { codes: [], branchLevel: 2 };
  }
  return takeCoarsestLevel(top);
}

function takeTopRelevant(codes: AnnotatedIndustryCode[]): AnnotatedIndustryCode[] {
  if (codes.length === 0) {
    return [];
  }
  const best = codes[0]?.score ?? 0;
  const floor = best > 0 ? best * 0.38 : 0;
  return codes.filter((item) => item.score >= floor).slice(0, MAX_INDUSTRY_CODES);
}

function takeCoarsestLevel(codes: AnnotatedIndustryCode[]): { codes: ResolvedCode[]; branchLevel: number } {
  const levels = codes.map((item) => item.api).filter((level): level is number => level !== undefined);
  const coarsest = levels.length > 0 ? Math.min(...levels) : 2;
  const atLevel = codes.filter((item) => (item.api ?? coarsest) === coarsest);
  return { codes: stripScores(uniqueCodes(atLevel)), branchLevel: clampBranchLevel(coarsest) };
}

function stripScores(codes: Array<ResolvedCode & { score?: number | undefined }>): ResolvedCode[] {
  return codes.map((item) => ({ code: item.code, label: item.label }));
}
