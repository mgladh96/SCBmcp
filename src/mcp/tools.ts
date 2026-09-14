import { DEFAULT_CATEGORY_VALUES_LIMIT, filterHintsFor } from "../domain/catalog.js";
import { ScbError } from "../domain/errors.js";
import { collectQueryWarnings, UNBOUNDED_QUERY_WARNING } from "../domain/query-warnings.js";
import { createLogger } from "../log.js";
import type { ScbClient } from "../scb/client.js";
import { explainQuery } from "../scb/explain.js";
import { identityInvalidErrorDetails, normalizeIdentityInFilters } from "../scb/identity.js";
import { SCB_OPERATOR_NAMES } from "../scb/operators.js";
import { toMetadataEnvelope, truncateMetadataItems } from "../scb/payload.js";
import { omittedFromCounts, projectSearchResults } from "../scb/projection.js";
import {
  countCompaniesInputSchema,
  countWorkplacesInputSchema,
  explainQueryInputSchema,
  filterHintsInputSchema,
  getCategoryValuesInputSchema,
  listCategoriesInputSchema,
  listVariablesInputSchema,
  lookupCodesInputSchema,
  schemaSummaryInputSchema,
  searchCompaniesInputSchema,
  searchWorkplacesInputSchema,
  type ScbFilters,
} from "../scb/schemas.js";
import { SOURCE_LABEL, SOURCE_PROVIDER, SOURCE_REGISTRY, type ObjectType } from "../scb/types.js";

