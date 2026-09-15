import { DEFAULT_LOOKUP_LIMIT, fold } from "../../domain/catalog.js";
import { discoverCodes, type CodeLookupMatch } from "../code-lookup.js";
import { ScbError } from "../../domain/errors.js";
import {
  looksLikeSniCode,
  sniLevel,
  sniSectionForDivision,
  structuralSniParent,
} from "../discovery.js";
import type { ScbFilters } from "../schemas.js";
import type { ObjectType } from "../types.js";
import { expandIndustryAliases } from "./aliases.js";
import {
  categoryNeedsBranchLevel,
  isTwoDigitIndustryCategory,
  rankIndustryCategories,
} from "./geography.js";
import type { StructuredQuery } from "./schema.js";
import type {
  CompileMetadataSource,
  CoverageEntry,
  IndustryCandidate,
  ResolvedCode,
  ResolvedMappings,
  UnresolvedConstraint,
} from "./types.js";

export const BRANSCH_API_LEVEL_MIN = 1;
export const BRANSCH_API_LEVEL_MAX = 3;

/** Unique-code window inspects when deciding cluster vs ambiguity. */
export const INDUSTRY_CLUSTER_TOP_K = 8;
/**
 * Second unique-code score must be below this fraction of #1 for a clear gap.
 * Near-ties (bygg 41 vs boat 30) stay unresolved.
 */
export const INDUSTRY_CLUSTER_GAP_RATIO = 0.55;
/** Score-mass share a single SNI family must hold among close hits. */
export const INDUSTRY_CLUSTER_DOMINANT_SHARE = 0.7;
/**
 * Non-exact clusters below this are treated as weak (same order as discovery-eval WEAK_SCORE).
 * Exact code/label still resolve.
 */
export const INDUSTRY_CLUSTER_MIN_SCORE = 80;

export function clampBranchLevel(level: number): number {
  return Math.min(BRANSCH_API_LEVEL_MAX, Math.max(BRANSCH_API_LEVEL_MIN, Math.trunc(level)));
}

/** SCB Branschniva on category Bransch is 1–3 (letter→1, 2-digit→2, 3+→3). */
export function branschLevelForCode(code: string): number | undefined {
  const level = sniLevel(code);
  if (level === undefined) {
    return undefined;
  }
  return clampBranchLevel(level);
}

export type IndustryClusterReason = "exact_code" | "exact_label" | "score_gap" | "dominant_family";

export type IndustryClusterDecision =
  | {
      status: "resolved";
      codes: ResolvedCode[];
      category: string;
      branchLevel?: number;
      exact: boolean;
      reason: IndustryClusterReason;
      candidates: IndustryCandidate[];
    }
  | {
      status: "unresolved";
      reason: string;
      candidates: IndustryCandidate[];
    };

type UniqueHit = CodeLookupMatch & { categories: string[] };

/**
 * Compile industry resolution is a **convenience wrapper** on ranked discovery hits.
 * It does not search metadata and does not map language → SNI codes.
 *
 * Clear (build SCB industry filter):
 * 1. Exact SNI code (query looks like a code and the top hit is that code).
 * 2. Exact label (folded query or alias term equals top label) with a score gap,
 *    or with near-ties that are descendants of the top hit.
 * 3. Clear score gap: unique-code #2 score < GAP_RATIO × #1, and #1 ≥ MIN_SCORE.
 * 4. Dominant family: among unique codes in top-K with score ≥ #1 × GAP_RATIO,
 *    one SNI family (section letter, else 2-digit) holds ≥ DOMINANT_SHARE of
 *    that score mass. Take those codes at one Branschniva (requested level,
 *    else coarsest).
 *
 * Ambiguous / empty: `unresolved` + `candidates` (the ranked discovery hits).
 * Never invent a filter from mixed families (e.g. 41 hus vs 30 fartyg).
 */
