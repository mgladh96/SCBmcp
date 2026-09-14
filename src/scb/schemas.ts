import { z } from "zod";

export const objectTypeSchema = z.enum(["company", "workplace"]);

export const categoryFilterSchema = z.object({
  category: z.string().min(1),
  values: z.array(z.string()).min(1),
  branchLevel: z.number().int().positive().optional(),
});

export const variableFilterSchema = z.object({
  variable: z.string().min(1),
  operator: z.string().min(1),
  value: z.string().optional(),
  value2: z.string().optional(),
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