export { UNBOUNDED_QUERY_WARNING };

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function jsonResult(payload: unknown): ToolResult {
  const text = JSON.stringify(payload);
  return {
    content: [{ type: "text", text }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function errorResult(error: unknown): ToolResult {
  const payload =
    error instanceof ScbError
      ? error.toJSON()
      : {
          code: "SCB_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Unknown error",
          retryable: true,
          nextAction: "retry_same",
          nextTools: [],
          details: {},
        };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function invalidInput(tool: string, error: { flatten: () => unknown; issues: Array<{ path: PropertyKey[]; code?: string }> }): ScbError {
  const firstPath = error.issues[0]?.path.map(String).join(".");
  const operatorIssue = error.issues.some((issue) => issue.path.map(String).includes("operator"));
  return new ScbError("SCB_INVALID_QUERY", `Invalid input for ${tool}.`, false, {
    origin: "mcp_input",
    issues: error.flatten(),
    ...(firstPath ? { field: firstPath, unknownName: firstPath } : {}),
    ...(operatorIssue ? { allowedOperators: [...SCB_OPERATOR_NAMES] } : {}),
  });
}

function withFilterWarning<T extends Record<string, unknown>>(
  payload: T,
  objectType: ObjectType,
  filters: ScbFilters,
  extraWarnings: string[] = [],
): T & { warning?: string; warnings?: string[] } {
  const warnings = unique([
    ...collectQueryWarnings(objectType, filters),
    ...extraWarnings,
  ]);
  if (warnings.length === 0) {
    return payload;
  }
  const extra: { warning: string; warnings: string[] } = {
    warning: warnings[0] ?? UNBOUNDED_QUERY_WARNING,
    warnings,
  };
  return { ...payload, ...extra };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function preparedFilters(
  objectType: ObjectType,
  filters: ScbFilters,
): { filters: ScbFilters; warnings: string[]; error?: string } {
  const identity = normalizeIdentityInFilters(filters, objectType);
  if (identity.error) {
    return { filters, warnings: identity.warnings, error: identity.error };
  }
  return { filters: identity.filters, warnings: identity.warnings };
}

function identityErrorResult(message: string): ToolResult {
  return errorResult(
    new ScbError("SCB_INVALID_QUERY", message, false, identityInvalidErrorDetails(message)),
  );
}

function searchSource(): { provider: string; registry: string } {
  return { provider: SOURCE_PROVIDER, registry: SOURCE_REGISTRY };
}

function searchEnvelope(
  objectType: ObjectType,
  options: {
    count: number;
    results: unknown[];
    filters: ScbFilters;
    fields?: string[] | undefined;
    maxRows?: number | undefined;
    skippedFetch?: boolean | undefined;
    countFromCache?: boolean | undefined;
    extraWarnings?: string[] | undefined;
  },
): Record<string, unknown> {
  const projected = projectSearchResults(options.results, objectType, {
    ...(options.fields ? { fields: options.fields } : {}),
    ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
  });
  const extraWarnings = [...(options.extraWarnings ?? [])];
  if (!projected.reklamPreserved) {
    extraWarnings.push("Reklam saknades i SCB-raderna; fältet strippas aldrig av MCP.");
  }
  if (projected.omittedRows > 0) {
    extraWarnings.push(
      `MCP-svaret trunkerades till maxRows=${projected.maxRows} (SCB hämtade ${options.results.length} rader; ingen paginering).`,
    );
  }
  const omitted = omittedFromCounts(options.count, projected.returned, projected.omittedRows);
  const payload: Record<string, unknown> = {
    count: options.count,
    returned: projected.returned,
    results: projected.results,
    filters: options.filters,
    source: searchSource(),
    projectedFields: projected.projectedFields,
    maxRows: projected.maxRows,
  };
  if (omitted !== undefined) {
    payload.omitted = omitted;
  }
  if (options.skippedFetch) {
    payload.skippedFetch = true;
  }
  if (options.countFromCache) {
    payload.countFromCache = true;
  }
  return withFilterWarning(payload, objectType, options.filters, extraWarnings);
}

export function createToolHandlers(client: ScbClient, log = createLogger()) {
  return {
    async scb_list_categories(input: unknown): Promise<ToolResult> {
      const parsed = listCategoriesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_list_categories", parsed.error));
      }
      const started = Date.now();
      try {
        const raw = await client.listCategories(
          parsed.data.objectType,
          parsed.data.includeCodeTables ?? false,
          { bypassCache: parsed.data.bypassCache === true },
        );
        const envelope = toMetadataEnvelope(parsed.data.objectType, raw);
        log.info("MCP tool", {
          tool: "scb_list_categories",
          durationMs: Date.now() - started,
          status: 200,
          objectType: parsed.data.objectType,
        });
        return jsonResult({
          objectType: envelope.objectType,
          includeCodeTables: parsed.data.includeCodeTables ?? false,
          items: envelope.items,
          raw: envelope.raw,
          categories: envelope.raw,
          source: SOURCE_LABEL,
        });
      } catch (error) {
        logToolError("scb_list_categories", started, error);
        return errorResult(error);
      }
    },

    async scb_get_category_values(input: unknown): Promise<ToolResult> {
      const parsed = getCategoryValuesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_get_category_values", parsed.error));
      }
      const started = Date.now();
      try {
        const raw = await client.getCategoryValues(parsed.data.objectType, parsed.data.category, {
          bypassCache: parsed.data.bypassCache === true,
        });
        const truncated = truncateMetadataItems(raw, {
          query: parsed.data.query,
          limit: parsed.data.limit,
          includeAll: parsed.data.includeAll,
          defaultLimit: DEFAULT_CATEGORY_VALUES_LIMIT,
        });
        const envelope = toMetadataEnvelope(parsed.data.objectType, raw);
        log.info("MCP tool", {
          tool: "scb_get_category_values",
          durationMs: Date.now() - started,
          status: 200,
          objectType: parsed.data.objectType,
        });
        const includeRaw = parsed.data.includeAll === true || parsed.data.limit === 0;
        return jsonResult({
          objectType: envelope.objectType,
          category: parsed.data.category,
          query: parsed.data.query ?? null,
          total: truncated.total,
          returned: truncated.returned,
          truncated: truncated.truncated,
          items: truncated.items,
          values: truncated.items,
          ...(includeRaw ? { raw: envelope.raw } : {}),
          source: SOURCE_LABEL,
        });
      } catch (error) {
        logToolError("scb_get_category_values", started, error);
        return errorResult(error);
      }
    },

    async scb_list_variables(input: unknown): Promise<ToolResult> {
      const parsed = listVariablesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_list_variables", parsed.error));
      }
      const started = Date.now();
      try {
        const raw = await client.listVariables(
          parsed.data.objectType,
          parsed.data.includeValueMetadata ?? false,
          { bypassCache: parsed.data.bypassCache === true },
        );
        const envelope = toMetadataEnvelope(parsed.data.objectType, raw);
        log.info("MCP tool", {
          tool: "scb_list_variables",
          durationMs: Date.now() - started,
          status: 200,
          objectType: parsed.data.objectType,
        });
        return jsonResult({
          objectType: envelope.objectType,
          includeValueMetadata: parsed.data.includeValueMetadata ?? false,
          items: envelope.items,
          raw: envelope.raw,
          variables: envelope.raw,
          source: SOURCE_LABEL,
        });
      } catch (error) {
        logToolError("scb_list_variables", started, error);
        return errorResult(error);
      }
    },

    async scb_count_companies(input: unknown): Promise<ToolResult> {
      const parsed = countCompaniesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_count_companies", parsed.error));
      }
      const prepared = preparedFilters("company", parsed.data.filters);
      if (prepared.error) {
        return identityErrorResult(prepared.error);
      }
      const started = Date.now();
      try {
        const count = await client.countCompanies(prepared.filters);
        log.info("MCP tool", {
          tool: "scb_count_companies",
          durationMs: Date.now() - started,
          status: 200,
          count,
        });
        return jsonResult(
          withFilterWarning(
            {
              count,
              objectType: "company",
              filters: prepared.filters,
              source: SOURCE_LABEL,
            },
            "company",
            prepared.filters,
            prepared.warnings,
          ),
        );
      } catch (error) {
        logToolError("scb_count_companies", started, error);
        return errorResult(error);
      }
    },

    async scb_search_companies(input: unknown): Promise<ToolResult> {
      const parsed = searchCompaniesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_search_companies", parsed.error));
      }
      const prepared = preparedFilters("company", parsed.data.filters);
      if (prepared.error) {
        return identityErrorResult(prepared.error);
      }
      const started = Date.now();
      try {
        const { count, results, skippedFetch, countFromCache } = await client.searchCompanies(
          prepared.filters,
        );
        log.info("MCP tool", {
          tool: "scb_search_companies",
          durationMs: Date.now() - started,
          status: 200,
          count,
          ...(countFromCache ? { cacheHit: true } : {}),
        });
        return jsonResult(
          searchEnvelope("company", {
            count,
            results,
            filters: prepared.filters,
            fields: parsed.data.fields,
            maxRows: parsed.data.maxRows,
            skippedFetch,
            countFromCache,
            extraWarnings: prepared.warnings,
          }),
        );
      } catch (error) {
        logToolError("scb_search_companies", started, error);
        return errorResult(error);
      }
    },

    async scb_count_workplaces(input: unknown): Promise<ToolResult> {
      const parsed = countWorkplacesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_count_workplaces", parsed.error));
      }
      const prepared = preparedFilters("workplace", parsed.data.filters);
      if (prepared.error) {
        return identityErrorResult(prepared.error);
      }
      const started = Date.now();
      try {
        const count = await client.countWorkplaces(prepared.filters);
        log.info("MCP tool", {
          tool: "scb_count_workplaces",
          durationMs: Date.now() - started,
          status: 200,
          count,
        });
        return jsonResult(
          withFilterWarning(
            {
              count,
              objectType: "workplace",
              filters: prepared.filters,
              source: SOURCE_LABEL,
            },
            "workplace",
            prepared.filters,
            prepared.warnings,
          ),
        );
      } catch (error) {
        logToolError("scb_count_workplaces", started, error);
        return errorResult(error);
      }
    },

    async scb_search_workplaces(input: unknown): Promise<ToolResult> {
      const parsed = searchWorkplacesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_search_workplaces", parsed.error));
      }
      const prepared = preparedFilters("workplace", parsed.data.filters);
      if (prepared.error) {
        return identityErrorResult(prepared.error);
      }
      const started = Date.now();
      try {
        const { count, results, skippedFetch, countFromCache } = await client.searchWorkplaces(
          prepared.filters,
        );
        log.info("MCP tool", {
          tool: "scb_search_workplaces",
          durationMs: Date.now() - started,
          status: 200,
          count,
          ...(countFromCache ? { cacheHit: true } : {}),
        });
        return jsonResult(
          searchEnvelope("workplace", {
            count,
            results,
            filters: prepared.filters,
            fields: parsed.data.fields,
            maxRows: parsed.data.maxRows,
            skippedFetch,
            countFromCache,
            extraWarnings: prepared.warnings,
          }),
        );
      } catch (error) {
        logToolError("scb_search_workplaces", started, error);
        return errorResult(error);
      }
    },

    async scb_explain_query(input: unknown): Promise<ToolResult> {
      const parsed = explainQueryInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_explain_query", parsed.error));
      }
      const started = Date.now();
      const explained = explainQuery(parsed.data.objectType, parsed.data.filters);
      log.info("MCP tool", {
        tool: "scb_explain_query",
        durationMs: Date.now() - started,
        status: 200,
        objectType: parsed.data.objectType,
      });
      return jsonResult(explained);
    },

    async scb_schema_summary(input: unknown): Promise<ToolResult> {
      const parsed = schemaSummaryInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_schema_summary", parsed.error));
      }
      const started = Date.now();
      try {
        const summary = await client.schemaSummary(parsed.data.objectType, {
          bypassCache: parsed.data.bypassCache === true,
        });
        log.info("MCP tool", {
          tool: "scb_schema_summary",
          durationMs: Date.now() - started,
          status: 200,
          objectType: parsed.data.objectType,
        });
        return jsonResult({ ...summary, source: SOURCE_LABEL });
      } catch (error) {
        logToolError("scb_schema_summary", started, error);
        return errorResult(error);
      }
    },

    async scb_lookup_codes(input: unknown): Promise<ToolResult> {
      const parsed = lookupCodesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_lookup_codes", parsed.error));
      }
      const started = Date.now();
      try {
        const result = await client.lookupCodes(parsed.data.objectType, parsed.data.query, {
          category: parsed.data.category,
          limit: parsed.data.limit,
          bypassCache: parsed.data.bypassCache === true,
        });
        log.info("MCP tool", {
          tool: "scb_lookup_codes",
          durationMs: Date.now() - started,
          status: 200,
          objectType: parsed.data.objectType,
        });
        return jsonResult({ ...result, source: SOURCE_LABEL });
      } catch (error) {
        logToolError("scb_lookup_codes", started, error);
        return errorResult(error);
      }
    },

    async scb_filter_hints(input: unknown): Promise<ToolResult> {
      const parsed = filterHintsInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_filter_hints", parsed.error));
      }
      const started = Date.now();
      try {
        const catalog =
          parsed.data.objectType !== undefined
            ? {
                categoryNames: client.cachedCategoryNames(parsed.data.objectType),
                variableNames: client.cachedVariableNames(parsed.data.objectType),
              }
            : undefined;
        const hints = filterHintsFor(parsed.data.objectType, parsed.data.questionClass, catalog);
        log.info("MCP tool", {
          tool: "scb_filter_hints",
          durationMs: Date.now() - started,
          status: 200,
        });
        return jsonResult({
          questionClass: parsed.data.questionClass ?? null,
          objectType: parsed.data.objectType ?? null,
          hints,
          source: SOURCE_LABEL,
        });
      } catch (error) {
        logToolError("scb_filter_hints", started, error);
        return errorResult(error);
      }
    },
  };

  function logToolError(tool: string, started: number, error: unknown): void {
    const code = error instanceof ScbError ? error.code : "SCB_UNAVAILABLE";
    const fields = {
      tool,
      durationMs: Date.now() - started,
      errorCode: code,
      ...(error instanceof ScbError && typeof error.details.retryAfterMs === "number"
        ? { retryAfterMs: error.details.retryAfterMs }
        : {}),
    };
    if (code === "QUERY_TOO_BROAD" || code === "SCB_RATE_LIMITED") {
      log.info("MCP tool rejected", fields);
      return;
    }
    log.error("MCP tool failed", fields);
  }
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
