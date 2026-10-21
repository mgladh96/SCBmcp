import { normalizeCompanyName } from "./normalize.js";
import {
  buildSearchIndex,
  CACHE_NAME_LIMIT,
  NAME_MATCH_THRESHOLD,
  PLAUSIBLE_THRESHOLD,
  rankCompanies,
  type CachedCompany,
  type IndexedCompany,
  type SearchIndex,
} from "./rank.js";

export { CACHE_NAME_LIMIT, NAME_MATCH_THRESHOLD, PLAUSIBLE_THRESHOLD };
export type { CachedCompany };

/** In-memory company snapshot lifetime. */
export const COMPANY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const SIZE_CLASS_LABELS: Record<string, string> = {
  "0": "uppgift saknas",
  "1": "0 anställda",
  "2": "1-4 anställda",
  "3": "5-9 anställda",
  "4": "10-19 anställda",
  "5": "20-49 anställda",
  "6": "50-99 anställda",
  "7": "100-199 anställda",
  "8": "200-499 anställda",
  "9": "500-999 anställda",
  "10": "1000-1499 anställda",
  "11": "1500-1999 anställda",
  "12": "2000-2999 anställda",
  "13": "3000-3999 anställda",
  "14": "4000-4999 anställda",
  "15": "5000-9999 anställda",
  "16": "10000- anställda",
};

export class CompanyCacheError extends Error {
  readonly reason: "missing_credentials" | "load_failed";

  constructor(message: string, reason: "missing_credentials" | "load_failed") {
    super(message);
    this.name = "CompanyCacheError";
    this.reason = reason;
  }
}

export type NameSearchOutcome =
  | {
      kind: "hit";
      results: CachedCompany[];
      matched: number;
      bestScore: number;
      searchMs: number;
      lowConfidence: boolean;
    }
  | { kind: "miss"; bestScore: number; searchMs: number }
  | { kind: "unavailable"; reason: "missing_credentials" | "load_failed" };

export type OrgSearchOutcome =
  | { kind: "hit"; company: CachedCompany }
  | { kind: "miss" }
  | { kind: "unavailable"; reason: "missing_credentials" | "load_failed" };

export type CompanyDirectory = {
  searchByName(name: string, limit?: number): Promise<NameSearchOutcome>;
  findByOrganizationNumber(organizationNumber: string): Promise<OrgSearchOutcome>;
  /** Start a load if the snapshot is missing or stale. Does not block the caller. */
  warm(): void;
};

type Snapshot = {
  index: SearchIndex;
  byOrg: Map<string, IndexedCompany>;
  at: number;
};

type LoadFailure = { ok: false; reason: "missing_credentials" | "load_failed" };

export function createCompanyDirectory(options: {
  load: () => Promise<CachedCompany[]>;
  ttlMs?: number;
  now?: () => number;
}): CompanyDirectory {
  const ttlMs = options.ttlMs ?? COMPANY_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  let snapshot: Snapshot | undefined;
  let inflight: Promise<Snapshot | LoadFailure> | undefined;

  async function current(): Promise<Snapshot | LoadFailure> {
    const at = now();
    if (snapshot && at - snapshot.at < ttlMs) {
      return snapshot;
    }
    // A voice call must not start live SCB while the first load is still running.
    if (!snapshot) {
      return start();
    }
    void start();
    return snapshot;
  }

  function start(): Promise<Snapshot | LoadFailure> {
    if (!inflight) {
      inflight = options
        .load()
        .then((companies) => {
          const next = toSnapshot(companies, now());
          snapshot = next;
          return next;
        })
        .catch((error: unknown): LoadFailure => ({
          ok: false,
          reason: error instanceof CompanyCacheError ? error.reason : "load_failed",
        }))
        .finally(() => {
          inflight = undefined;
        });
    }
    return inflight;
  }

  return {
    async searchByName(name, limit = CACHE_NAME_LIMIT) {
      const loaded = await current();
      if (!isSnapshot(loaded)) {
        return { kind: "unavailable", reason: loaded.reason };
      }
      const started = now();
      const ranked = rankCompanies(loaded.index, name, limit);
      const searchMs = Math.max(0, now() - started);
      if (ranked.matched === 0 || ranked.bestScore < PLAUSIBLE_THRESHOLD) {
        return { kind: "miss", bestScore: ranked.bestScore, searchMs };
      }
      return {
        kind: "hit",
        results: ranked.results,
        matched: ranked.matched,
        bestScore: ranked.bestScore,
        searchMs,
        lowConfidence: ranked.lowConfidence,
      };
    },
    async findByOrganizationNumber(organizationNumber) {
      const loaded = await current();
      if (!isSnapshot(loaded)) {
        return { kind: "unavailable", reason: loaded.reason };
      }
      const key = organizationNumberKey(organizationNumber);
      if (!key) {
        return { kind: "miss" };
      }
      const company = loaded.byOrg.get(key);
      return company ? { kind: "hit", company } : { kind: "miss" };
    },
    warm() {
      const at = now();
      if (!snapshot || at - snapshot.at >= ttlMs) {
        void start();
      }
    },
  };
}