export function resolveIndustryCluster(
  matches: CodeLookupMatch[],
  query: string,
  requestedLevel?: number,
): IndustryClusterDecision {
  const candidates = toIndustryCandidates(matches);
  const unique = uniqueByCode(matches);
  if (unique.length === 0) {
    return {
      status: "unresolved",
      reason: `Ingen branschkod för "${query}" i discovery.`,
      candidates,
    };
  }

  const pool = atRequestedLevel(unique, requestedLevel);
  if (pool.length === 0) {
    return {
      status: "unresolved",
      reason:
        requestedLevel !== undefined
          ? `Inga SNI-koder på nivå ${requestedLevel} för "${query}".`
          : `Ingen branschkod för "${query}" i discovery.`,
      candidates,
    };
  }

  const top = pool[0];
  if (!top) {
    return {
      status: "unresolved",
      reason: `Ingen branschkod för "${query}" i discovery.`,
      candidates,
    };
  }
  const topScore = top.score ?? 0;
  const second = pool[1];
  const secondScore = second?.score ?? 0;
  const close = pool.filter((hit) => (hit.score ?? 0) >= topScore * INDUSTRY_CLUSTER_GAP_RATIO);

  if (isExactCodeQuery(query, top)) {
    return resolvedFromHits([top], requestedLevel, true, "exact_code", candidates);
  }

  if (isExactLabelQuery(query, top.label)) {
    const unrelated = close.filter((hit) => !isSniDescendantOrSelf(hit.code, top.code) && !isSniDescendantOrSelf(top.code, hit.code));
    if (unrelated.length === 0) {
      return resolvedFromHits([top], requestedLevel, true, "exact_label", candidates);
    }
  }

  if (topScore >= INDUSTRY_CLUSTER_MIN_SCORE && (second === undefined || secondScore < topScore * INDUSTRY_CLUSTER_GAP_RATIO)) {
    return resolvedFromHits([top], requestedLevel, false, "score_gap", candidates);
  }

  const family = dominantFamily(close);
  if (family && topScore >= INDUSTRY_CLUSTER_MIN_SCORE) {
    const inFamily = close.filter((hit) => sniFamilyKey(hit) === family);
    const taken = takeCoarsestLevel(inFamily, requestedLevel);
    if (taken.length > 0) {
      return resolvedFromHits(taken, requestedLevel, false, "dominant_family", candidates);
    }
  }

  return {
    status: "unresolved",
    reason: `Discovery för "${query}" är tvetydig (ingen tydlig toppträff eller sammanhängande SNI-familj). Välj bland candidates eller scb_lookup_codes.`,
    candidates,
  };
}

