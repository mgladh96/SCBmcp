import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  countCompaniesInputSchema,
  countWorkplacesInputSchema,
  getCategoryValuesInputSchema,
  listCategoriesInputSchema,
  listVariablesInputSchema,
  searchCompaniesInputSchema,
  searchWorkplacesInputSchema,
} from "../scb/schemas.js";
import { createToolHandlers, type ToolHandlers } from "./tools.js";

export const SERVER_NAME = "scb-foretagsregister";
export const SERVER_VERSION = "0.1.0";

export function createMcpServer(handlers: ToolHandlers): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "scb_list_categories",
    {
      title: "List SCB categories",
      description:
        "Return SCB categories available to the configured account for companies (JE) or workplaces (AE). Set includeCodeTables to also fetch code tables.",
      inputSchema: listCategoriesInputSchema.shape,
    },
    async (args) => handlers.scb_list_categories(args),
  );

  server.registerTool(
    "scb_get_category_values",
    {
      title: "Get SCB category values",
      description:
        "Get the SCB code table for one category on company (JE) or workplace (AE). Use the category name returned by scb_list_categories.",
      inputSchema: getCategoryValuesInputSchema.shape,
    },
    async (args) => handlers.scb_get_category_values(args),
  );

  server.registerTool(
    "scb_list_variables",
    {
      title: "List SCB variables",
      description:
        "Return SCB variables available to the configured account for companies (JE) or workplaces (AE). Variables are free-text filters, not code tables. Set includeValueMetadata for value-domain metadata.",
      inputSchema: listVariablesInputSchema.shape,
    },
    async (args) => handlers.scb_list_variables(args),
  );

  server.registerTool(
    "scb_count_companies",
    {
      title: "Count SCB companies",
      description:
        "Count juridiska enheter (JE) matching SCB category and variable filters. Always count before scb_search_companies. SCB returns at most 2000 rows and does not paginate.",
      inputSchema: countCompaniesInputSchema.shape,
    },
    async (args) => handlers.scb_count_companies(args),
  );

  server.registerTool(
    "scb_search_companies",
    {
      title: "Search SCB companies",
      description:
        "Retrieve juridiska enheter (JE) matching SCB filters. Counts first. If count > 2000, returns QUERY_TOO_BROAD. Preserve SCB field names, including Reklam when present.",
      inputSchema: searchCompaniesInputSchema.shape,
    },
    async (args) => handlers.scb_search_companies(args),
  );

  server.registerTool(
    "scb_count_workplaces",
    {
      title: "Count SCB workplaces",
      description:
        "Count arbetsställen (AE) matching SCB category and variable filters. Always count before scb_search_workplaces. SCB returns at most 2000 rows and does not paginate.",
      inputSchema: countWorkplacesInputSchema.shape,
    },
    async (args) => handlers.scb_count_workplaces(args),
  );

  server.registerTool(
    "scb_search_workplaces",
    {
      title: "Search SCB workplaces",
      description:
        "Retrieve arbetsställen (AE) matching SCB filters. Counts first. If count > 2000, returns QUERY_TOO_BROAD. Preserve SCB field names, including Reklam when present.",
      inputSchema: searchWorkplacesInputSchema.shape,
    },
    async (args) => handlers.scb_search_workplaces(args),
  );

  return server;
}

export { createToolHandlers };
