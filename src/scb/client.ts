import { localRateLimited, mapHttpError, queryTooBroad, ScbError, unknownOperatorError, withCatalogHints } from "../domain/errors.js";
import { createLogger, type LogLevel } from "../log.js";
import { apiIdHeaders, createScbDispatcher, type ScbAuthConfig, validateCertConfig } from "./auth.js";
import { TtlCache } from "./cache.js";
import { lookupCategoryGroups, searchCodeTables, type CodeLookupResult } from "./code-lookup.js";
import { countPath, endpointsFor, searchPath } from "./endpoints.js";
import { identityInvalidErrorDetails, normalizeIdentityInFilters } from "./identity.js";
import { isAllowedOperator } from "./operators.js";
import {
  extractMetadataItems,
  parseCountResponse,
  parseListResponse,
  parseSearchResponse,
  toKodtabellBody,
  toScbQueryBody,
} from "./payload.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import type { ScbFilters } from "./schemas.js";
import { cheapSampleCategoryNames, compactSchemaSummary, type SchemaSummary } from "./schema-summary.js";
import {
  COUNT_CACHE_TTL_MS,
  layoutFor,
  MAX_RESULTS,
  METADATA_CACHE_TTL_MS,
  RATE_LIMIT_WINDOW_MS,
  type ObjectType,
} from "./types.js";

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    dispatcher?: unknown;
  },
) => Promise<Response>;

export type ScbClientOptions = {
  baseUrl: string;
  auth: ScbAuthConfig;
  fetch?: FetchLike;
  rateLimiter?: SlidingWindowRateLimiter;
  logLevel?: LogLevel;
  skipCertLoad?: boolean;
  bypassMetadataCache?: boolean;
  metadataCacheTtlMs?: number;
  countCacheTtlMs?: number;
};

export type MetadataCallOptions = {
  bypassCache?: boolean;
};

export type SearchResult = {
  count: number;
  results: unknown[];
  skippedFetch?: boolean;
  countFromCache?: boolean;
};

/**
 * Extra variables on hamta only (not rakna). Live JE omits Namn/OrgNr unless
 * they appear in POST `variabler`.
 */
export type SearchCallOptions = {
  selectVariables?: ScbFilters["variables"];
};

type RequestContext = {
  tool: string;
  body?: unknown;
  objectType?: ObjectType;
  unknownName?: string;
  field?: string;
  submittedCategories?: string[];
  submittedVariables?: string[];
};

export class ScbClient {
  private readonly baseUrl: string;
  private readonly auth: ScbAuthConfig;
  private readonly fetchImpl: FetchLike;
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly log: ReturnType<typeof createLogger>;
  private readonly dispatcher: unknown;
  private readonly bypassMetadataCache: boolean;
  private readonly metadataCache: TtlCache<unknown>;
  private readonly countCache: TtlCache<number>;

  constructor(options: ScbClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
    this.rateLimiter = options.rateLimiter ?? new SlidingWindowRateLimiter();
    this.log = createLogger(options.logLevel ?? "info");
    this.bypassMetadataCache =
      options.bypassMetadataCache ?? process.env.SCB_METADATA_CACHE_BYPASS === "true";
    this.metadataCache = new TtlCache(options.metadataCacheTtlMs ?? METADATA_CACHE_TTL_MS);
    this.countCache = new TtlCache(options.countCacheTtlMs ?? COUNT_CACHE_TTL_MS);
    if (options.skipCertLoad) {
      validateCertConfig(this.auth);
      this.dispatcher = undefined;
    } else {
      this.dispatcher = createScbDispatcher(this.auth);
    }
  }

  async listCategories(
    objectType: ObjectType,
    includeCodeTables = false,
    options: MetadataCallOptions = {},
  ): Promise<unknown> {
    const layout = layoutFor(objectType);
    const path = includeCodeTables
      ? endpointsFor(layout).kategoriermedkodtabeller
      : endpointsFor(layout).koptakategorier;
    const key = `listCategories:${layout}:${includeCodeTables ? "1" : "0"}`;
    return parseListResponse(
      await this.cachedMetadata(key, options.bypassCache === true, () =>
        this.request("GET", path, { tool: "scb_list_categories", objectType }),
      ),
    );
  }

