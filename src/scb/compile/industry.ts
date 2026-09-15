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
import { QUERY_CHOOSE_CANDIDATE_LIMIT } from "./outcome.js";
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
/**
 * SNI level at/above which a lone cluster hit is too narrow to auto-ok when a
 * broader structural parent exists in discovery candidates or the catalog.
 */
export const INDUSTRY_NARROW_LEVEL_MIN = 4;

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
 *
 * Fine-grained (SNI level ≥ 4 / 5-digit) score-gap or dominant-family hits are
 * not auto-ok when a broader structural parent exists in candidates or catalog —
 * return unresolved so the agent can choose (narrow vs 3-/2-digit parent).
 * Exact code/label still resolve. No language→code mapping.
 */
export function resolveIndustryCluster(
  matches: CodeLookupMatch[],
  query: string,
  requestedLevel?: number,
  catalogHits: CodeLookupMatch[] = [],
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

  let decision: IndustryClusterDecision | undefined;
  if (isExactCodeQuery(query, top)) {
    decision = resolvedFromHits([top], requestedLevel, true, "exact_code", candidates);
  }

  if (!decision && isExactLabelQuery(query, top.label)) {
    const unrelated = close.filter((hit) => !isSniDescendantOrSelf(hit.code, top.code) && !isSniDescendantOrSelf(top.code, hit.code));
    if (unrelated.length === 0) {
      decision = resolvedFromHits([top], requestedLevel, true, "exact_label", candidates);
    }
  }

  if (
    !decision &&
    topScore >= INDUSTRY_CLUSTER_MIN_SCORE &&
    (second === undefined || secondScore < topScore * INDUSTRY_CLUSTER_GAP_RATIO)
  ) {
    decision = resolvedFromHits([top], requestedLevel, false, "score_gap", candidates);
  }

  if (!decision) {
    const family = dominantFamily(close);
    if (family && topScore >= INDUSTRY_CLUSTER_MIN_SCORE) {
      const inFamily = close.filter((hit) => sniFamilyKey(hit) === family);
      const taken = takeCoarsestLevel(inFamily, requestedLevel);
      if (taken.length > 0) {
        decision = resolvedFromHits(taken, requestedLevel, false, "dominant_family", candidates);
      }
    }
  }

  if (!decision) {
    decision = {
      status: "unresolved",
      reason: `Discovery för "${query}" är tvetydig (ingen tydlig toppträff eller sammanhängande SNI-familj). Välj bland candidates eller scb_lookup_codes.`,
      candidates,
    };
  }

  return maybeChooseInsteadOfNarrowOk(decision, query, requestedLevel, unique, catalogHits);
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

  if (slot.codes && slot.codes.length > 0) {
    if (slot.query) {
      warnings.push(`industry.query "${slot.query}" ignoreras när codes är satt.`);
    }
    await applyIndustryCodes(
      slot,
      client,
      objectType,
      ranked,
      requestedLevel,
      filters,
      resolved,
      coverage,
      unresolved,
      warnings,
    );
    return;
  }

  const queryText = slot.query ?? "";
  let matches: CodeLookupMatch[] = [];
  try {
    const result = await discoverCodes(client, objectType, queryText, {
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

  const catalogHits = catalogAncestorHits(client, objectType, ranked, matches);
  const decision = resolveIndustryCluster(matches, queryText, slot.level, catalogHits);
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
      ? `"${queryText}" → ${decision.category} ${decision.codes[0]?.code} (${decision.codes[0]?.label}), Branschniva ${branchLevel ?? "—"}.`
      : `"${queryText}" matchade ${decision.codes.length} SNI/branschkoder i ${decision.category} på Branschniva ${branchLevel ?? "—"} (${decision.codes.map((item) => item.code).join(", ")}).`,
  });

  if (!decision.exact) {
    warnings.push(
      `Branschfrågan "${queryText}" är inte ett SCB-kodvärde; filtret kommer från discovery-träffar i ${decision.category} (${decision.reason}).`,
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

async function applyIndustryCodes(
  slot: NonNullable<StructuredQuery["industry"]>,
  client: CompileMetadataSource,
  objectType: ObjectType,
  ranked: string[],
  requestedLevel: number | undefined,
  filters: ScbFilters,
  resolved: ResolvedMappings,
  coverage: CoverageEntry[],
  unresolved: UnresolvedConstraint[],
  warnings: string[],
): Promise<void> {
  const requestedCodes = uniqueKeepOrder((slot.codes ?? []).map((code) => code.trim()).filter((code) => code.length > 0));
  if (requestedCodes.length === 0) {
    const reason = "industry.codes är tom.";
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

  if (slot.category) {
    const folded = fold(slot.category);
    if (!ranked.some((name) => fold(name) === folded)) {
      const reason = `industry.category "${slot.category}" finns inte bland SCB-branschkategorier.`;
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
  }

  const matches: CodeLookupMatch[] = [];
  const missing: string[] = [];
  for (const code of requestedCodes) {
    let found: CodeLookupMatch[] = [];
    try {
      const result = await discoverCodes(client, objectType, code, {
        kind: "industry",
        ...(slot.category ? { category: slot.category } : {}),
        limit: DEFAULT_LOOKUP_LIMIT,
      });
      found = result.matches.filter((item) => fold(item.code) === fold(code));
    } catch (error) {
      if (error instanceof ScbError && (error.code === "SCB_UNKNOWN_CATEGORY" || error.code === "SCB_INVALID_QUERY")) {
        found = [];
      } else {
        throw error;
      }
    }
    if (found.length === 0) {
      missing.push(code);
      continue;
    }
    matches.push(...found);
  }

  if (missing.length > 0) {
    const reason = `Koden${missing.length === 1 ? "" : "rna"} ${missing.map((code) => `"${code}"`).join(", ")} finns inte i SCB:s branschkatalog.`;
    const candidates = toIndustryCandidates(matches);
    unresolved.push({
      constraint: "industry",
      requested: slot,
      reason,
      ...(candidates.length > 0 ? { candidates } : {}),
    });
    coverage.push({
      constraint: "industry",
      requested: slot,
      applied: { codes: requestedCodes, missing },
      relation: "unrepresentable",
      exact: false,
      message: reason,
    });
    return;
  }

  const unique = uniqueByCode(matches);
  const preferLevel =
    requestedLevel ??
    (unique.length > 0 && unique.every((item) => sniLevel(item.code) === 2) ? 2 : requestedLevel);
  const category =
    (slot.category && unique.some((hit) => hit.categories.some((name) => fold(name) === fold(slot.category ?? "")))
      ? unique.flatMap((hit) => hit.categories).find((name) => fold(name) === fold(slot.category ?? ""))
      : undefined) ?? pickCategoryForHits(unique, preferLevel);

  const derivedLevel = branschLevelForCode(unique[0]?.code ?? "") ?? (requestedLevel !== undefined ? clampBranchLevel(requestedLevel) : 2);
  const branchLevel = categoryNeedsBranchLevel(category)
    ? (slot.branchLevel !== undefined ? clampBranchLevel(slot.branchLevel) : derivedLevel)
    : undefined;

  const codes = unique.map((hit) => ({ code: hit.code, label: hit.label }));
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

  coverage.push({
    constraint: "industry",
    requested: slot,
    applied: {
      category,
      codes,
      ...(branchLevel !== undefined ? { branchLevel } : {}),
    },
    relation: "exact",
    exact: true,
    message: `industry.codes → ${category} ${codes.map((item) => item.code).join(", ")} (OR i samma kategori), Branschniva ${branchLevel ?? "—"}.`,
  });

  if (slot.branchLevel !== undefined && branchLevel !== undefined && clampBranchLevel(slot.branchLevel) !== branchLevel) {
    warnings.push(`industry.branchLevel ${slot.branchLevel} klampades till Branschniva ${branchLevel}.`);
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

function isFineGrainedCode(code: string): boolean {
  const level = sniLevel(code);
  return level !== undefined && level >= INDUSTRY_NARROW_LEVEL_MIN;
}

function maybeChooseInsteadOfNarrowOk(
  decision: IndustryClusterDecision,
  query: string,
  requestedLevel: number | undefined,
  unique: UniqueHit[],
  catalogHits: CodeLookupMatch[],
): IndustryClusterDecision {
  if (decision.status !== "resolved") {
    return decision;
  }
  if (decision.reason === "exact_code" || decision.reason === "exact_label") {
    return decision;
  }
  if (requestedLevel !== undefined && requestedLevel >= INDUSTRY_NARROW_LEVEL_MIN) {
    return decision;
  }
  if (decision.codes.length === 0 || !decision.codes.every((item) => isFineGrainedCode(item.code))) {
    return decision;
  }

  const pool = uniqueByCode([...unique, ...catalogHits]);
  const narrowCodes = decision.codes.map((item) => item.code);
  const broader = collectStructuralParents(narrowCodes, pool);
  if (broader.length === 0) {
    return decision;
  }

  const narrowHits = narrowCodes.map((code) => hitForCode(code, pool, decision)).filter((hit): hit is UniqueHit => hit !== undefined);
  const siblings = collectFamilySiblings(narrowCodes, pool, new Set([...narrowCodes, ...broader.map((hit) => hit.code)]));
  const packaged = packageNarrowChooseCandidates(narrowHits, broader, siblings);
  const shown = packaged.map((item) => item.code).join(", ");
  return {
    status: "unresolved",
    reason: `Discovery för "${query}" träffade en smal SNI-kod; en bredare förälder finns (${shown}). Välj bland candidates och anropa scb_query med industry.codes.`,
    candidates: packaged,
  };
}

function hitForCode(
  code: string,
  pool: UniqueHit[],
  decision: Extract<IndustryClusterDecision, { status: "resolved" }>,
): UniqueHit | undefined {
  const found = pool.find((hit) => fold(hit.code) === fold(code));
  if (found) {
    return found;
  }
  const fromDecision = decision.codes.find((item) => fold(item.code) === fold(code));
  if (!fromDecision) {
    return undefined;
  }
  return {
    objectType: pool[0]?.objectType ?? "company",
    category: decision.category,
    code: fromDecision.code,
    label: fromDecision.label,
    level: sniLevel(fromDecision.code),
    parentCode: structuralSniParent(fromDecision.code),
    categories: [decision.category],
  };
}

/** Ancestors from immediate parent down to 2-digit division — not section letters. */
function collectStructuralParents(narrowCodes: string[], pool: UniqueHit[]): UniqueHit[] {
  const out: UniqueHit[] = [];
  const seen = new Set(narrowCodes.map((code) => fold(code)));
  for (const code of narrowCodes) {
    let parent = structuralSniParent(code);
    while (parent) {
      const level = sniLevel(parent);
      if (level === undefined || level < 2) {
        break;
      }
      const key = fold(parent);
      if (!seen.has(key)) {
        const hit = pool.find((item) => fold(item.code) === key);
        if (hit) {
          out.push(hit);
          seen.add(key);
        }
      }
      if (level <= 2) {
        break;
      }
      parent = structuralSniParent(parent);
    }
  }
  return out;
}

function collectFamilySiblings(narrowCodes: string[], pool: UniqueHit[], skip: Set<string>): UniqueHit[] {
  const prefixes = new Set(narrowCodes.map((code) => code.trim().slice(0, 3)).filter((prefix) => prefix.length >= 3));
  const skipFolded = new Set([...skip].map((code) => fold(code)));
  return pool.filter((hit) => {
    if (skipFolded.has(fold(hit.code))) {
      return false;
    }
    return prefixes.has(hit.code.trim().slice(0, 3));
  });
}

function packageNarrowChooseCandidates(
  narrowHits: UniqueHit[],
  broaderHits: UniqueHit[],
  siblingHits: UniqueHit[],
): IndustryCandidate[] {
  const ordered: Array<{ hit: UniqueHit; why: string }> = [];
  const seen = new Set<string>();
  const push = (hit: UniqueHit, why: string) => {
    const key = fold(hit.code);
    if (!key || seen.has(key) || ordered.length >= QUERY_CHOOSE_CANDIDATE_LIMIT) {
      return;
    }
    seen.add(key);
    ordered.push({ hit, why });
  };

  for (const hit of narrowHits) {
    const digits = sniLevel(hit.code) ?? hit.code.trim().length;
    push(hit, `smal ${digits}-siffrig träff — kan missa närliggande SNI`);
  }
  for (const hit of broaderHits) {
    push(hit, `bredare förälder ${hit.code} i samma SNI-familj`);
  }
  for (const hit of siblingHits) {
    push(hit, `närliggande SNI i samma familj`);
  }

  return ordered.map(({ hit, why }) => candidateFromHit(hit, why));
}

function candidateFromHit(hit: UniqueHit, why: string): IndustryCandidate {
  const item: IndustryCandidate = { category: hit.category, code: hit.code, label: hit.label, why };
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
}

function catalogAncestorHits(
  client: CompileMetadataSource,
  objectType: ObjectType,
  categoryNames: string[],
  matches: CodeLookupMatch[],
): CodeLookupMatch[] {
  const unique = uniqueByCode(matches);
  const have = new Set(unique.map((hit) => fold(hit.code)));
  const needed = new Set<string>();
  for (const hit of unique.slice(0, INDUSTRY_CLUSTER_TOP_K)) {
    if (!isFineGrainedCode(hit.code)) {
      continue;
    }
    let parent = structuralSniParent(hit.code);
    while (parent) {
      const level = sniLevel(parent);
      if (level === undefined || level < 2) {
        break;
      }
      const key = fold(parent);
      if (!have.has(key)) {
        needed.add(key);
      }
      if (level <= 2) {
        break;
      }
      parent = structuralSniParent(parent);
    }
  }
  if (needed.size === 0) {
    return [];
  }

  const found: CodeLookupMatch[] = [];
  const foundCodes = new Set<string>();
  for (const category of rankIndustryCategories(categoryNames, undefined)) {
    const rows = client.offlineCodeRows?.(objectType, category);
    if (!rows) {
      continue;
    }
    for (const row of rows) {
      const key = fold(row.code);
      if (!needed.has(key) || foundCodes.has(key) || have.has(key)) {
        continue;
      }
      foundCodes.add(key);
      found.push({
        objectType,
        category,
        code: row.code,
        label: row.label,
        kind: "industry",
        level: sniLevel(row.code),
        parentCode: structuralSniParent(row.code),
      });
    }
  }
  return found;
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
