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
  | "SCB_NO_MATCHES"
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
  const parsed = parseScbHttpErrorBody(bodyText);
  const joined = parsed.messages.join(" ").toLowerCase();
  const searchable = `${joined} ${bodyText.toLowerCase()}`;
  if (status === 400 || status === 404) {
    if (isBranchLevelRequirement(searchable, parsed.messages)) {
      const customError = parsed.customError ?? parsed.messages[0] ?? "Kategorin Bransch kräver att Branschnivå (1-3) angetts.";
      const named = namedCategoryFromMessages(parsed.messages) ?? "Bransch";
      return new ScbError(
        "SCB_INVALID_QUERY",
        customError,
        false,
        {
          status,
          body: snippet,
          origin: "scb_http",
          field: "branchLevel",
          customError,
          unknownName: named,
          ...(context.objectType ? { objectType: context.objectType } : {}),
          ...(context.submittedCategories ? { submittedCategories: context.submittedCategories } : {}),
        },
        {
          nextAction: "retry_modified",
          nextTools: ["scb_compile_query", "scb_schema_summary", "scb_lookup_codes"],
        },
      );
    }
    if (searchable.includes("kategori")) {
      const customError = parsed.customError ?? parsed.messages[0];
      const unknownName =
        namedCategoryFromMessages(parsed.messages) ?? context.unknownName ?? context.submittedCategories?.[0];
      return new ScbError(
        "SCB_UNKNOWN_CATEGORY",
        customError ??
          (unknownName ? `SCB rejected the category "${unknownName}".` : "SCB rejected the category."),
        false,
        {
          status,
          body: snippet,
          field: context.field ?? "category",
          unknownName: unknownName ?? null,
          ...(customError ? { customError } : {}),
          ...(context.objectType ? { objectType: context.objectType } : {}),
          ...(context.submittedCategories ? { submittedCategories: context.submittedCategories } : {}),
        },
      );
    }
    if (searchable.includes("variabel")) {
      const customError = parsed.customError ?? parsed.messages[0];
      const unknownName =
        namedVariableFromMessages(parsed.messages) ?? context.unknownName ?? context.submittedVariables?.[0];
      return new ScbError(
        "SCB_UNKNOWN_VARIABLE",
        customError ??
          (unknownName ? `SCB rejected the variable "${unknownName}".` : "SCB rejected the variable."),
        false,
        {
          status,
          body: snippet,
          field: context.field ?? "variable",
          unknownName: unknownName ?? null,
          ...(customError ? { customError } : {}),
          ...(context.objectType ? { objectType: context.objectType } : {}),
          ...(context.submittedVariables ? { submittedVariables: context.submittedVariables } : {}),
        },
      );
    }
    const customError = parsed.customError ?? parsed.messages[0];
    return new ScbError(
      "SCB_INVALID_QUERY",
      customError ?? "SCB rejected the query.",
      false,
      {
        status,
        body: snippet,
        origin: "scb_http",
        ...(customError ? { customError } : {}),
        ...(context.field ? { field: context.field } : {}),
        ...(context.unknownName ? { unknownName: context.unknownName } : {}),
        ...(context.objectType ? { objectType: context.objectType } : {}),
        ...(context.submittedCategories ? { submittedCategories: context.submittedCategories } : {}),
        ...(context.submittedVariables ? { submittedVariables: context.submittedVariables } : {}),
      },
    );
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
    case "SCB_NO_MATCHES":
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
    case "SCB_NO_MATCHES":
      return ["scb_compile_query", "scb_lookup_codes", "scb_schema_summary"];
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

type ParsedScbHttpError = {
  messages: string[];
  customError?: string;
};

export function parseScbHttpErrorBody(bodyText: string): ParsedScbHttpError {
  const messages: string[] = [];
  let customError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    collectErrorStrings(parsed, messages, (text, fromCustom) => {
      if (fromCustom && !customError) {
        customError = text;
      }
    });
  } catch {
    if (bodyText.trim()) {
      messages.push(bodyText.trim());
    }
  }
  if (messages.length === 0 && bodyText.trim()) {
    messages.push(bodyText.trim());
  }
  if (!customError) {
    customError = messages.find((item) => /CustomError/i.test(bodyText) && item !== "The request is invalid.") ??
      messages.find((item) => /branschniv|okänd|kan inte hittas|kräv/i.test(item));
  }
  return customError ? { messages, customError } : { messages };
}

function collectErrorStrings(
  value: unknown,
  into: string[],
  onCustom: (text: string, fromCustom: boolean) => void,
  fromCustom = false,
): void {
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    into.push(text);
    onCustom(text, fromCustom);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectErrorStrings(item, into, onCustom, fromCustom);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const rec = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(rec)) {
    const customKey = /^(customerror)$/i.test(key);
    collectErrorStrings(nested, into, onCustom, fromCustom || customKey);
  }
}

function isBranchLevelRequirement(searchable: string, messages: string[]): boolean {
  const text = `${searchable} ${messages.join(" ")}`.toLowerCase();
  return (
    text.includes("branschniv") ||
    text.includes("branschniva") ||
    text.includes("branchlevel")
  );
}

function namedCategoryFromMessages(messages: string[]): string | undefined {
  for (const message of messages) {
    const match = /Kategorin\s+(.+?)\s+(?:kräv|kan inte|hittas|måste|är)/iu.exec(message);
    const name = match?.[1]?.trim();
    if (name) {
      return name;
    }
  }
  return undefined;
}

function namedVariableFromMessages(messages: string[]): string | undefined {
  for (const message of messages) {
    const match = /Variabeln\s+(.+?)\s+(?:kräv|kan inte|hittas|måste|är)/iu.exec(message);
    const name = match?.[1]?.trim();
    if (name) {
      return name;
    }
  }
  return undefined;
}