  async getCategoryValues(
    objectType: ObjectType,
    category: string,
    options: MetadataCallOptions = {},
  ): Promise<unknown> {
    const layout = layoutFor(objectType);
    const path = endpointsFor(layout).kodtabell;
    const key = `kodtabell:${layout}:${category}`;
    return parseListResponse(
      await this.cachedMetadata(key, options.bypassCache === true, () =>
        this.request("POST", path, {
          tool: "scb_get_category_values",
          body: toKodtabellBody(category),
          objectType,
          unknownName: category,
          field: "category",
          submittedCategories: [category],
        }),
      ),
    );
  }

  async listVariables(
    objectType: ObjectType,
    includeValueMetadata = false,
    options: MetadataCallOptions = {},
  ): Promise<unknown> {
    const layout = layoutFor(objectType);
    const path = includeValueMetadata
      ? endpointsFor(layout).variabler
      : endpointsFor(layout).koptavariabler;
    const key = `listVariables:${layout}:${includeValueMetadata ? "1" : "0"}`;
    return parseListResponse(
      await this.cachedMetadata(key, options.bypassCache === true, () =>
        this.request("GET", path, { tool: "scb_list_variables", objectType }),
      ),
    );
  }

  async countCompanies(filters: ScbFilters): Promise<number> {
    return this.count("company", filters, "scb_count_companies");
  }

  async countWorkplaces(filters: ScbFilters): Promise<number> {
    return this.count("workplace", filters, "scb_count_workplaces");
  }

  async searchCompanies(filters: ScbFilters, options: SearchCallOptions = {}): Promise<SearchResult> {
    return this.search("company", filters, "scb_search_companies", options);
  }

  async searchWorkplaces(filters: ScbFilters, options: SearchCallOptions = {}): Promise<SearchResult> {
    return this.search("workplace", filters, "scb_search_workplaces", options);
  }

  async schemaSummary(objectType: ObjectType, options: MetadataCallOptions = {}): Promise<SchemaSummary> {
    const categoriesRaw = await this.listCategories(objectType, false, options);
    const variablesRaw = await this.listVariables(objectType, false, options);
    const codeTables = new Map<string, unknown>();
    for (const name of cheapSampleCategoryNames(categoriesRaw)) {
      try {
        codeTables.set(name, await this.getCategoryValues(objectType, name, options));
      } catch (error) {
        if (error instanceof ScbError && error.code === "SCB_RATE_LIMITED") {
          break;
        }
      }
    }
    return compactSchemaSummary(objectType, categoriesRaw, variablesRaw, codeTables);
  }

  async lookupCodes(
    objectType: ObjectType,
    query: string,
    options: MetadataCallOptions & { category?: string | undefined; limit?: number | undefined } = {},
  ): Promise<CodeLookupResult> {
    const categoriesRaw = await this.listCategories(objectType, false, options);
    const groups = lookupCategoryGroups(categoriesRaw, options.category);
    const tables: Array<{ category: string; raw: unknown }> = [];
    let last: CodeLookupResult = {
      query,
      objectType,
      matches: [],
      total: 0,
      returned: 0,
    };
    for (const group of groups) {
      for (const category of group) {
        try {
          tables.push({ category, raw: await this.getCategoryValues(objectType, category, options) });
        } catch (error) {
          if (options.category) {
            throw error;
          }
          if (error instanceof ScbError && error.code === "SCB_RATE_LIMITED") {
            if (last.matches.length > 0) {
              return last;
            }
            throw error;
          }
        }
      }
      last = searchCodeTables(objectType, query, tables, options.limit);
      if (last.matches.length > 0) {
        return last;
      }
    }
    return last;
  }

  cachedCategoryNames(objectType: ObjectType): string[] | undefined {
    return this.cachedMetadataNames(`listCategories:${layoutFor(objectType)}:0`);
  }

  cachedVariableNames(objectType: ObjectType): string[] | undefined {
    return this.cachedMetadataNames(`listVariables:${layoutFor(objectType)}:0`);
  }

  private cachedMetadataNames(key: string): string[] | undefined {
    const raw = this.metadataCache.get(key);
    if (raw === undefined) {
      return undefined;
    }
    return extractMetadataItems(raw)
      .map((item) => item.name)
      .filter((name) => name.length > 0);
  }

