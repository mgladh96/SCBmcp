import { layoutHint, nearestNames } from "./catalog.js";
import {
  candidateNarrowingDimensions,
  narrowingCountTools,
} from "./narrowing.js";
import { SCB_OPERATOR_NAMES } from "../scb/operators.js";

export type ScbNextAction = "retry_same" | "retry_modified" | "abort_unanswerable";

export type ScbErrorCode =
  | "SCB_AUTH_ERROR"
  | "SCB_RATE_LIMITED"
  | "SCB_UNAVAILABLE"
  | "SCB_INVALID_QUERY"
  | "SCB_UNKNOWN_CATEGORY"
  | "SCB_UNKNOWN_VARIABLE"
  | "QUERY_TOO_BROAD"
  | "SCB_RESPONSE_VALIDATION_ERROR";

export type HttpErrorContext = {
  unknownName?: string;
  field?: string;
  objectType?: "company" | "workplace";
  retryAfterMs?: number;
  submittedCategories?: string[];
  submittedVariables?: string[];
};

export type QueryTooBroadContext = {
  objectType?: "company" | "workplace";
  layout?: "je" | "ae";
  appliedFilters?: unknown;
  catalogCategoryNames?: string[] | undefined;
  catalogVariableNames?: string[] | undefined;
};

export class ScbError extends Error {
  readonly code: ScbErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  readonly nextAction: ScbNextAction;
  readonly nextTools: string[];

  constructor(
    code: ScbErrorCode,
    message: string,
    retryable: boolean,
    details: Record<string, unknown> = {},
    hints: { nextAction?: ScbNextAction; nextTools?: string[] } = {},
  ) {
    super(message);
    this.name = "ScbError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.nextAction = hints.nextAction ?? defaultNextAction(code);
    this.nextTools = hints.nextTools ?? defaultNextTools(code, details);
  }

  toJSON(): {
    code: ScbErrorCode;
    message: string;
    retryable: boolean;
    nextAction: ScbNextAction;
    nextTools: string[];
    details: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      nextAction: this.nextAction,
      nextTools: this.nextTools,
      details: this.details,
    };
  }
}

export function queryTooBroad(
  count: number,
  maxResults: number,
  context: QueryTooBroadContext = {},
): ScbError {
  const objectType = context.objectType;
  const appliedFilters = context.appliedFilters ?? {};
  const unbounded = isEmptyFilters(appliedFilters);
  const catalogAvailable =
    (context.catalogCategoryNames && context.catalogCategoryNames.length > 0) ||
    (context.catalogVariableNames && context.catalogVariableNames.length > 0);
  return new ScbError(
    "QUERY_TOO_BROAD",
    `Query matched ${count} rows; SCB returns at most ${maxResults} rows and does not paginate.`,
    false,
    {
      count,
      maxResults,
      objectType: objectType ?? null,
      layout: context.layout ?? (objectType === "workplace" ? "ae" : objectType === "company" ? "je" : null),
      appliedFilters,
      candidateNarrowingDimensions: candidateNarrowingDimensions(
        objectType,
        catalogAvailable
          ? {
              ...(context.catalogCategoryNames
                ? { categoryNames: context.catalogCategoryNames }
                : {}),
              ...(context.catalogVariableNames
                ? { variableNames: context.catalogVariableNames }
                : {}),
            }
          : undefined,
      ),
      doNotPaginate: true,
      unboundedQuery: unbounded,
      suggestion:
        "Smalna frågan med fler SCB-kategorier (status, geografi, SNI, storleksklass). Paginera inte. Använd scb_schema_summary och scb_lookup_codes.",
    },
    {
      nextAction: "retry_modified",
      nextTools: narrowingCountTools(objectType),
    },
  );
}

export function unknownOperatorError(operator: string): ScbError {
  return new ScbError(
    "SCB_INVALID_QUERY",
    `Unknown SCB operator "${operator}".`,
    false,
    {
      field: "operator",
      unknownName: operator,
      allowedOperators: [...SCB_OPERATOR_NAMES],
      origin: "operator_allowlist",
    },
  );
}

export function withCatalogHints(
  error: ScbError,
  context: {
    objectType?: "company" | "workplace";
    categoryNames?: string[] | undefined;
    variableNames?: string[] | undefined;
  },
): ScbError {
  if (error.code === "SCB_UNKNOWN_CATEGORY" && context.categoryNames && context.categoryNames.length > 0) {
    const unknown = typeof error.details.unknownName === "string" ? error.details.unknownName : "";
    error.details.nearestNames = nearestNames(unknown, context.categoryNames);
    const hint = context.objectType
      ? layoutHint(unknown, context.objectType, context.categoryNames)
      : undefined;
    if (hint) {
      error.details.layoutHint = hint;
    }
  }
  if (error.code === "SCB_UNKNOWN_VARIABLE" && context.variableNames && context.variableNames.length > 0) {
    const unknown = typeof error.details.unknownName === "string" ? error.details.unknownName : "";
    error.details.nearestNames = nearestNames(unknown, context.variableNames);
  }
  if (
    error.code === "SCB_INVALID_QUERY" &&
    (error.details.field === "operator" || error.details.origin === "operator_allowlist")
  ) {
    error.details.allowedOperators = [...SCB_OPERATOR_NAMES];
  }
  return error;
}

