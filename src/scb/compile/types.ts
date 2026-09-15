import type { ScbClient } from "../client.js";
import type { ScbFilters } from "../schemas.js";
import type { ObjectType, ScbLayout } from "../types.js";

export type CoverageRelation = "exact" | "superset" | "subset" | "partial" | "unrepresentable";

export type CoverageConstraint = "geography" | "industry" | "employees" | "status" | "fields";

export type CoverageEntry = {
  constraint: CoverageConstraint;
  requested: unknown;
  applied: unknown;
  relation: CoverageRelation;
  exact: boolean;
  message: string;
};

export type UnresolvedConstraint = {
  constraint: CoverageConstraint;
  requested: unknown;
  reason: string;
};

export type ResolvedCode = {
  code: string;
  label: string;
};

export type ResolvedGeography = {
  category: string;
  type: "county" | "municipality" | "aregion";
  codes: ResolvedCode[];
};

export type ResolvedIndustry = {
  category: string;
  codes: ResolvedCode[];
  branchLevel?: number;
};

export type ResolvedEmployeeBand = {
  code: string;
  label: string;
  min: number;
  /** null = no upper bound (open-ended SCB class). JSON-safe; never Infinity. */
  max: number | null;
};

export type ResolvedEmployees = {
  category: string;
  bands: ResolvedEmployeeBand[];
};

export type ResolvedStatus = {
  category: string;
  value: string;
  label: string;
};

/**
 * Semantic field id → SCB names for this objectType (live hamta keys first,
 * then catalog variables/categories). count_then_fetch aliases row keys via this map.
 */
export type ResolvedFields = Record<string, string[]>;

export type ResolvedMappings = {
  layout: ScbLayout;
  geography?: ResolvedGeography;
  industry?: ResolvedIndustry;
  employees?: ResolvedEmployees;
  status?: ResolvedStatus;
  fields: ResolvedFields;
};

export type CompileResult = {
  ok: boolean;
  objectType: ObjectType;
  filters: ScbFilters;
  resolved: ResolvedMappings;
  coverage: CoverageEntry[];
  warnings: string[];
  unresolved: UnresolvedConstraint[];
};

export type CompileMetadataSource = Pick<
  ScbClient,
  "listCategories" | "listVariables" | "getCategoryValues" | "lookupCodes"
>;

export const DEFAULT_SEMANTIC_FIELDS = [
  "name",
  "organizationNumber",
  "municipality",
  "employeeCount",
] as const;

export type SemanticFieldId = (typeof DEFAULT_SEMANTIC_FIELDS)[number] | (string & {});