  private assertKnownOperators(filters: ScbFilters): void {
    for (const item of filters.variables) {
      if (!isAllowedOperator(item.operator)) {
        throw unknownOperatorError(item.operator);
      }
    }
  }

  private enrichError(error: ScbError, objectType?: ObjectType): ScbError {
    if (!objectType) {
      return error;
    }
    return withCatalogHints(error, {
      objectType,
      categoryNames: this.cachedCategoryNames(objectType),
      variableNames: this.cachedVariableNames(objectType),
    });
  }

  private async count(objectType: ObjectType, filters: ScbFilters, tool: string): Promise<number> {
    this.assertKnownOperators(filters);
    const prepared = this.prepareFilters(objectType, filters);
    const cacheKey = countCacheKey(objectType, prepared);
    const cached = this.countCache.get(cacheKey);
    if (cached !== undefined) {
      this.log.info("SCB count cache hit", { tool, objectType, count: cached, cacheHit: true });
      return cached;
    }
    const layout = layoutFor(objectType);
    const path = countPath(layout);
    const payload = await this.request("POST", path, {
      tool,
      body: toScbQueryBody(prepared, layout),
      objectType,
      submittedCategories: prepared.categories.map((item) => item.category),
      submittedVariables: prepared.variables.map((item) => item.variable),
    });
    try {
      const count = parseCountResponse(payload);
      this.countCache.set(cacheKey, count);
      return count;
    } catch (error) {
      throw new ScbError("SCB_RESPONSE_VALIDATION_ERROR", "SCB count response was malformed.", false, {
        cause: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private async search(
    objectType: ObjectType,
    filters: ScbFilters,
    tool: string,
    options: SearchCallOptions = {},
  ): Promise<SearchResult> {
    const countTool = objectType === "company" ? "scb_count_companies" : "scb_count_workplaces";
    const prepared = this.prepareFilters(objectType, filters);
    const cacheKey = countCacheKey(objectType, prepared);
    const countFromCache = this.countCache.get(cacheKey) !== undefined;
    const count = await this.count(objectType, prepared, countTool);
    if (count > MAX_RESULTS) {
      throw queryTooBroad(count, MAX_RESULTS, {
        objectType,
        layout: layoutFor(objectType),
        appliedFilters: prepared,
        catalogCategoryNames: this.cachedCategoryNames(objectType),
        catalogVariableNames: this.cachedVariableNames(objectType),
      });
    }
    if (count === 0) {
      this.log.info("SCB search skipped fetch", { tool, objectType, count, cacheHit: countFromCache });
      return { count, results: [], skippedFetch: true, countFromCache };
    }
    const fetchFilters = withSelectVariables(prepared, options.selectVariables);
    this.assertKnownOperators(fetchFilters);
    const layout = layoutFor(objectType);
    const path = searchPath(layout);
    const payload = await this.request("POST", path, {
      tool,
      body: toScbQueryBody(fetchFilters, layout),
      objectType,
      submittedCategories: fetchFilters.categories.map((item) => item.category),
      submittedVariables: fetchFilters.variables.map((item) => item.variable),
    });
    try {
      const result: SearchResult = { count, results: parseSearchResponse(payload) };
      if (countFromCache) {
        result.countFromCache = true;
      }
      return result;
    } catch (error) {
      throw new ScbError("SCB_RESPONSE_VALIDATION_ERROR", "SCB search response was malformed.", false, {
        cause: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private prepareFilters(objectType: ObjectType, filters: ScbFilters): ScbFilters {
    const identity = normalizeIdentityInFilters(filters, objectType);
    if (identity.error) {
      throw new ScbError("SCB_INVALID_QUERY", identity.error, false, identityInvalidErrorDetails(identity.error));
    }
    return identity.filters;
  }

  private async cachedMetadata(
    key: string,
    bypass: boolean,
    loader: () => Promise<unknown>,
  ): Promise<unknown> {
    const skip = bypass || this.bypassMetadataCache;
    if (!skip) {
      const hit = this.metadataCache.get(key);
      if (hit !== undefined) {
        this.log.debug("SCB metadata cache hit", { endpoint: key, cacheHit: true });
        return hit;
      }
    }
    const value = await loader();
    if (!skip) {
      this.metadataCache.set(key, value);
    }
    return value;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: RequestContext = { tool: "unknown" },
  ): Promise<unknown> {
    const decision = this.rateLimiter.tryAcquire();
    if (!decision.ok) {
      const error = localRateLimited(decision.retryAfterMs, this.rateLimiter.outstanding);
      this.log.info("SCB local rate limit", {
        tool: options.tool,
        endpoint: path,
        retryAfterMs: decision.retryAfterMs,
        waitedMs: 0,
        errorCode: error.code,
      });
      throw error;
    }
    const url = `${this.baseUrl}${path}`;
    const started = Date.now();
    let status = 0;
    try {
      const init: {
        method: string;
        headers: Record<string, string>;
        body?: string;
        dispatcher?: unknown;
      } = {
        method,
        headers: {
          Accept: "application/json",
          ...apiIdHeaders(this.auth),
        },
      };
      if (options.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      if (this.dispatcher) {
        init.dispatcher = this.dispatcher;
      }
      const response = await this.fetchImpl(url, init);
      status = response.status;
      const text = await response.text();
      if (!response.ok) {
        throw mapHttpError(status, text, {
          ...(options.objectType ? { objectType: options.objectType } : {}),
          ...(options.unknownName ? { unknownName: options.unknownName } : {}),
          ...(options.field ? { field: options.field } : {}),
          ...(options.submittedCategories ? { submittedCategories: options.submittedCategories } : {}),
          ...(options.submittedVariables ? { submittedVariables: options.submittedVariables } : {}),
          ...(status === 429 ? { retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")) } : {}),
        });
      }
      if (text.trim() === "") {
        this.log.info("SCB request", {
          tool: options.tool,
          endpoint: path,
          durationMs: Date.now() - started,
          status,
          waitedMs: 0,
        });
        return null;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        this.log.info("SCB request", {
          tool: options.tool,
          endpoint: path,
          durationMs: Date.now() - started,
          status,
          waitedMs: 0,
        });
        return parsed;
      } catch {
        throw new ScbError("SCB_RESPONSE_VALIDATION_ERROR", "SCB returned non-JSON.", false, {
          status,
        });
      }
    } catch (error) {
      const mapped = toScbError(error);
      this.log.error("SCB request failed", {
        tool: options.tool,
        endpoint: path,
        durationMs: Date.now() - started,
        status,
        errorCode: mapped.code,
        waitedMs: 0,
        ...(typeof mapped.details.retryAfterMs === "number"
          ? { retryAfterMs: mapped.details.retryAfterMs }
          : {}),
      });
      throw this.enrichError(mapped, options.objectType);
    }
  }
}

function withSelectVariables(filters: ScbFilters, extra?: ScbFilters["variables"]): ScbFilters {
  if (!extra || extra.length === 0) {
    return filters;
  }
  const seen = new Set(filters.variables.map((item) => item.variable));
  const variables = [...filters.variables];
  for (const item of extra) {
    if (seen.has(item.variable)) {
      continue;
    }
    seen.add(item.variable);
    variables.push(item);
  }
  return { categories: filters.categories, variables };
}

function countCacheKey(objectType: ObjectType, filters: ScbFilters): string {
  return `${layoutFor(objectType)}:${JSON.stringify(toScbQueryBody(filters, layoutFor(objectType)))}`;
}

function parseRetryAfterMs(header: string | null): number {
  if (!header) {
    return RATE_LIMIT_WINDOW_MS;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(1, Math.round(seconds * 1000));
  }
  const when = Date.parse(header);
  if (!Number.isNaN(when)) {
    return Math.max(1, when - Date.now());
  }
  return RATE_LIMIT_WINDOW_MS;
}

function toScbError(error: unknown): ScbError {
  if (error instanceof ScbError) {
    return error;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("certificate") ||
      message.includes("pfx") ||
      message.includes("cert") ||
      message.includes("alert") ||
      message.includes("handshake")
    ) {
      return new ScbError("SCB_AUTH_ERROR", "TLS client certificate authentication failed.", false, {
        cause: error.message,
      });
    }
  }
  return new ScbError("SCB_UNAVAILABLE", "SCB request failed.", true, {
    cause: error instanceof Error ? error.message : "unknown",
  });
}
