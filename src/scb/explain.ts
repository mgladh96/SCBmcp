import { missingStatusWarning, collectQueryWarnings } from "../domain/query-warnings.js";
import { countPath, searchPath } from "./endpoints.js";
import { normalizeIdentityInFilters } from "./identity.js";
import { validateVariableOperators, type OperatorIssue } from "./operators.js";
import {
  AE_STATUS_LIVE_CONFIRM_NOTE,
  aeStatusTopLevelEnabled,
  toScbQueryBody,
  topLevelCategoriesFor,
} from "./payload.js";
import type { ScbFilters } from "./schemas.js";
import { layoutFor, SOURCE_LABEL, type ObjectType, type ScbLayout } from "./types.js";

export type ExplainQueryResult = {
  objectType: ObjectType;
  layout: ScbLayout;
  endpoints: { count: string; fetch: string };
  serializedBody: unknown;
  dryRun: true;
  filters: ScbFilters;
  warnings: string[];
  operatorValidation: { ok: boolean; issues: OperatorIssue[] };
  identity: {
    ok: boolean;
    personnummerLike: boolean;
    error?: string;
    changes: Array<{ variable: string; fromLength: number; toLength: number }>;
  };
  serialization: {
    topLevelCategories: string[];
    aeStatusTopLevel: boolean;
    aeStatusNote?: string;
  };
  source: string;
};

export function explainQuery(objectType: ObjectType, filters: ScbFilters): ExplainQueryResult {
  const layout = layoutFor(objectType);
  const identity = normalizeIdentityInFilters(filters, objectType);
  const prepared = identity.error ? filters : identity.filters;
  const operatorIssues = validateVariableOperators(prepared.variables);
  const warnings = collectQueryWarnings(objectType, prepared);
  const missingStatus = missingStatusWarning(objectType, prepared);
  if (missingStatus) {
    warnings.push(missingStatus);
  }
  warnings.push(...identity.warnings);
  if (identity.error) {
    warnings.push(identity.error);
  }
  for (const issue of operatorIssues) {
    warnings.push(issue.message);
  }
  const topLevel = [...topLevelCategoriesFor(layout)];
  const serialization: ExplainQueryResult["serialization"] = {
    topLevelCategories: topLevel,
    aeStatusTopLevel: objectType === "workplace" && aeStatusTopLevelEnabled(),
  };
  if (objectType === "workplace") {
    serialization.aeStatusNote = AE_STATUS_LIVE_CONFIRM_NOTE;
  }

  const identityBlock: ExplainQueryResult["identity"] = {
    ok: identity.error === undefined,
    personnummerLike: identity.personnummerLike,
    changes: identity.changes.map((item) => ({
      variable: item.variable,
      fromLength: item.fromLength,
      toLength: item.toLength,
    })),
  };
  if (identity.error) {
    identityBlock.error = identity.error;
  }

  return {
    objectType,
    layout,
    endpoints: {
      count: countPath(layout),
      fetch: searchPath(layout),
    },
    serializedBody: toScbQueryBody(prepared, layout),
    dryRun: true,
    filters: prepared,
    warnings,
    operatorValidation: { ok: operatorIssues.length === 0, issues: operatorIssues },
    identity: identityBlock,
    serialization,
    source: SOURCE_LABEL,
  };
}
