import { ScbError } from "../domain/errors.js";
import { createLogger } from "../log.js";
import type { ScbClient } from "../scb/client.js";
import { toMetadataEnvelope } from "../scb/payload.js";
import {
  countCompaniesInputSchema,
  countWorkplacesInputSchema,
  getCategoryValuesInputSchema,
  isUnboundedFilters,
  listCategoriesInputSchema,
  listVariablesInputSchema,
  searchCompaniesInputSchema,
  searchWorkplacesInputSchema,
  type ScbFilters,
} from "../scb/schemas.js";
import { SOURCE_LABEL, SOURCE_PROVIDER, SOURCE_REGISTRY } from "../scb/types.js";

export const UNBOUNDED_QUERY_WARNING =
  "Obegränsad fråga: tomma filter matchar hela JE/AE-populationen och ger nästan alltid QUERY_TOO_BROAD vid hämtning. Lägg på status, geografi, SNI eller storleksklass från listverktygen.";

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

function invalidInput(tool: string, error: { flatten: () => unknown; issues: Array<{ path: PropertyKey[] }> }): ScbError {
  const firstPath = error.issues[0]?.path.map(String).join(".");
  return new ScbError("SCB_INVALID_QUERY", `Invalid input for ${tool}.`, false, {
    origin: "mcp_input",
    issues: error.flatten(),
    ...(firstPath ? { field: firstPath, unknownName: firstPath } : {}),
  });
}

function withFilterWarning<T extends Record<string, unknown>>(
  payload: T,
  filters: ScbFilters,
): T & { warning?: string } {
  if (!isUnboundedFilters(filters)) {
    return payload;
  }
  return { ...payload, warning: UNBOUNDED_QUERY_WARNING };
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
        const envelope = toMetadataEnvelope(parsed.data.objectType, raw);
        log.info("MCP tool", {
          tool: "scb_get_category_values",
          durationMs: Date.now() - started,
          status: 200,
          objectType: parsed.data.objectType,
        });
        return jsonResult({
          objectType: envelope.objectType,
          category: parsed.data.category,
          items: envelope.items,
          raw: envelope.raw,
          values: envelope.raw,
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
      const started = Date.now();
      try {
        const count = await client.countCompanies(parsed.data.filters);
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
              filters: parsed.data.filters,
              source: SOURCE_LABEL,
            },
            parsed.data.filters,
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
      const started = Date.now();
      try {
        const { count, results, skippedFetch, countFromCache } = await client.searchCompanies(
          parsed.data.filters,
        );
        log.info("MCP tool", {
          tool: "scb_search_companies",
          durationMs: Date.now() - started,
          status: 200,
          count,
          ...(countFromCache ? { cacheHit: true } : {}),
        });
        return jsonResult(
          withFilterWarning(
            {
              count,
              returned: results.length,
              results,
              filters: parsed.data.filters,
              source: { provider: SOURCE_PROVIDER, registry: SOURCE_REGISTRY },
              ...(skippedFetch ? { skippedFetch: true } : {}),
              ...(countFromCache ? { countFromCache: true } : {}),
            },
            parsed.data.filters,
          ),
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
      const started = Date.now();
      try {
        const count = await client.countWorkplaces(parsed.data.filters);
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
              filters: parsed.data.filters,
              source: SOURCE_LABEL,
            },
            parsed.data.filters,
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
      const started = Date.now();
      try {
        const { count, results, skippedFetch, countFromCache } = await client.searchWorkplaces(
          parsed.data.filters,
        );
        log.info("MCP tool", {
          tool: "scb_search_workplaces",
          durationMs: Date.now() - started,
          status: 200,
          count,
          ...(countFromCache ? { cacheHit: true } : {}),
        });
        return jsonResult(
          withFilterWarning(
            {
              count,
              returned: results.length,
              results,
              filters: parsed.data.filters,
              source: { provider: SOURCE_PROVIDER, registry: SOURCE_REGISTRY },
              ...(skippedFetch ? { skippedFetch: true } : {}),
              ...(countFromCache ? { countFromCache: true } : {}),
            },
            parsed.data.filters,
          ),
        );
      } catch (error) {
        logToolError("scb_search_workplaces", started, error);
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
