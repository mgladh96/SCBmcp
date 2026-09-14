import { ScbError } from "../domain/errors.js";
import { createLogger } from "../log.js";
import type { ScbClient } from "../scb/client.js";
import {
  countCompaniesInputSchema,
  countWorkplacesInputSchema,
  getCategoryValuesInputSchema,
  listCategoriesInputSchema,
  listVariablesInputSchema,
  searchCompaniesInputSchema,
  searchWorkplacesInputSchema,
} from "../scb/schemas.js";
import { SOURCE_LABEL, SOURCE_PROVIDER, SOURCE_REGISTRY } from "../scb/types.js";

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
          details: {},
        };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

export function createToolHandlers(client: ScbClient, log = createLogger()) {
  return {
    async scb_list_categories(input: unknown): Promise<ToolResult> {
      const parsed = listCategoriesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(
          new ScbError("SCB_INVALID_QUERY", "Invalid input for scb_list_categories.", false, {
            issues: parsed.error.flatten(),
          }),
        );
      }
      const started = Date.now();
      try {
        const categories = await client.listCategories(
          parsed.data.objectType,
          parsed.data.includeCodeTables ?? false,
        );
        log.info("MCP tool", {
          tool: "scb_list_categories",
          durationMs: Date.now() - started,
          status: 200,
          objectType: parsed.data.objectType,
        });
        return jsonResult({
          objectType: parsed.data.objectType,
          includeCodeTables: parsed.data.includeCodeTables ?? false,
          categories,
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
        return errorResult(
          new ScbError("SCB_INVALID_QUERY", "Invalid input for scb_get_category_values.", false, {
            issues: parsed.error.flatten(),
          }),
        );
      }
      const started = Date.now();
      try {
        const values = await client.getCategoryValues(parsed.data.objectType, parsed.data.category);
        log.info("MCP tool", {
          tool: "scb_get_category_values",
          durationMs: Date.now() - started,
          status: 200,
          objectType: parsed.data.objectType,
        });
        return jsonResult({
          objectType: parsed.data.objectType,
          category: parsed.data.category,
          values,
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
        return errorResult(
          new ScbError("SCB_INVALID_QUERY", "Invalid input for scb_list_variables.", false, {
            issues: parsed.error.flatten(),
          }),
        );
      }
      const started = Date.now();
      try {
        const variables = await client.listVariables(
          parsed.data.objectType,
          parsed.data.includeValueMetadata ?? false,
        );
        log.info("MCP tool", {
          tool: "scb_list_variables",
          durationMs: Date.now() - started,
          status: 200,
          objectType: parsed.data.objectType,
        });
        return jsonResult({
          objectType: parsed.data.objectType,
          includeValueMetadata: parsed.data.includeValueMetadata ?? false,
          variables,
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
        return errorResult(
          new ScbError("SCB_INVALID_QUERY", "Invalid input for scb_count_companies.", false, {
            issues: parsed.error.flatten(),
          }),
        );
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
        return jsonResult({
          count,
          objectType: "company",
          filters: parsed.data.filters,
          source: SOURCE_LABEL,
        });
      } catch (error) {
        logToolError("scb_count_companies", started, error);
        return errorResult(error);
      }
    },

    async scb_search_companies(input: unknown): Promise<ToolResult> {
      const parsed = searchCompaniesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(
          new ScbError("SCB_INVALID_QUERY", "Invalid input for scb_search_companies.", false, {
            issues: parsed.error.flatten(),
          }),
        );
      }
      const started = Date.now();
      try {
        const { count, results } = await client.searchCompanies(parsed.data.filters);
        log.info("MCP tool", {
          tool: "scb_search_companies",
          durationMs: Date.now() - started,
          status: 200,
          count,
        });
        return jsonResult({
          count,
          returned: results.length,
          results,
          filters: parsed.data.filters,
          source: { provider: SOURCE_PROVIDER, registry: SOURCE_REGISTRY },
        });
      } catch (error) {
        logToolError("scb_search_companies", started, error);
        return errorResult(error);
      }
    },

    async scb_count_workplaces(input: unknown): Promise<ToolResult> {
      const parsed = countWorkplacesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(
          new ScbError("SCB_INVALID_QUERY", "Invalid input for scb_count_workplaces.", false, {
            issues: parsed.error.flatten(),
          }),
        );
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
        return jsonResult({
          count,
          objectType: "workplace",
          filters: parsed.data.filters,
          source: SOURCE_LABEL,
        });
      } catch (error) {
        logToolError("scb_count_workplaces", started, error);
        return errorResult(error);
      }
    },

    async scb_search_workplaces(input: unknown): Promise<ToolResult> {
      const parsed = searchWorkplacesInputSchema.safeParse(input);
      if (!parsed.success) {
        return errorResult(
          new ScbError("SCB_INVALID_QUERY", "Invalid input for scb_search_workplaces.", false, {
            issues: parsed.error.flatten(),
          }),
        );
      }
      const started = Date.now();
      try {
        const { count, results } = await client.searchWorkplaces(parsed.data.filters);
        log.info("MCP tool", {
          tool: "scb_search_workplaces",
          durationMs: Date.now() - started,
          status: 200,
          count,
        });
        return jsonResult({
          count,
          returned: results.length,
          results,
          filters: parsed.data.filters,
          source: { provider: SOURCE_PROVIDER, registry: SOURCE_REGISTRY },
        });
      } catch (error) {
        logToolError("scb_search_workplaces", started, error);
        return errorResult(error);
      }
    },
  };

  function logToolError(tool: string, started: number, error: unknown): void {
    log.error("MCP tool failed", {
      tool,
      durationMs: Date.now() - started,
      errorCode: error instanceof ScbError ? error.code : "SCB_UNAVAILABLE",
    });
  }
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;
