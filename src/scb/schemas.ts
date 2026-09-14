import { z } from "zod";
import { SCB_OPERATOR_NAMES } from "./operators.js";
import {
  DEFAULT_CATEGORY_VALUES_LIMIT,
  DEFAULT_LOOKUP_LIMIT,
  type QuestionClass,
} from "../domain/catalog.js";

export const objectTypeSchema = z.enum(["company", "workplace"]);

const scbOperatorEnum = z.enum(SCB_OPERATOR_NAMES);

export const categoryFilterSchema = z.object({
  category: z
    .string()
    .min(1)
    .describe("Exakt SCB-kategorinamn från scb_schema_summary / scb_list_categories."),
  values: z.array(z.string()).min(1).describe("Kodvärden från kodtabellen, inte svenska etiketter."),
  branchLevel: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "SCB Branschniva. Bara meningsfullt på bransch/SNI-kategorier (2- vs 5-siffernivå m.m.). Ignoreras på toppnivåstatus. Varning om det sätts på icke-bransch.",
    ),
});

export const variableFilterSchema = z.object({
  variable: z.string().min(1).describe("Exakt SCB-variabelnamn från scb_list_variables."),
  operator: scbOperatorEnum.describe(
    "SCB-operator (svenska namn). Konservativ allowlist: Innehaller, ArLikaMed, BorjarPa, Mellan, FranOchMed, TillOchMed, Finns, FinnsInte. Inte Contains/Equals. Verifiera mot /help/exampleJe.",
  ),
  value: z.string().optional().describe("Varde1. Krävs för de flesta operatorer."),
  value2: z.string().optional().describe("Varde2. Används av intervalloperatorn Mellan."),
});

export const scbFiltersSchema = z.object({
  categories: z.array(categoryFilterSchema).default([]),
  variables: z.array(variableFilterSchema).default([]),
});

export type ScbFilters = z.infer<typeof scbFiltersSchema>;

export function isUnboundedFilters(filters: ScbFilters): boolean {
  return filters.categories.length === 0 && filters.variables.length === 0;
}

const bypassCacheSchema = z.boolean().optional();

export const listCategoriesInputSchema = z.object({
  objectType: objectTypeSchema,
  includeCodeTables: z.boolean().optional(),
  bypassCache: bypassCacheSchema,
});

export const getCategoryValuesInputSchema = z.object({
  objectType: objectTypeSchema,
  category: z.string().min(1),
  query: z
    .string()
    .optional()
    .describe("Filtrera kodtabellen på kod eller etikett (t.ex. Gävleborg, verksam, bygg)."),
  limit: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe(
      `Max rader i svaret. Standard ${DEFAULT_CATEGORY_VALUES_LIMIT}. 0 = alla (samma som includeAll). Full SNI-dump bara vid explicit begäran.`,
    ),
  includeAll: z
    .boolean()
    .optional()
    .describe("true returnerar hela tabellen. Använd inte för SNI/bransch."),
  bypassCache: bypassCacheSchema,
});

export const listVariablesInputSchema = z.object({
  objectType: objectTypeSchema,
  includeValueMetadata: z.boolean().optional(),
  bypassCache: bypassCacheSchema,
});

export const countCompaniesInputSchema = z.object({
  filters: scbFiltersSchema,
});

export const searchCompaniesInputSchema = z.object({
  filters: scbFiltersSchema,
});

export const countWorkplacesInputSchema = z.object({
  filters: scbFiltersSchema,
});

export const searchWorkplacesInputSchema = z.object({
  filters: scbFiltersSchema,
});

export const schemaSummaryInputSchema = z.object({
  objectType: objectTypeSchema,
  bypassCache: bypassCacheSchema,
});

export const lookupCodesInputSchema = z.object({
  objectType: objectTypeSchema,
  query: z.string().min(1).describe("Söksträng mot kod och etikett, t.ex. Gävleborg, bygg, 10-49, verksam."),
  category: z.string().min(1).optional().describe("Begränsa till en SCB-kategori. Utan kategori söks status, geografi, storlek och bransch."),
  limit: z.number().int().positive().max(100).optional().describe(`Max träffar. Standard ${DEFAULT_LOOKUP_LIMIT}.`),
  bypassCache: bypassCacheSchema,
});

export const QUESTION_CLASS_VALUES = [
  "companies_in_region",
  "workplaces_in_region",
  "industry_and_place",
  "name_contains",
  "employee_size",
  "organization_number",
] as const satisfies readonly QuestionClass[];

export const filterHintsInputSchema = z.object({
  questionClass: z.enum(QUESTION_CLASS_VALUES).optional(),
  objectType: objectTypeSchema.optional(),
});
