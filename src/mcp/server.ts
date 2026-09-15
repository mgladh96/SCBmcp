import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
} from "../scb/schemas.js";
import { OPERATORS_VERIFY_NOTE, SCB_OPERATORS } from "../scb/operators.js";
import {
  countThenFetchPrompt,
  exploreSchemaPrompt,
  handleTooBroadPrompt,
  SERVER_INSTRUCTIONS,
} from "./instructions.js";
import {
  COMPILE_QUERY_DESCRIPTION,
  COUNT_THEN_FETCH_DESCRIPTION,
  COUNT_COMPANIES_DESCRIPTION,
  COUNT_WORKPLACES_DESCRIPTION,
  DISCOVER_CODES_DESCRIPTION,
  EXPLAIN_QUERY_DESCRIPTION,
  FILTER_HINTS_DESCRIPTION,
  GET_CATEGORY_VALUES_DESCRIPTION,
  LIST_CATEGORIES_DESCRIPTION,
  LIST_VARIABLES_DESCRIPTION,
  LOOKUP_CODES_DESCRIPTION,
  QUERY_DESCRIPTION,
  SCHEMA_SUMMARY_DESCRIPTION,
  SEARCH_COMPANIES_DESCRIPTION,
  SEARCH_WORKPLACES_DESCRIPTION,
} from "./tool-descriptions.js";
import { createToolHandlers, type ToolHandlers } from "./tools.js";

export const SERVER_NAME = "scb-foretagsregister";
export const SERVER_VERSION = "0.1.0";
export { SERVER_INSTRUCTIONS };

const objectTypePromptArg = z
  .enum(["company", "workplace"])
  .describe("company = JE (juridisk enhet), workplace = AE (arbetsställe)");