export async function applyIndustry(
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

  let matches: CodeLookupMatch[] = [];
  try {
    const result = await discoverCodes(client, objectType, slot.query, {
      kind: "industry",
      limit: DEFAULT_LOOKUP_LIMIT,
    });
    matches = result.matches;
  } catch (error) {
    if (error instanceof ScbError && (error.code === "SCB_UNKNOWN_CATEGORY" || error.code === "SCB_INVALID_QUERY")) {
      matches = [];
    } else {
      throw error;
    }
  }

  const decision = resolveIndustryCluster(matches, slot.query, slot.level);
  if (decision.status === "unresolved") {
    unresolved.push({
      constraint: "industry",
      requested: slot,
      reason: decision.reason,
      candidates: decision.candidates,
    });
    coverage.push({
      constraint: "industry",
      requested: slot,
      applied: { category: ranked[0], codes: [], candidates: decision.candidates },
      relation: "unrepresentable",
      exact: false,
      message: decision.reason,
    });
    return;
  }

  const branchLevel = categoryNeedsBranchLevel(decision.category)
    ? (decision.branchLevel ?? branschLevelForCode(decision.codes[0]?.code ?? "") ?? requestedLevel)
    : undefined;

  const filter: ScbFilters["categories"][number] = {
    category: decision.category,
    values: decision.codes.map((item) => item.code),
  };
  if (branchLevel !== undefined) {
    filter.branchLevel = branchLevel;
  }
  filters.categories.push(filter);

  const industryResolved: NonNullable<ResolvedMappings["industry"]> = {
    category: decision.category,
    codes: decision.codes,
  };
  if (branchLevel !== undefined) {
    industryResolved.branchLevel = branchLevel;
  }
  resolved.industry = industryResolved;

  coverage.push({
    constraint: "industry",
    requested: slot,
    applied: {
      category: decision.category,
      codes: decision.codes,
      ...(branchLevel !== undefined ? { branchLevel } : {}),
    },
    relation: decision.exact ? "exact" : "partial",
    exact: decision.exact,
    message: decision.exact
      ? `"${slot.query}" → ${decision.category} ${decision.codes[0]?.code} (${decision.codes[0]?.label}), Branschniva ${branchLevel ?? "—"}.`
      : `"${slot.query}" matchade ${decision.codes.length} SNI/branschkoder i ${decision.category} på Branschniva ${branchLevel ?? "—"} (${decision.codes.map((item) => item.code).join(", ")}).`,
  });

  if (!decision.exact) {
    warnings.push(
      `Branschfrågan "${slot.query}" är inte ett SCB-kodvärde; filtret kommer från discovery-träffar i ${decision.category} (${decision.reason}).`,
    );
  }
  if (requestedLevel !== undefined && requestedLevel !== slot.level) {
    warnings.push(
      `industry.level ${slot.level} klampades till Branschniva ${requestedLevel} (SCB Bransch tillåter 1–3).`,
    );
  }
  if (slot.level === 1 && branchLevel !== 1) {
    warnings.push(
      `industry.level 1 (avdelning/sektion) saknas i metadata; använde ${decision.category} koder ${decision.codes.map((item) => item.code).join(", ")}.`,
    );
  }
}

export function toIndustryCandidates(matches: CodeLookupMatch[], limit = INDUSTRY_CLUSTER_TOP_K): IndustryCandidate[] {
  return uniqueByCode(matches)
    .slice(0, limit)
    .map((hit) => {
      const item: IndustryCandidate = { category: hit.category, code: hit.code, label: hit.label };
      if (hit.score !== undefined) {
        item.score = hit.score;
      }
      if (hit.level !== undefined) {
        item.level = hit.level;
      }
      if (hit.parentCode !== undefined) {
        item.parentCode = hit.parentCode;
      }
      return item;
    });
}

function resolvedFromHits(
  hits: UniqueHit[],
  requestedLevel: number | undefined,
  exact: boolean,
  reason: IndustryClusterReason,
  candidates: IndustryCandidate[],
): IndustryClusterDecision {
  const codes = hits.map((hit) => ({ code: hit.code, label: hit.label }));
  const category = pickCategoryForHits(hits, requestedLevel);
  const apiLevel = branschLevelForCode(hits[0]?.code ?? "") ?? (requestedLevel !== undefined ? clampBranchLevel(requestedLevel) : 2);
  const decision: IndustryClusterDecision = {
    status: "resolved",
    codes,
    category,
    exact,
    reason,
    candidates,
  };
  if (categoryNeedsBranchLevel(category)) {
    decision.branchLevel = apiLevel;
  }
  return decision;
}

function uniqueByCode(matches: CodeLookupMatch[]): UniqueHit[] {
  const map = new Map<string, UniqueHit>();
  for (const match of matches) {
    const existing = map.get(match.code);
    if (!existing) {
      map.set(match.code, { ...match, categories: [match.category] });
      continue;
    }
    if (!existing.categories.includes(match.category)) {
      existing.categories.push(match.category);
    }
    if ((match.score ?? 0) > (existing.score ?? 0)) {
      existing.score = match.score;
      existing.label = match.label;
      existing.category = match.category;
      existing.level = match.level;
      existing.parentCode = match.parentCode;
      existing.hasChildren = match.hasChildren;
    }
  }
  return [...map.values()].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.code.localeCompare(b.code, "sv", { numeric: true }),
  );
}

