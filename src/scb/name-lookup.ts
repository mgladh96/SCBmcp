import { fold } from "../domain/catalog.js";
import { ScbError, queryTooBroad } from "../domain/errors.js";
import { voicePreferredAtLeast, voicePreferredPopulation } from "../mcp/voice-companies.js";
import type { ScbFilters } from "./schemas.js";
import { MAX_RESULTS } from "./types.js";

/**
 * Live JE categories (privateapi Id_Kategori_JE). Size codes match Stkl:
 * 0 = missing, 1 = 0 employees, 2 = 1–4, …, 4 = 10–19, 16 = 10000+.
 * County codes are the current länskoder. 00 is abroad and is omitted.
 */
const STATUS_CATEGORY = "Företagsstatus";
const COUNTY_CATEGORY = "Säteslän";
const SIZE_CATEGORY = "Storleksklass Anställda";
const ACTIVE_STATUS = "1";

const SWEDISH_COUNTY_CODES = [
  "01", "03", "04", "05", "06", "07", "08", "09", "10",
  "12", "13", "14", "17", "18", "19", "20", "21", "22", "23", "24", "25",
];

const SIZE_AT_LEAST_10 = ["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16"];
const SIZE_FIVE_TO_NINE = ["3"];
const SIZE_ONE_TO_FOUR = ["2"];
const SIZE_NONE_OR_MISSING = ["0", "1"];

const COUNT_GRACE_MS = 250;

export type NameLookupIo = {
  count(filters: ScbFilters): Promise<number>;
  fetch(filters: ScbFilters): Promise<unknown[]>;
};

export type NameLookupStrategy = "prefix" | "employed" | "active" | "broad";

export type NameLookupHit = {
  count: number;
  results: unknown[];
  strategy: NameLookupStrategy;
};

/**
 * Name search for the voice tool.
 *
 * Ranking is unchanged: active, then Swedish seat, then larger size, then
 * name score. The top rows are determined without downloading every
 * Innehaller hit:
 * - three or more words: prefix and exact lookups (indexed-style operators)
 * - shorter names: active Swedish companies with employees, largest band first,
 *   plus names that start with the query
 * A contains-match that does not start with the query can only fill a
 * remaining slot when fewer than `limit` stronger rows exist.
 */
export async function lookupCompaniesByName(
  io: NameLookupIo,
  options: { nameVariable: string; name: string; limit: number },
): Promise<NameLookupHit> {
  const name = options.name.trim();
  const limit = Math.max(1, options.limit);
  if (isSpecificName(name)) {
    const prefix = await lookupByPrefix(io, options.nameVariable, name);
    if (prefix) {
      return prefix;
    }
  }
  return lookupByContains(io, options.nameVariable, name, limit);
}

function isSpecificName(name: string): boolean {
  const words = name.split(/\s+/u).filter((part) => /\p{L}/u.test(part));
  return words.length >= 3;
}

async function lookupByPrefix(
  io: NameLookupIo,
  variable: string,
  name: string,
): Promise<NameLookupHit | undefined> {
  const countPromise = settleCount(io.count(containsFilters(variable, name)));
  const fetches = [
    ...exactVariants(name).map((value) =>
      softFetch(io, { categories: [], variables: [{ variable, operator: "ArLikaMed", value }] }),
    ),
    softFetch(io, { categories: [], variables: [{ variable, operator: "BorjarPa", value: name }] }),
  ];
  const batches = await Promise.all(fetches);
  const results = dedupeRows(batches.flat());
  if (results.length === 0) {
    return undefined;
  }
  const counted = await countIfReady(countPromise, COUNT_GRACE_MS);
  if (counted !== undefined && counted > MAX_RESULTS) {
    throw queryTooBroad(counted, MAX_RESULTS, { objectType: "company" });
  }
  return {
    count: counted !== undefined && counted > 0 ? counted : results.length,
    results,
    strategy: "prefix",
  };
}

