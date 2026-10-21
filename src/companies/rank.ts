import { normalizeCompanyName } from "./normalize.js";

/** Confident cache hit. One or two character edits per token clear this. */
export const NAME_MATCH_THRESHOLD = 0.86;

/**
 * Weaker cache hit. Still returned (marked lowConfidence) so a voice call
 * does not wait on live SCB. Below this, the cache has nothing plausible.
 */
export const PLAUSIBLE_THRESHOLD = 0.7;

const FILLER = new Set(["i", "av", "och", "for", "med", "pa", "vid", "att", "den", "det"]);

/** Words that describe the trade, not which company it is. */
const GENERIC = new Set([
  "bygg",
  "byggen",
  "byggare",
  "entreprenad",
  "entreprenader",
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

/** Voice name search returns at most this many cache rows. */
export const CACHE_NAME_LIMIT = 5;

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

export function indexCompany(company: CachedCompany): IndexedCompany {
  return {
    ...company,
    tokens: company.nameNormalized.split(" ").filter((token) => token.length > 0),
  };
}

export function scoreCompanyName(query: string, nameNormalized: string): number {
  const normalized = normalizeCompanyName(query);
  return scoreNormalizedName(normalized, nameNormalized);
}

export function scoreNormalizedName(query: string, name: string): number {
  if (query.length < 3 || name.length === 0) {
    return 0;
  }
  const queryTokens = contentTokens(query);
  const nameTokens = contentTokens(name);
  if (queryTokens.length === 0 || nameTokens.length === 0) {
    return 0;
  }
  const compactName = nameTokens.join("");
  const scored = queryTokens.map((token) => ({
    token,
    score: Math.max(bestTokenScore(token, nameTokens), bestSubstringScore(token, compactName)),
  }));
  const aligned = trimUnmatchedTail(scored);
  if (aligned.length === 0) {
    return 0;
  }
  const joinedQuery = aligned.map((item) => item.token).join(" ");
  const joinedName = nameTokens.join(" ");
  if (joinedQuery === joinedName) {
    return 1;
  }
  const score = combineTokenScores(aligned);
  if (score < PLAUSIBLE_THRESHOLD) {
    return score;
  }
  if (joinedName === joinedQuery || joinedName.startsWith(`${joinedQuery} `)) {
    return Math.max(score, 0.94 + 0.04 * (joinedQuery.length / joinedName.length));
  }
  return score;
}

export function rankCompanies(
  companies: readonly IndexedCompany[],
  query: string,
  limit = CACHE_NAME_LIMIT,
): { results: IndexedCompany[]; matched: number; bestScore: number; lowConfidence: boolean } {
  const normalized = normalizeCompanyName(query);
  const capped = Math.min(CACHE_NAME_LIMIT, Math.max(1, limit));
  if (normalized.length < 3) {
    return { results: [], matched: 0, bestScore: 0, lowConfidence: false };
  }
  const hits: Array<{ company: IndexedCompany; score: number; gap: number; matchedTokens: number }> = [];
  let bestScore = 0;
  for (const company of companies) {
    const score = scoreNormalizedName(normalized, company.nameNormalized);
    if (score > bestScore) {
      bestScore = score;
    }
    if (score >= PLAUSIBLE_THRESHOLD) {
      hits.push({
        company,
        score,
        gap: Math.abs(contentTokens(company.nameNormalized).length - contentTokens(normalized).length),
        matchedTokens: matchedTokenCount(normalized, company.nameNormalized),
      });
    }
  }
  const lowConfidence = bestScore < NAME_MATCH_THRESHOLD;
  const floor = lowConfidence ? PLAUSIBLE_THRESHOLD : NAME_MATCH_THRESHOLD;
  const selected = hits.filter((hit) => hit.score >= floor);
  selected.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.matchedTokens !== left.matchedTokens) {
      return right.matchedTokens - left.matchedTokens;
    }
    if (left.gap !== right.gap) {
      return left.gap - right.gap;
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

function contentTokens(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1 && !FILLER.has(token));
}

type ScoredToken = { token: string; score: number };

/**
 * Drop a trailing place or extra word when some earlier word already matches.
 * "Toréns entreprenad östersund" can still match "torens entreprenad".
 */
function trimUnmatchedTail(scored: readonly ScoredToken[]): ScoredToken[] {
  let end = scored.length;
  while (end > 1 && (scored[end - 1]?.score ?? 0) < NAME_MATCH_THRESHOLD) {
    const head = scored.slice(0, end - 1);
    if (!head.some((item) => item.score >= NAME_MATCH_THRESHOLD)) {
      break;
    }
    end -= 1;
  }
  return scored.slice(0, end).filter((item) => item.token.length >= 3);
}

function combineTokenScores(scored: readonly ScoredToken[]): number {
  if (scored.length === 0) {
    return 0;
  }
  const distinctive = scored.filter((item) => !GENERIC.has(item.token));
  const pool = distinctive.length > 0 ? distinctive : scored;
  const weakest = pool.reduce((min, item) => (item.score < min ? item.score : min), 1);
  if (weakest < PLAUSIBLE_THRESHOLD) {
    return weakest;
  }
  const mean = pool.reduce((sum, item) => sum + item.score, 0) / pool.length;
  if (weakest < NAME_MATCH_THRESHOLD) {
    return Math.min(mean, NAME_MATCH_THRESHOLD - 0.01);
  }
  return mean;
}

function matchedTokenCount(query: string, name: string): number {
  const nameTokens = contentTokens(name);
  const compactName = nameTokens.join("");
  return contentTokens(query).filter((token) => {
    const score = Math.max(bestTokenScore(token, nameTokens), bestSubstringScore(token, compactName));
    return score >= NAME_MATCH_THRESHOLD;
  }).length;
}

function bestTokenScore(token: string, nameTokens: readonly string[]): number {
  if (token.length < 3) {
    return 0;
  }
  let best = 0;
  for (const nameToken of nameTokens) {
    const similarity = tokenSimilarity(token, nameToken);
    if (similarity > best) {
      best = similarity;
    }
    if (best === 1) {
      return 1;
    }
  }
  return best;
}

function tokenSimilarity(queryToken: string, nameToken: string): number {
  if (queryToken === nameToken) {
    return 1;
  }
  const distance = levenshtein(queryToken, nameToken, 2);
  const longer = Math.max(queryToken.length, nameToken.length);
  if (distance === 1 && longer >= 4) {
    return 0.95;
  }
  if (distance === 2 && longer >= 5) {
    return 0.9;
  }
  if (queryToken.length >= 3 && nameToken.startsWith(queryToken)) {
    return 0.92 + 0.06 * (queryToken.length / nameToken.length);
  }
  if (nameToken.length >= 4 && queryToken.startsWith(nameToken) && nameToken.length / queryToken.length >= 0.6) {
    return 0.88;
  }
  return Math.max(jaroWinkler(queryToken, nameToken), trigramDice(queryToken, nameToken));
}

/** Match a token inside a name that was stored without spaces. */
function bestSubstringScore(token: string, compactName: string): number {
  if (token.length < 4 || compactName.length < token.length) {
    return 0;
  }
  if (compactName.includes(token)) {
    return 1;
  }
  let best = 0;
  const minLength = Math.max(3, token.length - 1);
  const maxLength = Math.min(compactName.length, token.length + 2);
  for (let length = minLength; length <= maxLength; length += 1) {
    for (let index = 0; index + length <= compactName.length; index += 1) {
      const distance = levenshtein(token, compactName.slice(index, index + length), 2);
      if (distance === 0) {
        return 1;
      }
      if (distance === 1 && token.length >= 4) {
        best = Math.max(best, 0.95);
      }
    }
    if (best >= 0.95) {
      return best;
    }
  }
  return best;
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
      const insert = (current[j - 1] ?? cap) + 1;
      const remove = (previous[j] ?? cap) + 1;
      const replace = (previous[j - 1] ?? cap) + cost;
      const next = Math.min(insert, remove, replace);
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

export function jaroWinkler(left: string, right: string): number {
  const jaro = jaroScore(left, right);
  const prefix = commonPrefix(left, right, 4);
  return jaro + prefix * 0.1 * (1 - jaro);
}

function jaroScore(left: string, right: string): number {
  if (left === right) {
    return 1;
  }
  const leftLength = left.length;
  const rightLength = right.length;
  if (leftLength === 0 || rightLength === 0) {
    return 0;
  }
  const matchDistance = Math.max(0, Math.floor(Math.max(leftLength, rightLength) / 2) - 1);
  const leftMatches = new Array<boolean>(leftLength).fill(false);
  const rightMatches = new Array<boolean>(rightLength).fill(false);
  let matches = 0;
  for (let i = 0; i < leftLength; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, rightLength);
    const leftChar = left.charAt(i);
    for (let j = start; j < end; j += 1) {
      if (rightMatches[j]) {
        continue;
      }
      if (leftChar !== right.charAt(j)) {
        continue;
      }
      leftMatches[i] = true;
      rightMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) {
    return 0;
  }
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < leftLength; i += 1) {
    if (!leftMatches[i]) {
      continue;
    }
    while (!rightMatches[k]) {
      k += 1;
    }
    if (left.charAt(i) !== right.charAt(k)) {
      transpositions += 1;
    }
    k += 1;
  }
  transpositions /= 2;
  return (matches / leftLength + matches / rightLength + (matches - transpositions) / matches) / 3;
}

function commonPrefix(left: string, right: string, max: number): number {
  const limit = Math.min(max, left.length, right.length);
  let index = 0;
  while (index < limit && left.charAt(index) === right.charAt(index)) {
    index += 1;
  }
  return index;
}

export function trigramDice(left: string, right: string): number {
  const leftGrams = trigrams(left);
  const rightGrams = trigrams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) {
      shared += 1;
    }
  }
  return (2 * shared) / (leftGrams.size + rightGrams.size);
}

function trigrams(value: string): Set<string> {
  if (value.length < 3) {
    return new Set(value ? [value] : []);
  }
  const grams = new Set<string>();
  for (let index = 0; index <= value.length - 3; index += 1) {
    grams.add(value.slice(index, index + 3));
  }
  return grams;
}
