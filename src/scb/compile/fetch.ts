import { collectQueryWarnings } from "../../domain/query-warnings.js";
import { queryTooBroad, ScbError } from "../../domain/errors.js";
import type { ScbClient } from "../client.js";
import { layoutFor } from "../types.js";
import { SOURCE_PROVIDER, SOURCE_REGISTRY, DEFAULT_SEARCH_MAX_ROWS, MAX_RESULTS } from "../types.js";
import { compileStructuredQuery } from "./compile.js";
import { projectToSemanticFields, resolveSemanticFields, selectVariablesForFetch } from "./fields.js";
import { extractMetadataItems } from "../payload.js";
import { hasCompiledFilters, type CountThenFetchInput } from "./schema.js";
import type { CompileResult, CoverageEntry, ResolvedMappings } from "./types.js";
import { DEFAULT_SEMANTIC_FIELDS } from "./types.js";

export type CountThenFetchSuccess = {
  ok: true;
  objectType: CountThenFetchInput["objectType"];
  count: number;
  fetched: number;
  returned: number;
  results: Record<string, unknown>[];
  filters: CompileResult["filters"];
  resolved: ResolvedMappings;
  coverage: CoverageEntry[];
  warnings: string[];
  source: { provider: string; registry: string } | string;
  projectedFields: string[];
  maxRows: number;
  skippedFetch?: boolean;
  countFromCache?: boolean;
  omittedByMaxRows?: number;
};

export async function countThenFetch(
  client: ScbClient,
  input: CountThenFetchInput,
): Promise<CountThenFetchSuccess> {
  const compiled = hasCompiledFilters(input)
    ? await compiledPassthrough(client, input)
    : await compileStructuredQuery(input, client);

  if (!hasCompiledFilters(input) && !compiled.ok) {
    throw compileFailedError(compiled);
  }

  const objectType = compiled.objectType;
  const filters = compiled.filters;
  const maxRows = input.maxRows ?? DEFAULT_SEARCH_MAX_ROWS;
  const warnings = unique([
    ...compiled.warnings,
    ...collectQueryWarnings(objectType, filters),
  ]);

  const count =
    objectType === "workplace"
      ? await client.countWorkplaces(filters)
      : await client.countCompanies(filters);

  if (count === 0) {
    throw new ScbError(
      "SCB_NO_MATCHES",
      "Inga träffar för den kompilerade frågan.",
      false,
      {
        count: 0,
        objectType,
        filters,
        coverage: compiled.coverage,
        resolved: compiled.resolved,
        origin: "count_then_fetch",
      },
      {
        nextAction: "retry_modified",
        nextTools: ["scb_compile_query", "scb_lookup_codes", "scb_schema_summary"],
      },
    );
  }

  if (count > MAX_RESULTS) {
    throw withCompileContext(
      queryTooBroad(count, MAX_RESULTS, {
        objectType,
        layout: layoutFor(objectType),
        appliedFilters: filters,
        catalogCategoryNames: client.cachedCategoryNames(objectType),
        catalogVariableNames: client.cachedVariableNames(objectType),
      }),
      compiled,
    );
  }

  const categoryNames = namesFrom(await client.listCategories(objectType, false));
  const variableNames = namesFrom(await client.listVariables(objectType, false));
  const selectVariables = selectVariablesForFetch(
    compiled.resolved.fields,
    variableNames,
    categoryNames,
    filters.variables,
  );

  let searchResult;
  try {
    searchResult =
      objectType === "workplace"
        ? await client.searchWorkplaces(filters, { selectVariables })
        : await client.searchCompanies(filters, { selectVariables });
  } catch (error) {
    throw withCompileContext(error, compiled);
  }

  const projected = projectToSemanticFields(
    searchResult.results,
    objectType,
    compiled.resolved.fields,
    maxRows,
  );

  const extraWarnings = [...warnings];
  if (selectVariables.length > 0) {
    extraWarnings.push(
      `Hämtning begärde SCB-variabler (${selectVariables.map((item) => item.variable).join(", ")}) med operator Finns så att name/organizationNumber följer med. Kategorier som Säteskommun/Anställda räcker som filter.`,
    );
  }
  if (!projected.reklamPreserved) {
    extraWarnings.push("Reklam saknades i SCB-raderna; fältet strippas aldrig av MCP.");
  }
  if (projected.omittedByMaxRows > 0) {
    extraWarnings.push(
      `MCP-svaret trunkerades till maxRows=${projected.maxRows} (SCB hämtade ${projected.fetched} rader).`,
    );
  }

  const payload: CountThenFetchSuccess = {
    ok: true,
    objectType,
    count: searchResult.count,
    fetched: projected.fetched,
    returned: projected.returned,
    results: projected.results,
    filters,
    resolved: compiled.resolved,
    coverage: compiled.coverage,
    warnings: extraWarnings,
    source: { provider: SOURCE_PROVIDER, registry: SOURCE_REGISTRY },
    projectedFields: projected.projectedFields,
    maxRows: projected.maxRows,
  };
  if (projected.omittedByMaxRows > 0) {
    payload.omittedByMaxRows = projected.omittedByMaxRows;
  }
  if (searchResult.skippedFetch) {
    payload.skippedFetch = true;
  }
  if (searchResult.countFromCache) {
    payload.countFromCache = true;
  }
  return payload;
}