export function mapHttpError(
  status: number,
  bodyText: string,
  context: HttpErrorContext = {},
): ScbError {
  const snippet = bodyText.slice(0, 500);
  if (status === 401 || status === 403) {
    return new ScbError("SCB_AUTH_ERROR", "SCB rejected the client certificate or API id.", false, {
      status,
      body: snippet,
      ...(context.objectType ? { objectType: context.objectType } : {}),
    });
  }
  if (status === 429) {
    return new ScbError("SCB_RATE_LIMITED", "SCB rate limit exceeded (10 calls per 10 seconds).", true, {
      status,
      body: snippet,
      retryAfterMs: context.retryAfterMs ?? 10_000,
      limit: 10,
      windowMs: 10_000,
    });
  }
  if (status === 503) {
    return new ScbError("SCB_UNAVAILABLE", "SCB API is unavailable (HTTP 503).", true, {
      status,
      body: snippet,
    });
  }
  const lower = bodyText.toLowerCase();
  if (status === 400 || status === 404) {
    if (lower.includes("kategori")) {
      const unknownName = context.unknownName ?? context.submittedCategories?.[0];
      return new ScbError(
        "SCB_UNKNOWN_CATEGORY",
        unknownName ? `SCB rejected the category "${unknownName}".` : "SCB rejected the category.",
        false,
        {
          status,
          body: snippet,
          field: context.field ?? "category",
          unknownName: unknownName ?? null,
          ...(context.objectType ? { objectType: context.objectType } : {}),
          ...(context.submittedCategories ? { submittedCategories: context.submittedCategories } : {}),
        },
      );
    }
    if (lower.includes("variabel")) {
      const unknownName = context.unknownName ?? context.submittedVariables?.[0];
      return new ScbError(
        "SCB_UNKNOWN_VARIABLE",
        unknownName ? `SCB rejected the variable "${unknownName}".` : "SCB rejected the variable.",
        false,
        {
          status,
          body: snippet,
          field: context.field ?? "variable",
          unknownName: unknownName ?? null,
          ...(context.objectType ? { objectType: context.objectType } : {}),
          ...(context.submittedVariables ? { submittedVariables: context.submittedVariables } : {}),
        },
      );
    }
    return new ScbError("SCB_INVALID_QUERY", "SCB rejected the query.", false, {
      status,
      body: snippet,
      origin: "scb_http",
      ...(context.field ? { field: context.field } : {}),
      ...(context.unknownName ? { unknownName: context.unknownName } : {}),
      ...(context.objectType ? { objectType: context.objectType } : {}),
      ...(context.submittedCategories ? { submittedCategories: context.submittedCategories } : {}),
      ...(context.submittedVariables ? { submittedVariables: context.submittedVariables } : {}),
    });
  }
  if (status >= 500) {
    return new ScbError("SCB_UNAVAILABLE", `SCB returned HTTP ${status}.`, true, {
      status,
      body: snippet,
    });
  }
  return new ScbError("SCB_INVALID_QUERY", `SCB returned HTTP ${status}.`, false, {
    status,
    body: snippet,
    origin: "scb_http",
  });
}

export function localRateLimited(retryAfterMs: number, outstanding: number): ScbError {
  return new ScbError(
    "SCB_RATE_LIMITED",
    "Local SCB client rate limit: 10 calls per 10 seconds. Wait and retry the same call.",
    true,
    {
      retryAfterMs,
      limit: 10,
      windowMs: 10_000,
      outstanding,
    },
    { nextAction: "retry_same", nextTools: [] },
  );
}

function defaultNextAction(code: ScbErrorCode): ScbNextAction {
  switch (code) {
    case "SCB_RATE_LIMITED":
    case "SCB_UNAVAILABLE":
      return "retry_same";
    case "SCB_INVALID_QUERY":
    case "SCB_UNKNOWN_CATEGORY":
    case "SCB_UNKNOWN_VARIABLE":
    case "QUERY_TOO_BROAD":
      return "retry_modified";
    case "SCB_AUTH_ERROR":
    case "SCB_RESPONSE_VALIDATION_ERROR":
      return "abort_unanswerable";
  }
}

function defaultNextTools(code: ScbErrorCode, details: Record<string, unknown>): string[] {
  const objectType =
    details.objectType === "workplace" || details.objectType === "company"
      ? details.objectType
      : undefined;
  switch (code) {
    case "SCB_UNKNOWN_CATEGORY":
      return ["scb_schema_summary", "scb_list_categories", "scb_lookup_codes", "scb_get_category_values"];
    case "SCB_UNKNOWN_VARIABLE":
      return ["scb_schema_summary", "scb_list_variables"];
    case "SCB_INVALID_QUERY":
      return ["scb_schema_summary", "scb_list_categories", "scb_list_variables"];
    case "QUERY_TOO_BROAD":
      return narrowingCountTools(objectType);
    case "SCB_RATE_LIMITED":
    case "SCB_UNAVAILABLE":
    case "SCB_AUTH_ERROR":
    case "SCB_RESPONSE_VALIDATION_ERROR":
      return [];
  }
}

function isEmptyFilters(filters: unknown): boolean {
  if (!filters || typeof filters !== "object") {
    return true;
  }
  const record = filters as { categories?: unknown; variables?: unknown };
  const categories = Array.isArray(record.categories) ? record.categories : [];
  const variables = Array.isArray(record.variables) ? record.variables : [];
  return categories.length === 0 && variables.length === 0;
}
