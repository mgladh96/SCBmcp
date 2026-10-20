import { DEFAULT_CATEGORY_VALUES_LIMIT, filterHintsFor } from "../domain/catalog.js";
import { ScbError, type ScbErrorCode } from "../domain/errors.js";
import { collectQueryWarnings, UNBOUNDED_QUERY_WARNING } from "../domain/query-warnings.js";
import { createLogger } from "../log.js";
import type { ScbClient } from "../scb/client.js";
import { explainQuery } from "../scb/explain.js";
import {
  identityInvalidErrorDetails,
  LIVE_JE_ORGNR_10,
  normalizeIdentityInFilters,
  resolveJeNameVariable,
} from "../scb/identity.js";
import { SCB_OPERATOR_NAMES } from "../scb/operators.js";
import { toMetadataEnvelope, truncateMetadataItems } from "../scb/payload.js";
import { projectSearchResults } from "../scb/projection.js";
import { voiceCompanyPayload } from "./voice-companies.js";
import { discoverCodes } from "../scb/code-lookup.js";
import { compileStructuredQuery, countThenFetch } from "../scb/compile/index.js";
import { compileQueryInputSchema, countThenFetchInputSchema } from "../scb/compile/schema.js";
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
  findCompanyInputSchema,
  FIND_COMPANY_DEFAULT_MAX_ROWS,
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

function isFreeTextQuery(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.text === "string") {
    return true;
  }
  return typeof record.query === "string" && record.industry === undefined;
}

