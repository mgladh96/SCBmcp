import {
  classifyCategoryKind,
  extractCodeRows,
  fold,
  tokenize,
  type CategoryKind,
} from "../domain/catalog.js";
import { expandSearchTerms } from "./compile/aliases.js";
import type { ObjectType } from "./types.js";

const BM25_K1 = 1.4;
const BM25_B = 0.6;
const PREFIX_TF = 0.55;
const MIN_HIT_SCORE = 12;
const FIRST_TOKEN_PREFIX_BONUS = 130;
const EXACT_CODE_SCORE = 1000;
const EXACT_LABEL_SCORE = 850;
const COMPACT_PREFIX_SCORE = 90;
const COMPACT_CONTAINS_SCORE = 48;
const MIN_PREFIX_LEN = 3;

const STOPWORDS = new Set([
  "av",
  "och",
  "i",
  "for",
  "med",
  "den",
  "det",
  "de",
  "en",
  "ett",
  "som",
  "pa",
  "till",
  "lan",
  "kommun",
  "region",
  "anstallda",
  "anstalld",
  "inom",
  "utom",
  "avseende",
  "andra",
  "annan",
  "samt",
]);

/**
 * SNI 2007 section letter from a 2-digit division. Structural hierarchy only —
 * not a language→code mapping.
 */
const SNI_SECTIONS: Array<{ section: string; from: number; to: number }> = [
  { section: "A", from: 1, to: 3 },
  { section: "B", from: 5, to: 9 },
  { section: "C", from: 10, to: 33 },
  { section: "D", from: 35, to: 35 },
  { section: "E", from: 36, to: 39 },
  { section: "F", from: 41, to: 43 },
  { section: "G", from: 45, to: 47 },
  { section: "H", from: 49, to: 53 },
  { section: "I", from: 55, to: 56 },
  { section: "J", from: 58, to: 63 },
  { section: "K", from: 64, to: 66 },
  { section: "L", from: 68, to: 68 },
  { section: "M", from: 69, to: 75 },
  { section: "N", from: 77, to: 82 },
  { section: "O", from: 84, to: 84 },
  { section: "P", from: 85, to: 85 },
  { section: "Q", from: 86, to: 88 },
  { section: "R", from: 90, to: 93 },
  { section: "S", from: 94, to: 96 },
  { section: "T", from: 97, to: 98 },
  { section: "U", from: 99, to: 99 },
];

export type DiscoveryDoc = {
  objectType: ObjectType;
  category: string;
  kind: CategoryKind;
  code: string;
  label: string;
  level: number | undefined;
  parentCode: string | undefined;
  hasChildren: boolean;
  tokens: string[];
  compactLabel: string;
  compactCode: string;
};

export type DiscoveryIndex = {
  objectType: ObjectType;
  docs: DiscoveryDoc[];
  avgDocLen: number;
  df: Map<string, number>;
  codes: Set<string>;
};

export type DiscoveryHit = {
  objectType: ObjectType;
  kind: CategoryKind;
  category: string;
  code: string;
  label: string;
  level?: number | undefined;
  parentCode?: string | undefined;
  hasChildren?: boolean | undefined;
  score: number;
};

export type DiscoverySearchOptions = {
  query: string;
  kind?: CategoryKind | undefined;
  category?: string | undefined;
  parentCode?: string | undefined;
  limit?: number | undefined;
};

export function looksLikeSniCode(value: string): boolean {
  const trimmed = value.trim();
  return /^[A-Za-z]$/u.test(trimmed) || /^\d{2,5}$/u.test(trimmed);
}

export function sniLevel(code: string): number | undefined {
  const trimmed = code.trim();
  if (/^[A-Za-z]$/u.test(trimmed)) {
    return 1;
  }
  if (/^\d{2}$/u.test(trimmed)) {
    return 2;
  }
  if (/^\d{3}$/u.test(trimmed)) {
    return 3;
  }
  if (/^\d{4}$/u.test(trimmed)) {
    return 4;
  }
  if (/^\d{5}$/u.test(trimmed)) {
    return 5;
  }
  return undefined;
}

export function sniSectionForDivision(twoDigit: string): string | undefined {
  const n = Number.parseInt(twoDigit, 10);
  if (!Number.isFinite(n)) {
    return undefined;
  }
  return SNI_SECTIONS.find((row) => n >= row.from && n <= row.to)?.section;
}

export function structuralSniParent(code: string): string | undefined {
  const trimmed = code.trim();
  if (/^[A-Za-z]$/u.test(trimmed)) {
    return undefined;
  }
  if (/^\d{2}$/u.test(trimmed)) {
    return sniSectionForDivision(trimmed);
  }
  if (/^\d{3,5}$/u.test(trimmed)) {
    return trimmed.slice(0, -1);
  }
  return undefined;
}