async function lookupByContains(
  io: NameLookupIo,
  variable: string,
  name: string,
  limit: number,
): Promise<NameLookupHit> {
  const contains = containsFilters(variable, name);
  const countPromise = settleCount(io.count(contains));
  if (name.length < 4) {
    const count = await countPromise;
    if (count === undefined) {
      throw countPromise.error ?? new ScbError("SCB_UNAVAILABLE", "SCB request failed.", true);
    }
    if (count > MAX_RESULTS) {
      throw queryTooBroad(count, MAX_RESULTS, { objectType: "company", appliedFilters: contains });
    }
    if (count === 0) {
      return { count: 0, results: [], strategy: "broad" };
    }
  }

  const prefixBatches = await Promise.all([
    ...exactVariants(name).map((value) =>
      softFetch(io, { categories: [], variables: [{ variable, operator: "ArLikaMed", value }] }),
    ),
    softFetch(io, { categories: [], variables: [{ variable, operator: "BorjarPa", value: name }] }),
    fetchSizeBand(io, variable, name, SIZE_AT_LEAST_10),
  ]);
  let results = dedupeRows(prefixBatches.flat());
  let strategy: NameLookupStrategy = "employed";

  // A smaller band can outrank prefix hits. Only skip it when `limit` companies
  // are already at least as large as every company in that band.
  if (voicePreferredAtLeast(results, 10) < limit) {
    const mid = await fetchSizeBand(io, variable, name, SIZE_FIVE_TO_NINE);
    results = dedupeRows([...results, ...mid]);
  }
  if (voicePreferredAtLeast(results, 5) < limit) {
    const small = await fetchSizeBand(io, variable, name, SIZE_ONE_TO_FOUR);
    results = dedupeRows([...results, ...small]);
  }
  // Names that merely contain the query and have no employees cannot outrank
  // a preferred prefix hit of the same size, so skip that band once `limit`
  // preferred rows are already in hand.
  if (voicePreferredPopulation(results) < limit) {
    const rest = await fetchSizeBand(io, variable, name, SIZE_NONE_OR_MISSING);
    results = dedupeRows([...results, ...rest]);
    strategy = "active";
  }
  if (voicePreferredPopulation(results) < 1) {
    results = dedupeRows([...results, ...(await io.fetch(contains))]);
    strategy = "broad";
  }

  const counted = await countIfReady(countPromise, results.length === 0 ? 15_000 : COUNT_GRACE_MS);
  if (results.length === 0 && countPromise.error) {
    throw countPromise.error;
  }
  if (counted !== undefined && counted > MAX_RESULTS) {
    throw queryTooBroad(counted, MAX_RESULTS, { objectType: "company", appliedFilters: contains });
  }
  if (counted === 0 && results.length === 0) {
    return { count: 0, results: [], strategy };
  }
  const count = counted !== undefined && counted > 0 ? counted : results.length;
  return { count, results, strategy };
}

function containsFilters(variable: string, name: string): ScbFilters {
  return { categories: [], variables: [{ variable, operator: "Innehaller", value: name }] };
}

function exactVariants(name: string): string[] {
  const trimmed = name.trim();
  const compact = fold(trimmed).replace(/[^a-z0-9]/gu, "");
  if (/(?:ab|hb|kb|ekfor|ekonomiskforening)$/u.test(compact)) {
    return [trimmed];
  }
  return [trimmed, `${trimmed} AB`];
}

async function fetchSizeBand(
  io: NameLookupIo,
  variable: string,
  name: string,
  sizeCodes: string[],
): Promise<unknown[]> {
  const variableFilter = { variable, operator: "Innehaller" as const, value: name };
  const attempts: ScbFilters[] = [
    {
      categories: [
        { category: STATUS_CATEGORY, values: [ACTIVE_STATUS] },
        { category: COUNTY_CATEGORY, values: SWEDISH_COUNTY_CODES },
        { category: SIZE_CATEGORY, values: sizeCodes },
      ],
      variables: [variableFilter],
    },
    {
      categories: [
        { category: STATUS_CATEGORY, values: [ACTIVE_STATUS] },
        { category: SIZE_CATEGORY, values: sizeCodes },
      ],
      variables: [variableFilter],
    },
    {
      categories: [
        { category: STATUS_CATEGORY, values: [ACTIVE_STATUS] },
        { category: COUNTY_CATEGORY, values: SWEDISH_COUNTY_CODES },
      ],
      variables: [variableFilter],
    },
    {
      categories: [{ category: STATUS_CATEGORY, values: [ACTIVE_STATUS] }],
      variables: [variableFilter],
    },
  ];
  for (const filters of attempts) {
    try {
      return await io.fetch(filters);
    } catch (error) {
      if (error instanceof ScbError && error.code === "SCB_UNKNOWN_VARIABLE") {
        throw error;
      }
      if (!isSoftScbError(error)) {
        throw error;
      }
    }
  }
  return [];
}

async function softFetch(io: NameLookupIo, filters: ScbFilters): Promise<unknown[]> {
  try {
    return await io.fetch(filters);
  } catch (error) {
    if (isSoftScbError(error)) {
      return [];
    }
    throw error;
  }
}

function isSoftScbError(error: unknown): boolean {
  return (
    error instanceof ScbError &&
    (error.code === "SCB_UNKNOWN_CATEGORY" ||
      error.code === "SCB_UNKNOWN_VARIABLE" ||
      error.code === "SCB_INVALID_QUERY")
  );
}

type SettledCount = Promise<number | undefined> & { error?: unknown };

function settleCount(pending: Promise<number>): SettledCount {
  const settled: SettledCount = pending.then(
    (value) => value,
    (error: unknown) => {
      settled.error = error;
      return undefined;
    },
  ) as SettledCount;
  return settled;
}

async function countIfReady(pending: SettledCount, graceMs: number): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), graceMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function dedupeRows(rows: unknown[]): unknown[] {
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const row of rows) {
    const key = rowKey(row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

function rowKey(row: unknown): string {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return JSON.stringify(row);
  }
  const record = row as Record<string, unknown>;
  let org = "";
  let name = "";
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" && typeof value !== "number") {
      continue;
    }
    const folded = fold(key);
    const text = String(value).replace(/\s+/gu, "");
    if (!org && (folded.startsWith("orgnr") || folded.startsWith("peorgnr"))) {
      org = text;
    }
    if (!name && (folded === "foretagsnamn" || folded === "namn" || folded === "firma")) {
      name = fold(String(value));
    }
  }
  if (org) {
    return `org:${org}`;
  }
  if (name) {
    return `name:${name}`;
  }
  return JSON.stringify(record);
}