function nlRejectedError(): ScbError {
  return new ScbError(
    "SCB_INVALID_QUERY",
    "SCBmcp parsear inte naturligt språk. Agenten mappar NL → StructuredQuery; servern kompilerar bara SCB-filter.",
    false,
    { origin: "nl_rejected", hint: "Skicka objectType + industry/geography/employees/status/fields. Inte { text }." },
  );
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

const VOICE_ERROR_MESSAGE: Partial<Record<ScbErrorCode, string>> = {
  SCB_INVALID_QUERY: "Ange företagsnamn eller organisationsnummer.",
  SCB_UNKNOWN_VARIABLE: "Namnsökningen gick inte igenom. Prova organisationsnummer.",
  SCB_UNKNOWN_CATEGORY: "Sökningen gick inte igenom. Prova organisationsnummer.",
  QUERY_TOO_BROAD: "För många träffar. Säg ett tydligare namn eller organisationsnumret.",
  SCB_NO_MATCHES: "Inget företag hittades.",
  SCB_RATE_LIMITED: "Registret är upptaget. Försök igen om en stund.",
  SCB_AUTH_ERROR: "Kunde inte nå företagsregistret.",
  SCB_UNAVAILABLE: "Företagsregistret svarar inte just nu.",
  SCB_RESPONSE_VALIDATION_ERROR: "Svaret från registret gick inte att läsa.",
};

/** Short spoken line for the voice lookup. No SCB body, nearestNames, or tool lists. */
function voiceErrorResult(error: unknown): ToolResult {
  const code: ScbErrorCode = error instanceof ScbError ? error.code : "SCB_UNAVAILABLE";
  let message = VOICE_ERROR_MESSAGE[code] ?? "Sökningen misslyckades. Försök igen.";
  if (error instanceof ScbError && error.code === "SCB_INVALID_QUERY" && error.details.origin === "identity") {
    message = "Organisationsnumret ser fel ut. Säg tio eller tolv siffror.";
  }
  const payload = { code, message };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function municipalityLabels(client: ScbClient): Map<string, string> | undefined {
  const rows = client.offlineCodeRows("company", "Säteskommun");
  if (!rows || rows.length === 0) {
    return undefined;
  }
  const labels = new Map<string, string>();
  for (const row of rows) {
    labels.set(row.code, row.label);
    const stripped = row.code.replace(/^0+/u, "");
    if (stripped) {
      labels.set(stripped, row.label);
    }
  }
  return labels;
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
  if (projected.omittedByMaxRows > 0) {
    extraWarnings.push(
      `MCP-svaret trunkerades till maxRows=${projected.maxRows} (SCB hämtade ${projected.fetched} rader; fields/maxRows minskar bara agentvyn, inte SCB-anropet).`,
    );
  }
  const payload: Record<string, unknown> = {
    count: options.count,
    fetched: projected.fetched,
    returned: projected.returned,
    results: projected.results,
    filters: options.filters,
    source: searchSource(),
    projectedFields: projected.projectedFields,
    maxRows: projected.maxRows,
  };
  if (projected.omittedByMaxRows > 0) {
    payload.omittedByMaxRows = projected.omittedByMaxRows;
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
  async function runCompanySearch(
    tool: string,
    filters: ScbFilters,
    projection: { fields?: string[] | undefined; maxRows?: number | undefined },
    voice?: { nameQuery?: string | undefined; limit?: number | undefined },
  ): Promise<ToolResult> {
    const prepared = preparedFilters("company", filters);
    if (prepared.error) {
      return voice
        ? voiceErrorResult(
            new ScbError("SCB_INVALID_QUERY", prepared.error, false, { origin: "identity" }),
          )
        : identityErrorResult(prepared.error);
    }
    const started = Date.now();
    try {
      const { count, results, skippedFetch, countFromCache } = await client.searchCompanies(
        prepared.filters,
      );
      log.info("MCP tool", {
        tool,
        durationMs: Date.now() - started,
        status: 200,
        count,
        ...(countFromCache ? { cacheHit: true } : {}),
      });
      if (voice) {
        return jsonResult(
          voiceCompanyPayload(results, {
            count,
            nameQuery: voice.nameQuery,
            limit: voice.limit ?? projection.maxRows,
            municipalityLabels: municipalityLabels(client),
          }),
        );
      }
      return jsonResult(
        searchEnvelope("company", {
          count,
          results,
          filters: prepared.filters,
          fields: projection.fields,
          maxRows: projection.maxRows,
          skippedFetch,
          countFromCache,
          extraWarnings: prepared.warnings,
        }),
      );
    } catch (error) {
      logToolError(tool, started, error);
      return voice ? voiceErrorResult(error) : errorResult(error);
    }
  }

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
      return runCompanySearch("scb_search_companies", parsed.data.filters, {
        fields: parsed.data.fields,
        maxRows: parsed.data.maxRows,
      });
    },

    async scb_find_company(input: unknown): Promise<ToolResult> {
      const parsed = findCompanyInputSchema.safeParse(input);
      if (!parsed.success) {
        return voiceErrorResult(invalidInput("scb_find_company", parsed.error));
      }
      if (!parsed.data.name && !parsed.data.organizationNumber) {
        return voiceErrorResult(
          new ScbError("SCB_INVALID_QUERY", "Ange name och/eller organizationNumber.", false, {
            origin: "mcp_input",
            field: "name",
          }),
        );
      }
      const variables: ScbFilters["variables"] = [];
      if (parsed.data.name) {
        variables.push({
          variable: resolveJeNameVariable(client.offlineVariableNames("company")),
          operator: "Innehaller",
          value: parsed.data.name,
        });
      }
      if (parsed.data.organizationNumber) {
        variables.push({
          variable: LIVE_JE_ORGNR_10,
          operator: "ArLikaMed",
          value: parsed.data.organizationNumber,
        });
      }
      const limit = parsed.data.maxRows ?? FIND_COMPANY_DEFAULT_MAX_ROWS;
      return runCompanySearch(
        "scb_find_company",
        { categories: [], variables },
        { maxRows: limit },
        { nameQuery: parsed.data.name, limit },
      );
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
      return lookupCodes("scb_lookup_codes", input);
    },

    async scb_discover(input: unknown): Promise<ToolResult> {
      return lookupCodes("scb_discover", input);
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

    async scb_compile_query(input: unknown): Promise<ToolResult> {
      if (isFreeTextQuery(input)) {
        return errorResult(nlRejectedError());
      }
      const parsed = compileQueryInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(invalidInput("scb_compile_query", parsed.error));
      }
      const started = Date.now();
      try {
        const compiled = await compileStructuredQuery(parsed.data, client);
        log.info("MCP tool", {
          tool: "scb_compile_query",
          durationMs: Date.now() - started,
          status: 200,
          objectType: compiled.objectType,
        });
        return jsonResult({
          ok: compiled.ok,
          status: compiled.status,
          objectType: compiled.objectType,
          layout: compiled.resolved.layout,
          filters: compiled.filters,
          resolved: compiled.resolved,
          coverage: compiled.coverage,
          warnings: compiled.warnings,
          unresolved: compiled.unresolved,
          source: SOURCE_LABEL,
        });
      } catch (error) {
        logToolError("scb_compile_query", started, error);
        return errorResult(error);
      }
    },

    async scb_count_then_fetch(input: unknown): Promise<ToolResult> {
      return runQuery("scb_count_then_fetch", input);
    },

    async scb_query(input: unknown): Promise<ToolResult> {
      return runQuery("scb_query", input);
    },
  };

  async function lookupCodes(tool: string, input: unknown): Promise<ToolResult> {
    const parsed = lookupCodesInputSchema.safeParse(input);
    if (!parsed.success) {
      return errorResult(invalidInput(tool, parsed.error));
    }
    const started = Date.now();
    try {
      const result = await discoverCodes(client, parsed.data.objectType, parsed.data.query, {
        category: parsed.data.category,
        kind: parsed.data.kind,
        parentCode: parsed.data.parentCode,
        limit: parsed.data.limit,
        bypassCache: parsed.data.bypassCache === true,
      });
      log.info("MCP tool", {
        tool,
        durationMs: Date.now() - started,
        status: 200,
        objectType: parsed.data.objectType,
      });
      return jsonResult({ ...result, source: SOURCE_LABEL });
    } catch (error) {
      logToolError(tool, started, error);
      return errorResult(error);
    }
  }

  async function runQuery(tool: string, input: unknown): Promise<ToolResult> {
    if (isFreeTextQuery(input)) {
      return errorResult(nlRejectedError());
    }
    const parsed = countThenFetchInputSchema.safeParse(input);
    if (!parsed.success) {
      return errorResult(invalidInput(tool, parsed.error));
    }
    const started = Date.now();
    try {
      const payload = await countThenFetch(client, parsed.data);
      log.info("MCP tool", {
        tool,
        durationMs: Date.now() - started,
        status: 200,
        objectType: payload.objectType,
        ...(payload.status === "ok" ? { count: payload.count } : { queryStatus: payload.status }),
      });
      return jsonResult(payload);
    } catch (error) {
      logToolError(tool, started, error);
      return errorResult(error);
    }
  }

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
    if (code === "QUERY_TOO_BROAD" || code === "SCB_RATE_LIMITED" || code === "SCB_NO_MATCHES") {
      log.info("MCP tool rejected", fields);
      return;
    }
    log.error("MCP tool failed", fields);
  }
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