export function resolveSniParent(code: string, knownCodes?: Set<string>): string | undefined {
  let parent = structuralSniParent(code);
  if (!knownCodes || knownCodes.size === 0) {
    return parent;
  }
  while (parent) {
    if (knownCodes.has(parent) || knownCodes.has(parent.toUpperCase()) || knownCodes.has(parent.toLowerCase())) {
      return parent;
    }
    const next = structuralSniParent(parent);
    if (!next) {
      return parent;
    }
    parent = next;
  }
  return undefined;
}

export function contentTokens(value: string): string[] {
  return tokenize(value).filter((token) => !STOPWORDS.has(token));
}

export function buildDiscoveryIndex(
  objectType: ObjectType,
  tables: Array<{ category: string; raw: unknown }>,
): DiscoveryIndex {
  const docs: DiscoveryDoc[] = [];
  const industryCodes = new Set<string>();
  for (const table of tables) {
    const kind = classifyCategoryKind(table.category);
    for (const row of extractCodeRows(table.raw)) {
      if (kind === "industry") {
        industryCodes.add(row.code);
        industryCodes.add(row.code.toUpperCase());
      }
      docs.push({
        objectType,
        category: table.category,
        kind,
        code: row.code,
        label: row.label,
        level: kind === "industry" ? sniLevel(row.code) : undefined,
        parentCode: undefined,
        hasChildren: false,
        tokens: contentTokens(`${row.label} ${row.code}`),
        compactLabel: fold(row.label),
        compactCode: fold(row.code),
      });
    }
  }

  for (const doc of docs) {
    if (doc.kind !== "industry") {
      continue;
    }
    doc.parentCode = resolveSniParent(doc.code, industryCodes);
  }

  const children = new Set<string>();
  for (const doc of docs) {
    if (doc.kind === "industry" && doc.parentCode) {
      children.add(doc.parentCode);
      children.add(doc.parentCode.toUpperCase());
    }
  }
  for (const doc of docs) {
    if (doc.kind !== "industry") {
      continue;
    }
    doc.hasChildren = children.has(doc.code) || children.has(doc.code.toUpperCase());
  }

  const df = new Map<string, number>();
  let tokenCount = 0;
  for (const doc of docs) {
    tokenCount += doc.tokens.length;
    const unique = new Set(doc.tokens);
    for (const token of unique) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  return {
    objectType,
    docs,
    avgDocLen: docs.length === 0 ? 0 : tokenCount / docs.length,
    df,
    codes: industryCodes,
  };
}

export function searchDiscoveryIndex(index: DiscoveryIndex, options: DiscoverySearchOptions): DiscoveryHit[] {
  const kind = options.kind;
  const categoryFold = options.category ? fold(options.category) : undefined;
  const parent = options.parentCode?.trim();
  const query = options.query.trim();

  let pool = index.docs;
  if (kind) {
    pool = pool.filter((doc) => doc.kind === kind);
  }
  if (categoryFold) {
    pool = pool.filter((doc) => fold(doc.category) === categoryFold);
  }

  if (parent) {
    const wanted = parent.toUpperCase();
    const children = pool.filter((doc) => (doc.parentCode ?? "").toUpperCase() === wanted);
    const rankedChildren =
      children.length > 0
        ? children
        : pool.filter((doc) => doc.kind === "industry" && isSniDescendant(doc.code, parent));
    return (query ? rankDocs(index, rankedChildren, query) : rankedChildren.map((doc) => toHit(doc, 0))).sort(
      (a, b) => b.score - a.score || compareHits(a, b),
    );
  }

  if (!query) {
    return pool.map((doc) => toHit(doc, 0)).sort((a, b) => compareHits(a, b));
  }

  return rankDocs(index, pool, query);
}

function rankDocs(index: DiscoveryIndex, docs: DiscoveryDoc[], query: string): DiscoveryHit[] {
  const terms = expandSearchTerms(query);
  const queryTokens = unique(terms.flatMap((term) => contentTokens(term)));
  const compactTerms = unique(terms.map((term) => fold(term)).filter(Boolean));
  const compactQuery = fold(query);
  const scored = docs
    .map((doc) => ({
      hit: toHit(doc, scoreDoc(index, doc, query, compactQuery, compactTerms, queryTokens)),
    }))
    .filter((item) => item.hit.score >= MIN_HIT_SCORE)
    .sort((a, b) => b.hit.score - a.hit.score || compareHits(a.hit, b.hit));
  return scored.map((item) => item.hit);
}

function scoreDoc(
  index: DiscoveryIndex,
  doc: DiscoveryDoc,
  rawQuery: string,
  compactQuery: string,
  compactTerms: string[],
  queryTokens: string[],
): number {
  let score = 0;
  if (compactQuery && doc.compactCode === compactQuery) {
    score += EXACT_CODE_SCORE;
  }
  for (const term of compactTerms) {
    if (term && doc.compactLabel === term) {
      score += EXACT_LABEL_SCORE;
      break;
    }
  }
  if (compactQuery) {
    if (doc.compactLabel.startsWith(compactQuery) || doc.compactCode.startsWith(compactQuery)) {
      const denom = Math.max(doc.compactLabel.length, doc.compactCode.length, 1);
      score += COMPACT_PREFIX_SCORE * (compactQuery.length / denom);
    } else if (doc.compactLabel.includes(compactQuery) || doc.compactCode.includes(compactQuery)) {
      const denom = Math.max(doc.compactLabel.length, 1);
      score += COMPACT_CONTAINS_SCORE * (compactQuery.length / denom);
    }
  }

  score += bm25(index, doc, queryTokens);

  const first = doc.tokens[0];
  if (
    first &&
    queryTokens.some((token) => token.length >= MIN_PREFIX_LEN && first.startsWith(token) && token !== first)
  ) {
    score += FIRST_TOKEN_PREFIX_BONUS;
  } else if (first && queryTokens.includes(first)) {
    score += FIRST_TOKEN_PREFIX_BONUS * 0.85;
  }

  if (doc.kind === "industry" && !looksLikeSniCode(rawQuery) && doc.level !== undefined) {
    if (doc.level === 1) {
      score *= 1.12;
    } else if (doc.level === 2) {
      score *= 1.06;
    }
  }

  return score;
}

function bm25(index: DiscoveryIndex, doc: DiscoveryDoc, queryTokens: string[]): number {
  if (queryTokens.length === 0 || index.docs.length === 0) {
    return 0;
  }
  const n = index.docs.length;
  const avg = index.avgDocLen || 1;
  const tfMap = new Map<string, number>();
  for (const token of doc.tokens) {
    tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
  }
  let total = 0;
  for (const q of queryTokens) {
    let tf = tfMap.get(q) ?? 0;
    if (tf === 0 && q.length >= MIN_PREFIX_LEN) {
      for (const [token, count] of tfMap) {
        if (token.startsWith(q) && token !== q) {
          tf += count * PREFIX_TF;
        }
      }
    }
    if (tf <= 0) {
      continue;
    }
    const df = documentFrequency(index, q);
    const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
    const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.tokens.length) / avg);
    total += idf * ((tf * (BM25_K1 + 1)) / denom);
  }
  return total * 40;
}

