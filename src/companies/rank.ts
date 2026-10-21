import { PLACE_TOKENS } from "./places.js";
import { normalizeCompanyName } from "./normalize.js";

/** Confident cache hit. A one-character edit of a rare token clears this. */
export const NAME_MATCH_THRESHOLD = 0.86;

/**
 * Weaker cache hit. Still returned (marked lowConfidence) so a voice call
 * does not wait on live SCB. Below this, the cache has nothing plausible.
 */
export const PLAUSIBLE_THRESHOLD = 0.7;

/** Voice name search returns at most this many cache rows. */
export const CACHE_NAME_LIMIT = 5;

/**
 * Trade words and fillers. IDF would already shrink the frequent ones;
 * these stay tiny even when a test corpus is small.
 */
const GENERIC_WEIGHT = 0.05;

const GENERIC = new Set([
  "ab",
  "aktiebolag",
  "aktiebolaget",
  "bygg",
  "byggen",
  "byggare",
  "entreprenad",
  "entreprenader",
  "el",
  "vvs",
  "mark",
  "i",
  "av",
  "och",
  "for",
  "med",
  "pa",
  "vid",
  "gruppen",
  "group",
  "sverige",
  "holding",
  "service",
  "konsult",
  "fastigheter",
  "anlaggning",
  "montage",
]);

export type CachedCompany = {
  organizationNumber: string;
  name: string;
  nameNormalized: string;
  status: string;
  city?: string;
  sizeClass?: string;
  industry?: string;
};

export type IndexedCompany = CachedCompany & {
  tokens: readonly string[];
};

export type SearchIndex = {
  companies: readonly IndexedCompany[];
  idf: ReadonlyMap<string, number>;
  docCount: number;
};

type ScoredToken = {
  weight: number;
  score: number;
  generic: boolean;
};

export function indexCompany(company: CachedCompany): IndexedCompany {
  return {
    ...company,
    tokens: contentTokens(company.nameNormalized),
  };
}

/** Tokenize once. Warm searches reuse this instead of splitting every name again. */
export function buildSearchIndex(companies: readonly CachedCompany[]): SearchIndex {
  const indexed = companies.map((company) => indexCompany(company));
  const documentFrequency = new Map<string, number>();
  for (const company of indexed) {
    const seen = new Set(company.tokens);
    for (const token of seen) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const docCount = indexed.length;
  const idf = new Map<string, number>();
  for (const [token, count] of documentFrequency) {
    if (isGeneric(token)) {
      continue;
    }
    idf.set(token, Math.log((docCount + 1) / (count + 1)) + 1);
  }
  return { companies: indexed, idf, docCount };
}

export function scoreCompanyName(query: string, nameNormalized: string): number {
  const queryTokens = contentTokens(normalizeCompanyName(query));
  const nameTokens = contentTokens(nameNormalized);
  return combineTokenScores(queryTokens.map((token) => scoreQueryToken(token, nameTokens, genericOrNeutralWeight)));
}

export function rankCompanies(
  source: SearchIndex | readonly CachedCompany[],
  query: string,
  limit = CACHE_NAME_LIMIT,
): { results: IndexedCompany[]; matched: number; bestScore: number; lowConfidence: boolean } {
  const index = isSearchIndex(source) ? source : buildSearchIndex(source);
  const normalized = normalizeCompanyName(query);
  const capped = Math.min(CACHE_NAME_LIMIT, Math.max(1, limit));
  const queryTokens = contentTokens(normalized);
  if (normalized.length < 3 || queryTokens.length === 0) {
    return { results: [], matched: 0, bestScore: 0, lowConfidence: false };
  }
  const hits: Array<{ company: IndexedCompany; score: number }> = [];
  let bestScore = 0;
  for (const company of index.companies) {
    const score = combineTokenScores(
      queryTokens.map((token) => scoreQueryToken(token, company.tokens, (value) => tokenWeight(value, index))),
    );
    if (score > bestScore) {
      bestScore = score;
    }
    if (score >= PLAUSIBLE_THRESHOLD) {
      hits.push({ company, score });
    }
  }
  const lowConfidence = bestScore < NAME_MATCH_THRESHOLD;
  const floor = lowConfidence ? PLAUSIBLE_THRESHOLD : NAME_MATCH_THRESHOLD;
  const selected = hits.filter((hit) => hit.score >= floor);
  selected.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.company.name.localeCompare(right.company.name, "sv");
  });
  return {
    results: selected.slice(0, capped).map((hit) => hit.company),
    matched: selected.length,
    bestScore,
    lowConfidence: lowConfidence && selected.length > 0,
  };
}