let shared: CompanyDirectory | undefined;

export function defaultCompanyDirectory(): CompanyDirectory {
  shared ??= createCompanyDirectory({
    load: loadCompaniesFromEnv,
  });
  return shared;
}

async function loadCompaniesFromEnv(): Promise<CachedCompany[]> {
  const raw = process.env.GCP_SA_JSON?.trim();
  if (!raw) {
    throw new CompanyCacheError("GCP_SA_JSON is not set", "missing_credentials");
  }
  const { loadActiveCompanies } = await import("./firestore.js");
  return loadActiveCompanies(raw);
}

export function companyFromDocument(id: string, data: Record<string, unknown>): CachedCompany | undefined {
  if (data.active === false || data.active === "false" || data.active === 0) {
    return undefined;
  }
  const organizationNumber = organizationNumberKey(id) ?? organizationNumberKey(stringValue(data.orgNr) ?? "");
  const name = stringValue(data.name);
  if (!organizationNumber || !name) {
    return undefined;
  }
  const stored = stringValue(data.nameNormalized);
  const nameNormalized = stored ? stored.toLowerCase().replace(/\s+/gu, " ").trim() : normalizeCompanyName(name);
  if (!nameNormalized) {
    return undefined;
  }
  const company: CachedCompany = {
    organizationNumber,
    name,
    nameNormalized,
    status: data.active === false ? "ej verksam" : "verksam",
  };
  const city = stringValue(data.city) ?? stringValue(data.municipality);
  const sizeClass = formatSizeClass(data.employeesClass ?? data.sizeClass);
  const industry = formatIndustry(data);
  if (city) {
    company.city = city;
  }
  if (sizeClass) {
    company.sizeClass = sizeClass;
  }
  if (industry) {
    company.industry = industry;
  }
  return company;
}

export function organizationNumberKey(value: string): string | undefined {
  const digits = value.replace(/\D/gu, "");
  if (digits.length === 12 && (digits.startsWith("16") || digits.startsWith("19") || digits.startsWith("20"))) {
    return digits.slice(2);
  }
  if (digits.length === 10) {
    return digits;
  }
  return undefined;
}

function toSnapshot(companies: readonly CachedCompany[], at: number): Snapshot {
  const index = buildSearchIndex(companies);
  const byOrg = new Map<string, IndexedCompany>();
  for (const company of index.companies) {
    byOrg.set(company.organizationNumber, company);
  }
  return { index, byOrg, at };
}

function isSnapshot(value: Snapshot | LoadFailure): value is Snapshot {
  return "index" in value;
}

/**
 * Overlap the Firestore read with the rest of cold start. The microtask runs
 * after this module has finished evaluating, so the Firestore import cannot
 * deadlock on the directory cycle. The first search awaits the same load.
 */
queueMicrotask(() => {
  if (!process.env.GCP_SA_JSON?.trim()) {
    return;
  }
  defaultCompanyDirectory().warm();
});

function formatSizeClass(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  const label = SIZE_CLASS_LABELS[text];
  if (label) {
    return label;
  }
  if (/anställd/iu.test(text)) {
    return text;
  }
  if (/^\d+\s*[-–]\s*\d+$/u.test(text)) {
    return `${text} anställda`;
  }
  return text;
}

function formatIndustry(data: Record<string, unknown>): string | undefined {
  const codes = stringList(data.sniCodes ?? data.sni ?? data.sniCode);
  const group = stringValue(data.sniGroup);
  if (codes.length > 0 && group && !codes.some((code) => group.includes(code))) {
    return `${codes.join(", ")} ${group}`;
  }
  if (group) {
    return group;
  }
  if (codes.length > 0) {
    return codes.join(", ");
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = stringValue(item);
      if (text) {
        return [text];
      }
      if (!item || typeof item !== "object") {
        return [];
      }
      const record = item as Record<string, unknown>;
      const code = stringValue(record.code ?? record.kod);
      const label = stringValue(record.text ?? record.label);
      if (code && label) {
        return [`${code} ${label}`];
      }
      return [code, label].filter((part): part is string => Boolean(part));
    });
  }
  const text = stringValue(value);
  return text ? [text] : [];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}