function documentFrequency(index: DiscoveryIndex, token: string): number {
  const exact = index.df.get(token);
  if (exact !== undefined) {
    return exact;
  }
  if (token.length < MIN_PREFIX_LEN) {
    return 0;
  }
  let df = 0;
  for (const [docToken, count] of index.df) {
    if (docToken.startsWith(token)) {
      df += count;
    }
  }
  return df;
}

function isSniDescendant(code: string, parent: string): boolean {
  const p = parent.trim().toUpperCase();
  const c = code.trim().toUpperCase();
  if (!p || p === c) {
    return false;
  }
  if (/^[A-Z]$/u.test(p)) {
    const section = /^\d{2,5}$/u.test(c)
      ? sniSectionForDivision(c.slice(0, 2))
      : undefined;
    return section === p;
  }
  return /^\d+$/u.test(p) && /^\d+$/u.test(c) && c.startsWith(p) && c.length > p.length;
}

function toHit(doc: DiscoveryDoc, score: number): DiscoveryHit {
  const hit: DiscoveryHit = {
    objectType: doc.objectType,
    kind: doc.kind,
    category: doc.category,
    code: doc.code,
    label: doc.label,
    score: roundScore(score),
  };
  if (doc.level !== undefined) {
    hit.level = doc.level;
  }
  if (doc.parentCode !== undefined) {
    hit.parentCode = doc.parentCode;
  }
  if (doc.kind === "industry") {
    hit.hasChildren = doc.hasChildren;
  }
  return hit;
}

function compareHits(a: DiscoveryHit, b: DiscoveryHit): number {
  return a.category.localeCompare(b.category, "sv") || a.code.localeCompare(b.code, "sv", { numeric: true });
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

function unique(values: string[]): string[] {
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