function atRequestedLevel(hits: UniqueHit[], requestedLevel: number | undefined): UniqueHit[] {
  if (requestedLevel === undefined) {
    return hits.slice(0, INDUSTRY_CLUSTER_TOP_K);
  }
  const apiLevel = clampBranchLevel(requestedLevel);
  let filtered = hits.filter((item) => sniLevel(item.code) === requestedLevel);
  if (filtered.length === 0 && apiLevel === BRANSCH_API_LEVEL_MAX) {
    filtered = hits.filter((item) => (sniLevel(item.code) ?? 0) >= BRANSCH_API_LEVEL_MAX);
  }
  if (filtered.length === 0) {
    filtered = hits.filter((item) => branschLevelForCode(item.code) === apiLevel);
  }
  return filtered.slice(0, INDUSTRY_CLUSTER_TOP_K);
}

function isExactCodeQuery(query: string, hit: UniqueHit): boolean {
  return looksLikeSniCode(query) && fold(hit.code) === fold(query.trim());
}

function isExactLabelQuery(query: string, label: string): boolean {
  const folded = fold(label);
  if (!folded) {
    return false;
  }
  return expandIndustryAliases(query).some((term) => fold(term) === folded);
}

function sniFamilyKey(hit: UniqueHit): string {
  const code = hit.code.trim();
  if (/^[A-Za-z]$/u.test(code)) {
    return code.toUpperCase();
  }
  if (/^\d{2,5}$/u.test(code)) {
    return sniSectionForDivision(code.slice(0, 2)) ?? code.slice(0, 2);
  }
  return (hit.parentCode ?? code).toUpperCase();
}

function dominantFamily(close: UniqueHit[]): string | undefined {
  if (close.length === 0) {
    return undefined;
  }
  const mass = new Map<string, number>();
  let total = 0;
  for (const hit of close) {
    const key = sniFamilyKey(hit);
    const score = hit.score ?? 0;
    mass.set(key, (mass.get(key) ?? 0) + score);
    total += score;
  }
  if (total <= 0) {
    return undefined;
  }
  let best: string | undefined;
  let bestMass = 0;
  for (const [key, value] of mass) {
    if (value > bestMass) {
      best = key;
      bestMass = value;
    }
  }
  if (!best || bestMass / total < INDUSTRY_CLUSTER_DOMINANT_SHARE) {
    return undefined;
  }
  return best;
}

function takeCoarsestLevel(hits: UniqueHit[], requestedLevel: number | undefined): UniqueHit[] {
  if (hits.length === 0) {
    return [];
  }
  if (requestedLevel !== undefined) {
    return atRequestedLevel(hits, requestedLevel);
  }
  const levels = hits
    .map((item) => branschLevelForCode(item.code))
    .filter((level): level is number => level !== undefined);
  const coarsest = levels.length > 0 ? Math.min(...levels) : 2;
  return hits.filter((item) => (branschLevelForCode(item.code) ?? coarsest) === coarsest);
}

function pickCategoryForHits(hits: UniqueHit[], requestedLevel: number | undefined): string {
  const categories = uniqueKeepOrder(hits.flatMap((hit) => hit.categories));
  const allTwoDigit = hits.length > 0 && hits.every((item) => sniLevel(item.code) === 2);
  const preferLevel = requestedLevel === 2 || allTwoDigit ? 2 : requestedLevel;
  if (allTwoDigit || requestedLevel === 2) {
    const twoDigit = categories.find((name) => isTwoDigitIndustryCategory(name));
    if (twoDigit) {
      return twoDigit;
    }
  }
  const ranked = rankIndustryCategories(categories, preferLevel);
  return ranked[0] ?? hits[0]?.category ?? categories[0] ?? "Bransch";
}

function isSniDescendantOrSelf(code: string, ancestor: string): boolean {
  const want = ancestor.trim().toUpperCase();
  let current: string | undefined = code.trim();
  const seen = new Set<string>();
  while (current && !seen.has(current.toUpperCase())) {
    if (current.toUpperCase() === want) {
      return true;
    }
    seen.add(current.toUpperCase());
    current = structuralSniParent(current);
  }
  return false;
}

function uniqueKeepOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}
