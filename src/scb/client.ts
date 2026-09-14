import { mapHttpError, queryTooBroad, ScbError } from "../domain/errors.js";
import { createLogger, type LogLevel } from "../log.js";
import { apiIdHeaders, createScbDispatcher, type ScbAuthConfig, validateCertConfig } from "./auth.js";
import { countPath, endpointsFor, searchPath } from "./endpoints.js";
import {
  parseCountResponse,
  parseListResponse,
  parseSearchResponse,
  toKodtabellBody,
  toScbQueryBody,
} from "./payload.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import type { ScbFilters } from "./schemas.js";
import { layoutFor, MAX_RESULTS, type ObjectType } from "./types.js";

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
};

export class ScbClient {
  private readonly baseUrl: string;
  private readonly auth: ScbAuthConfig;
  private readonly fetchImpl: FetchLike;
  private readonly rateLimiter: SlidingWindowRateLimiter;
  private readonly log: ReturnType<typeof createLogger>;
  private readonly dispatcher: unknown;

  constructor(options: ScbClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
    this.rateLimiter = options.rateLimiter ?? new SlidingWindowRateLimiter();
    this.log = createLogger(options.logLevel ?? "info");
    if (options.skipCertLoad) {
      validateCertConfig(this.auth);
      this.dispatcher = undefined;
    } else {
      this.dispatcher = createScbDispatcher(this.auth);
    }
  }

  async listCategories(objectType: ObjectType, includeCodeTables = false): Promise<unknown> {
    const layout = layoutFor(objectType);
    const path = includeCodeTables
      ? endpointsFor(layout).kategoriermedkodtabeller
      : endpointsFor(layout).koptakategorier;
    return parseListResponse(await this.request("GET", path, { tool: "scb_list_categories" }));
  }

  async getCategoryValues(objectType: ObjectType, category: string): Promise<unknown> {
    const layout = layoutFor(objectType);
    const path = endpointsFor(layout).kodtabell;
    return parseListResponse(
      await this.request("POST", path, {
        tool: "scb_get_category_values",
        body: toKodtabellBody(category),
      }),
    );
  }

  async listVariables(objectType: ObjectType, includeValueMetadata = false): Promise<unknown> {
    const layout = layoutFor(objectType);
    const path = includeValueMetadata
      ? endpointsFor(layout).variabler
      : endpointsFor(layout).koptavariabler;
    return parseListResponse(await this.request("GET", path, { tool: "scb_list_variables" }));
  }

  async countCompanies(filters: ScbFilters): Promise<number> {
    return this.count("company", filters, "scb_count_companies");
  }

  async countWorkplaces(filters: ScbFilters): Promise<number> {
    return this.count("workplace", filters, "scb_count_workplaces");
  }

  async searchCompanies(filters: ScbFilters): Promise<{ count: number; results: unknown[] }> {
    return this.search("company", filters, "scb_search_companies");
  }

  async searchWorkplaces(filters: ScbFilters): Promise<{ count: number; results: unknown[] }> {
    return this.search("workplace", filters, "scb_search_workplaces");
  }

  private async count(objectType: ObjectType, filters: ScbFilters, tool: string): Promise<number> {
    const layout = layoutFor(objectType);
    const path = countPath(layout);
    const payload = await this.request("POST", path, { tool, body: toScbQueryBody(filters) });
    try {
      return parseCountResponse(payload);
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
  ): Promise<{ count: number; results: unknown[] }> {
    const countTool = objectType === "company" ? "scb_count_companies" : "scb_count_workplaces";
    const count = await this.count(objectType, filters, countTool);
    if (count > MAX_RESULTS) {
      throw queryTooBroad(count, MAX_RESULTS);
    }
    const layout = layoutFor(objectType);
    const path = searchPath(layout);
    const payload = await this.request("POST", path, { tool, body: toScbQueryBody(filters) });
    try {
      return { count, results: parseSearchResponse(payload) };
    } catch (error) {
      throw new ScbError("SCB_RESPONSE_VALIDATION_ERROR", "SCB search response was malformed.", false, {
        cause: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { tool: string; body?: unknown } = { tool: "unknown" },
  ): Promise<unknown> {
    await this.rateLimiter.acquire();
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
        throw mapHttpError(status, text);
      }
      if (text.trim() === "") {
        this.log.info("SCB request", {
          tool: options.tool,
          endpoint: path,
          durationMs: Date.now() - started,
          status,
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
      });
      throw mapped;
    }
  }
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