function isSearchIndex(value: SearchIndex | readonly CachedCompany[]): value is SearchIndex {
  return !Array.isArray(value);
}

function contentTokens(value: string): string[] {
  return value.split(/[^a-z0-9]+/u).filter((token) => token.length > 1 && !FILLER.has(token));
}

const FILLER = new Set(["i", "av", "och", "for", "med", "pa", "vid", "att", "den", "det"]);

function isGeneric(token: string): boolean {
  return GENERIC.has(token) || PLACE_TOKENS.has(token);
}

function genericOrNeutralWeight(token: string): number {
  return isGeneric(token) ? GENERIC_WEIGHT : 1;
}

function tokenWeight(token: string, index: SearchIndex): number {
  if (isGeneric(token)) {
    return GENERIC_WEIGHT;
  }
  return index.idf.get(token) ?? Math.log(index.docCount + 1) + 1;
}

function scoreQueryToken(
  token: string,
  nameTokens: readonly string[],
  weightOf: (token: string) => number,
): ScoredToken {
  let best = 0;
  for (const nameToken of nameTokens) {
    const score = wholeTokenScore(token, nameToken);
    if (score > best) {
      best = score;
    }
    if (best === 1) {
      break;
    }
  }
  return { weight: weightOf(token), score: best, generic: isGeneric(token) };
}

/**
 * Edit distance against a whole name token. A hit inside a longer word
 * (torens inside rörmontören, treab inside petrebygg) is not a match.
 */
export function wholeTokenScore(query: string, name: string): number {
  if (query === name) {
    return 1;
  }
  if (query.length < 3 || name.length < 3) {
    return 0;
  }
  const distance = levenshtein(query, name, 2);
  if (distance > 2) {
    return 0;
  }
  const longer = Math.max(query.length, name.length);
  if (distance === 1) {
    return longer >= 4 ? 0.94 : 0.8;
  }
  if (longer >= 5 && Math.min(query.length, name.length) >= 4) {
    return 0.78;
  }
  return 0;
}

function combineTokenScores(parts: readonly ScoredToken[]): number {
  if (parts.length === 0) {
    return 0;
  }
  const distinctiveHit = parts.some((part) => !part.generic && part.score >= 0.9);
  const used = distinctiveHit ? parts.filter((part) => part.generic || part.score >= 0.5) : parts;
  let weighted = 0;
  let weightSum = 0;
  for (const part of used) {
    weighted += part.weight * part.score;
    weightSum += part.weight;
  }
  if (weightSum === 0) {
    return 0;
  }
  return weighted / weightSum;
}

function levenshtein(left: string, right: string, cap: number): number {
  if (left === right) {
    return 0;
  }
  if (Math.abs(left.length - right.length) > cap) {
    return cap + 1;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowBest = i;
    const leftChar = left.charAt(i - 1);
    for (let j = 1; j <= right.length; j += 1) {
      const cost = leftChar === right.charAt(j - 1) ? 0 : 1;
      const next = Math.min((current[j - 1] ?? cap) + 1, (previous[j] ?? cap) + 1, (previous[j - 1] ?? cap) + cost);
      current[j] = next;
      if (next < rowBest) {
        rowBest = next;
      }
    }
    if (rowBest > cap) {
      return cap + 1;
    }
    previous = current;
  }
  return previous[right.length] ?? cap + 1;
}