export function createMcpServer(handlers: ToolHandlers): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "scb_list_categories",
    {
      title: "Lista SCB-kategorier",
      description: LIST_CATEGORIES_DESCRIPTION,
      inputSchema: listCategoriesInputSchema.shape,
    },
    async (args) => handlers.scb_list_categories(args),
  );

  server.registerTool(
    "scb_get_category_values",
    {
      title: "Hämta SCB-kodtabell",
      description: GET_CATEGORY_VALUES_DESCRIPTION,
      inputSchema: getCategoryValuesInputSchema.shape,
    },
    async (args) => handlers.scb_get_category_values(args),
  );

  server.registerTool(
    "scb_list_variables",
    {
      title: "Lista SCB-variabler",
      description: LIST_VARIABLES_DESCRIPTION,
      inputSchema: listVariablesInputSchema.shape,
    },
    async (args) => handlers.scb_list_variables(args),
  );

  server.registerTool(
    "scb_count_companies",
    {
      title: "Räkna SCB-företag",
      description: COUNT_COMPANIES_DESCRIPTION,
      inputSchema: countCompaniesInputSchema.shape,
    },
    async (args) => handlers.scb_count_companies(args),
  );

  server.registerTool(
    "scb_search_companies",
    {
      title: "Hämta SCB-företag",
      description: SEARCH_COMPANIES_DESCRIPTION,
      inputSchema: searchCompaniesInputSchema.shape,
    },
    async (args) => handlers.scb_search_companies(args),
  );

  server.registerTool(
    "scb_count_workplaces",
    {
      title: "Räkna SCB-arbetsställen",
      description: COUNT_WORKPLACES_DESCRIPTION,
      inputSchema: countWorkplacesInputSchema.shape,
    },
    async (args) => handlers.scb_count_workplaces(args),
  );

  server.registerTool(
    "scb_search_workplaces",
    {
      title: "Hämta SCB-arbetsställen",
      description: SEARCH_WORKPLACES_DESCRIPTION,
      inputSchema: searchWorkplacesInputSchema.shape,
    },
    async (args) => handlers.scb_search_workplaces(args),
  );

  server.registerTool(
    "scb_explain_query",
    {
      title: "Förklara SCB-fråga (dry-run)",
      description: EXPLAIN_QUERY_DESCRIPTION,
      inputSchema: explainQueryInputSchema.shape,
    },
    async (args) => handlers.scb_explain_query(args),
  );

  server.registerTool(
    "scb_schema_summary",
    {
      title: "Kompakt SCB-schemasammanfattning",
      description: SCHEMA_SUMMARY_DESCRIPTION,
      inputSchema: schemaSummaryInputSchema.shape,
    },
    async (args) => handlers.scb_schema_summary(args),
  );

  server.registerTool(
    "scb_lookup_codes",
    {
      title: "Sök SCB-koder",
      description: LOOKUP_CODES_DESCRIPTION,
      inputSchema: lookupCodesInputSchema.shape,
    },
    async (args) => handlers.scb_lookup_codes(args),
  );

  server.registerTool(
    "scb_discover",
    {
      title: "Sök SCB-koder (alias)",
      description: DISCOVER_CODES_DESCRIPTION,
      inputSchema: lookupCodesInputSchema.shape,
    },
    async (args) => handlers.scb_discover(args),
  );

  server.registerTool(
    "scb_filter_hints",
    {
      title: "Filtertips per frågeklass",
      description: FILTER_HINTS_DESCRIPTION,
      inputSchema: filterHintsInputSchema.shape,
    },
    async (args) => handlers.scb_filter_hints(args),
  );

  server.registerTool(
    "scb_compile_query",
    {
      title: "Kompilera StructuredQuery till SCB-filter",
      description: COMPILE_QUERY_DESCRIPTION,
      inputSchema: compileQueryInputSchema.shape,
    },
    async (args) => handlers.scb_compile_query(args),
  );

  server.registerTool(
    "scb_query",
    {
      title: "StructuredQuery: räkna och hämta",
      description: QUERY_DESCRIPTION,
      inputSchema: countThenFetchInputSchema.shape,
    },
    async (args) => handlers.scb_query(args),
  );

  server.registerTool(
    "scb_count_then_fetch",
    {
      title: "Kompilera, räkna och hämta (alias för scb_query)",
      description: COUNT_THEN_FETCH_DESCRIPTION,
      inputSchema: countThenFetchInputSchema.shape,
    },
    async (args) => handlers.scb_count_then_fetch(args),
  );

  server.registerResource(
    "scb-operators",
    "scb://operators",
    {
      title: "SCB-operatorer",
      description: "Konservativ allowlist för variabel-operatorer.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "scb://operators",
          mimeType: "application/json",
          text: JSON.stringify({ operators: SCB_OPERATORS, note: OPERATORS_VERIFY_NOTE }, null, 2),
        },
      ],
    }),
  );

  server.registerPrompt(
    "scb_explore_schema",
    {
      title: "Utforska SCB-schema",
      description:
        "Hur agenten ska lista kategorier, kodtabeller och variabler för JE eller AE innan filtrering.",
      argsSchema: { objectType: objectTypePromptArg },
    },
    ({ objectType }) => ({
      description: "Utforska SCB-schema",
      messages: [
        {
          role: "user",
          content: { type: "text", text: exploreSchemaPrompt(objectType) },
        },
      ],
    }),
  );

  server.registerPrompt(
    "scb_count_then_fetch",
    {
      title: "Räkna sedan hämta",
      description: "Count-first mot SCB: 2000-tak, ingen paginering, återanvänd nylig count.",
      argsSchema: { objectType: objectTypePromptArg },
    },
    ({ objectType }) => ({
      description: "Räkna sedan hämta",
      messages: [
        {
          role: "user",
          content: { type: "text", text: countThenFetchPrompt(objectType) },
        },
      ],
    }),
  );

  server.registerPrompt(
    "scb_handle_too_broad",
    {
      title: "Hantera QUERY_TOO_BROAD",
      description: "Smalna JE/AE-filter utan paginering när count > 2000.",
      argsSchema: { objectType: objectTypePromptArg },
    },
    ({ objectType }) => ({
      description: "Hantera för bred fråga",
      messages: [
        {
          role: "user",
          content: { type: "text", text: handleTooBroadPrompt(objectType) },
        },
      ],
    }),
  );

  return server;
}

export { createToolHandlers };
