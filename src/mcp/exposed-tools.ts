/** Every tool `createMcpServer` can register. Keep this in sync with `server.ts`. */
export const MCP_TOOL_NAMES = [
  "scb_list_categories",
  "scb_get_category_values",
  "scb_list_variables",
  "scb_count_companies",
  "scb_search_companies",
  "scb_count_workplaces",
  "scb_search_workplaces",
  "scb_explain_query",
  "scb_schema_summary",
  "scb_lookup_codes",
  "scb_discover",
  "scb_filter_hints",
  "scb_compile_query",
  "scb_query",
  "scb_count_then_fetch",
  "scb_find_company",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/**
 * Read-only company lookup for a voice agent.
 * `scb_find_company` searches by name and/or organisation number and returns
 * the company record (that response is the detail lookup).
 */
export const VOICE_AGENT_TOOL_NAMES = ["scb_find_company"] as const satisfies readonly McpToolName[];

const KNOWN_TOOLS = new Set<string>(MCP_TOOL_NAMES);

export function parseExposedTools(
  raw: string | undefined,
): { tools?: readonly string[]; error?: string } {
  const value = raw?.trim();
  if (!value) {
    return {};
  }
  const preset = value.toLowerCase();
  const names =
    preset === "voice" || preset === "voice-lookup"
      ? [...VOICE_AGENT_TOOL_NAMES]
      : value
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
  if (names.length === 0) {
    return { error: "MCP_EXPOSED_TOOLS is empty." };
  }
  const unknown = [...new Set(names.filter((name) => !KNOWN_TOOLS.has(name)))];
  if (unknown.length > 0) {
    return {
      error: `Unknown MCP_EXPOSED_TOOLS: ${unknown.join(", ")}. Known tools: ${MCP_TOOL_NAMES.join(", ")}. Preset: voice.`,
    };
  }
  return { tools: [...new Set(names)] };
}
