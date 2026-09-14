import {
  classifyCategoryKind,
  classifyVariableKind,
  counterpartOnCompany,
  counterpartOnWorkplace,
  categorySerialization,
  extractCodeRows,
  filterHintsFor,
  isCheapSampleCategory,
  MAX_SAMPLE_VALUES,
  schemaWarnings,
  typicalOperators,
  type CategoryKind,
  type CategorySerialization,
  type FilterHint,
  type VariableKind,
} from "../domain/catalog.js";
import {
  OPERATORS_VERIFY_NOTE,
  SCB_OPERATORS,
  type ScbOperator,
  type ScbOperatorInfo,
} from "./operators.js";
import { extractMetadataItems } from "./payload.js";
import { layoutFor, type ObjectType, type ScbLayout } from "./types.js";

export type SchemaSummaryCategory = {
  name: string;
  kind: CategoryKind;
  serialization: CategorySerialization;
  valueCount?: number;
  sampleValues?: Array<{ code: string; label: string }>;
  counterpartOnWorkplace?: string;
  counterpartOnCompany?: string;
};

export type SchemaSummaryVariable = {
  name: string;
  kind: VariableKind;
  typicalOperators: ScbOperator[];
};

export type SchemaSummary = {
  objectType: ObjectType;
  layout: ScbLayout;
  categories: SchemaSummaryCategory[];
  variables: SchemaSummaryVariable[];
  operators: ScbOperatorInfo[];
  filterHints: FilterHint[];
  warnings: string[];
  operatorsNote: string;
};

export function compactSchemaSummary(
  objectType: ObjectType,
  categoriesRaw: unknown,
  variablesRaw: unknown,
  codeTables: Map<string, unknown> = new Map(),
): SchemaSummary {
  const categoryNames = extractMetadataItems(categoriesRaw)
    .map((item) => item.name)
    .filter((name) => name.length > 0);
  const variableNames = extractMetadataItems(variablesRaw)
    .map((item) => item.name)
    .filter((name) => name.length > 0);

  const categories: SchemaSummaryCategory[] = categoryNames.map((name) => {
    const kind = classifyCategoryKind(name);
    const entry: SchemaSummaryCategory = {
      name,
      kind,
      serialization: categorySerialization(name),
    };
    const workplace = counterpartOnWorkplace(name);
    if (workplace) {
      entry.counterpartOnWorkplace = workplace;
    }
    const company = counterpartOnCompany(name);
    if (company) {
      entry.counterpartOnCompany = company;
    }
    const table = codeTables.get(name);
    if (table !== undefined && kind !== "industry") {
      const rows = extractCodeRows(table);
      entry.valueCount = rows.length;
      entry.sampleValues = rows.slice(0, MAX_SAMPLE_VALUES).map((row) => ({
        code: row.code,
        label: row.label,
      }));
    } else if (table !== undefined && kind === "industry") {
      entry.valueCount = extractCodeRows(table).length;
    }
    return entry;
  });

  const variables: SchemaSummaryVariable[] = variableNames.map((name) => ({
    name,
    kind: classifyVariableKind(name),
    typicalOperators: typicalOperators(name),
  }));

  return {
    objectType,
    layout: layoutFor(objectType),
    categories,
    variables,
    operators: SCB_OPERATORS,
    filterHints: filterHintsFor(objectType, undefined, { categoryNames, variableNames }),
    warnings: schemaWarnings(objectType),
    operatorsNote: OPERATORS_VERIFY_NOTE,
  };
}

export function cheapSampleCategoryNames(categoriesRaw: unknown): string[] {
  return extractMetadataItems(categoriesRaw)
    .map((item) => item.name)
    .filter((name) => name.length > 0 && isCheapSampleCategory(name));
}
