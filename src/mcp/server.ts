import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  countCompaniesInputSchema,
  countWorkplacesInputSchema,
  getCategoryValuesInputSchema,
  listCategoriesInputSchema,
  listVariablesInputSchema,
  searchCompaniesInputSchema,
  searchWorkplacesInputSchema,
} from "../scb/schemas.js";
import {
  countThenFetchPrompt,
  exploreSchemaPrompt,
  handleTooBroadPrompt,
  SERVER_INSTRUCTIONS,
} from "./instructions.js";
import {
  COUNT_COMPANIES_DESCRIPTION,
  COUNT_WORKPLACES_DESCRIPTION,
  GET_CATEGORY_VALUES_DESCRIPTION,
  LIST_CATEGORIES_DESCRIPTION,
  LIST_VARIABLES_DESCRIPTION,
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
