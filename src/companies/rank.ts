import { normalizeCompanyName } from "./normalize.js";

/** Below this, a name is not a reasonable cache hit and live SCB is used. */
export const NAME_MATCH_THRESHOLD = 0.86;

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
  if (query === name) {
    return 1;
  }
  const queryTokens = query.split(" ");
  const nameTokens = name.split(" ").filter((token) => token.length > 0);
  let score = 0;
  if (name.startsWith(`${query} `) || name.startsWith(query)) {
    score = Math.max(score, 0.92 + 0.06 * (query.length / name.length));
  } else if (name.length >= 4 && (query.startsWith(`${name} `) || query.startsWith(name))) {
    score = Math.max(score, 0.9);
  }
  const tokenScores = queryTokens.map((token) => bestTokenScore(token, nameTokens));
  const mean = tokenScores.reduce((sum, value) => sum + value, 0) / tokenScores.length;
  const best = tokenScores.reduce((max, value) => (value > max ? value : max), 0);
  const covered = tokenScores.filter((value) => value >= NAME_MATCH_THRESHOLD).length / tokenScores.length;
  let tokenScore = mean;
  if (covered >= 0.5 && best >= 0.9) {
    tokenScore = Math.max(tokenScore, best * 0.94);
  }
  return Math.max(score, tokenScore, jaroWinkler(query, name), trigramDice(query, name));
}

export function rankCompanies(
  companies: readonly IndexedCompany[],
  query: string,
  limit = CACHE_NAME_LIMIT,
): { results: IndexedCompany[]; matched: number; bestScore: number } {
  const normalized = normalizeCompanyName(query);
  const capped = Math.min(CACHE_NAME_LIMIT, Math.max(1, limit));
  if (normalized.length < 3) {
    return { results: [], matched: 0, bestScore: 0 };
  }
  const hits: Array<{ company: IndexedCompany; score: number; gap: number }> = [];
  let bestScore = 0;
  for (const company of companies) {
    const score = scoreNormalizedName(normalized, company.nameNormalized);
    if (score > bestScore) {
      bestScore = score;
    }
    if (score >= NAME_MATCH_THRESHOLD) {
      hits.push({
        company,
        score,
        gap: Math.abs(company.nameNormalized.length - normalized.length),
      });
    }
  }
  hits.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.gap !== right.gap) {
      return left.gap - right.gap;
    }
    return left.company.name.localeCompare(right.company.name, "sv");
  });
  return {
    results: hits.slice(0, capped).map((hit) => hit.company),
    matched: hits.length,
    bestScore,
  };
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
  }
  return best;
}

function tokenSimilarity(queryToken: string, nameToken: string): number {
  if (queryToken === nameToken) {
    return 1;
  }
  if (queryToken.length >= 4 && nameToken.startsWith(queryToken)) {
    return 0.9 + 0.08 * (queryToken.length / nameToken.length);
  }
  if (nameToken.length >= 4 && queryToken.startsWith(nameToken)) {
    return 0.88 * (nameToken.length / queryToken.length);
  }
  return Math.max(jaroWinkler(queryToken, nameToken), trigramDice(queryToken, nameToken));
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
