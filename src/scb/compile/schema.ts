import { z } from "zod";
import { scbFiltersSchema } from "../schemas.js";
import { DEFAULT_SEARCH_MAX_ROWS, MAX_SEARCH_MAX_ROWS } from "../types.js";

export const objectTypeSchema = z
  .enum(["company", "workplace"])
  .describe("Obligatorisk. company = JE, workplace = AE. Agenten äger valet; servern gissar inte.");

export const industrySlotSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .describe("Bransch/SNI-söksträng mot SCB-kodtabellen, t.ex. bygg. Inte en fri NL-fråga."),
    level: z
      .number()
      .int()
      .positive()
      .max(5)
      .optional()
      .describe(
        "SNI-nivå. SCB Bransch kräver Branschniva 1–3 (bokstav→1, 2 siffror→2, 3+→3). Utelämnad: kompilatorn sätter giltig nivå. Svenska bygg/byggverksamhet → 41/42/43 (eller F). 2-siffrig bransch * skickas utan Branschniva.",
      ),
  })
  .describe("Alltid objekt { query, level? } — aldrig en bar sträng.");

export const geographySlotSchema = z.object({
  type: z.enum(["county", "municipality", "aregion"]),
  value: z.string().min(1).describe("Ortsnamn eller SCB-kod, t.ex. Jämtland eller 23."),
});

export const employeesSlotSchema = z.object({
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
});

export const semanticFieldsSchema = z
  .array(z.string().min(1))
  .describe(
    'Semantiska fält-id:n, t.ex. ["name","organizationNumber","municipality","employeeCount"]. Inte SCB-namn som "OrgNr (10 siffror)" eller "SätesKommun".',
  );

export const structuredQuerySchema = z.object({
  objectType: objectTypeSchema,
  industry: industrySlotSchema.optional(),
  geography: geographySlotSchema.optional(),
  employees: employeesSlotSchema.optional(),
  status: z
    .enum(["active", "any"])
    .optional()
    .default("active")
    .describe('Standard "active" (verksam). "any" utelämnar statusfilter.'),
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_MAX_ROWS)
    .optional()
    .describe(`Max rader i hämtningssvar (standard ${DEFAULT_SEARCH_MAX_ROWS}).`),
  fields: semanticFieldsSchema.optional(),
});

export type StructuredQuery = z.infer<typeof structuredQuerySchema>;
export type StructuredQueryInput = z.input<typeof structuredQuerySchema>;

export const compileQueryInputSchema = structuredQuerySchema;

export const compiledFetchSchema = z.object({
  objectType: objectTypeSchema,
  filters: scbFiltersSchema.describe("Redan kompilerade SCB-filter (categories/variables)."),
  maxRows: structuredQuerySchema.shape.maxRows,
  fields: semanticFieldsSchema.optional(),
});

export const countThenFetchInputSchema = structuredQuerySchema.extend({
  filters: scbFiltersSchema
    .optional()
    .describe(
      "Redan kompilerade SCB-filter. Om filters finns används de som de är och semantiska slotar (industry/geography/employees/status) ignoreras. Coverage beräknas bara från StructuredQuery (utan filters).",
    ),
});

export type CountThenFetchInput = z.infer<typeof countThenFetchInputSchema>;

export function hasCompiledFilters(
  input: CountThenFetchInput,
): input is CountThenFetchInput & { filters: NonNullable<CountThenFetchInput["filters"]> } {
  return input.filters !== undefined;
}