async function compiledPassthrough(
  client: ScbClient,
  input: CountThenFetchInput & { filters: NonNullable<CountThenFetchInput["filters"]> },
): Promise<CompileResult> {
  const objectType = input.objectType;
  const categoryNames = namesFrom(await client.listCategories(objectType, false));
  const variableNames = namesFrom(await client.listVariables(objectType, false));
  const { fields, missing } = resolveSemanticFields(
    objectType,
    input.fields,
    unique([...categoryNames, ...variableNames]),
  );
  const warnings = [
    "filters användes som redan kompilerade SCB-filter; coverage från semantiska slotar beräknades inte.",
  ];
  if (missing.length > 0) {
    warnings.push(`Fält utan katalogträff: ${missing.join(", ")}.`);
  }
  if (input.industry !== undefined || input.geography !== undefined || input.employees !== undefined) {
    warnings.push(
      "Semantiska slotar ignoreras när filters är satt. Skicka StructuredQuery utan filters för coverage.",
    );
  }
  return {
    ok: true,
    objectType,
    filters: input.filters,
    resolved: { layout: objectType === "workplace" ? "ae" : "je", fields },
    coverage: [
      {
        constraint: "fields",
        requested: input.fields ?? [...DEFAULT_SEMANTIC_FIELDS],
        applied: fields,
        relation: missing.length === 0 ? "exact" : "partial",
        exact: missing.length === 0,
        message: "Kompilerad filterväg: coverage för industry/geography/employees saknas.",
      },
    ],
    warnings,
    unresolved: [],
  };
}

export function compileFailedError(compiled: CompileResult): ScbError {
  const unrepresentable = compiled.coverage.filter((entry) => entry.relation === "unrepresentable");
  const message =
    compiled.unresolved[0]?.reason ??
    unrepresentable[0]?.message ??
    "StructuredQuery kunde inte kompileras till SCB-filter.";
  return new ScbError(
    "SCB_INVALID_QUERY",
    message,
    false,
    {
      origin: "compile",
      objectType: compiled.objectType,
      coverage: compiled.coverage,
      resolved: compiled.resolved,
      unresolved: compiled.unresolved,
      filters: compiled.filters,
      warnings: compiled.warnings,
    },
    {
      nextAction: "retry_modified",
      nextTools: ["scb_compile_query", "scb_lookup_codes", "scb_schema_summary"],
    },
  );
}

export function withCompileContext(error: unknown, compiled: CompileResult): unknown {
  if (!(error instanceof ScbError)) {
    return error;
  }
  error.details.coverage = compiled.coverage;
  error.details.resolved = compiled.resolved;
  error.details.objectType = compiled.objectType;
  error.details.filters = compiled.filters;
  return error;
}

function namesFrom(raw: unknown): string[] {
  return extractMetadataItems(raw)
    .map((item) => item.name)
    .filter((name) => name.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
