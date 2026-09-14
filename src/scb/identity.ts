import { fold } from "../domain/catalog.js";
import type { ScbFilters } from "./schemas.js";
import type { ObjectType } from "./types.js";

/**
 * SCB PeOrgNr is 12 digits:
 * - legal person: `16` + 10-digit organisationsnummer
 * - natural person (enskild näringsidkare): `19`/`20` + 10-digit personnummer
 *
 * A 10-digit organisationsnummer is distinguished from a personnummer by
 * positions 3–4 (1-based) being ≥ 20. Those 10 digits are prefixed with `16`.
 * A 10-digit personnummer-like value is rejected: century cannot be inferred.
 *
 * OrgNr (10 siffror) keeps the 10-digit form (strip a `16`/`19`/`20` prefix).
 * CfarNr is an 8-digit SCB workplace id; exact operator `ArLikaMed`.
 */
export const LEGAL_PERSON_PREFIX = "16";
export const CFAR_LENGTH = 8;
export const ORGNR_LENGTH = 10;
export const PEORGNR_LENGTH = 12;

export type IdentityKind = "peOrgNr" | "orgNr10" | "orgNr12" | "cfarNr";

export type IdentityOk = {
  ok: true;
  kind: IdentityKind;
  value: string;
  inputDigits: string;
  fromLength: number;
  personnummerLike: boolean;
};

export type IdentityErr = {
  ok: false;
  kind?: IdentityKind;
  reason: string;
  code: "IDENTITY_GARBAGE" | "IDENTITY_AMBIGUOUS";
};

export type IdentityResult = IdentityOk | IdentityErr;

export type IdentityChange = {
  variable: string;
  kind: IdentityKind;
  fromLength: number;
  toLength: number;
  personnummerLike: boolean;
};

export type IdentityFilterResult = {
  filters: ScbFilters;
  warnings: string[];
  error?: string;
  changes: IdentityChange[];
  personnummerLike: boolean;
};

export function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, "");
}

export function isPersonnummerLikeDigits(digits: string): boolean {
  if (digits.length === PEORGNR_LENGTH) {
    return digits.startsWith("19") || digits.startsWith("20");
  }
  if (digits.length === ORGNR_LENGTH) {
    return orgnrMonth(digits) >= 1 && orgnrMonth(digits) <= 12;
  }
  return false;
}

export function redactIdentity(value: string): string {
  const digits = digitsOnly(value);
  if (isPersonnummerLikeDigits(digits)) {
    return "[redacted-identity]";
  }
  if (digits.length >= 10) {
    return `${digits.slice(0, 4)}…${digits.slice(-2)}`;
  }
  return value;
}

export function identityKindForVariable(name: string, objectType: ObjectType): IdentityKind | undefined {
  const n = fold(name);
  if (n.includes("cfar")) {
    return "cfarNr";
  }
  if (n.includes("peorgnr")) {
    return "peOrgNr";
  }
  if (n.includes("orgnr")) {
    if (n.includes("12")) {
      return "orgNr12";
    }
    if (n.includes("10")) {
      return "orgNr10";
    }
    return objectType === "workplace" ? "orgNr12" : "orgNr10";
  }
  return undefined;
}

export function normalizePeOrgNr(raw: string): IdentityResult {
  return normalizeIdentityValue(raw, "peOrgNr");
}

export function normalizeCfarNr(raw: string): IdentityResult {
  return normalizeIdentityValue(raw, "cfarNr");
}

export function normalizeIdentityValue(raw: string, kind: IdentityKind): IdentityResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, kind, reason: "Tom identitet.", code: "IDENTITY_GARBAGE" };
  }
  const digits = digitsOnly(trimmed);
  if (digits.length === 0 || digits.length !== trimmed.replace(/[\s-]/g, "").length) {
    if (!/^\d[\d\s-]*\d$/.test(trimmed) && !/^\d+$/.test(trimmed)) {
      return {
        ok: false,
        kind,
        reason: `Ogiltigt identitetsvärde (förväntade siffror, ev. bindestreck).`,
        code: "IDENTITY_GARBAGE",
      };
    }
  }
  if (!/^\d+$/.test(digits)) {
    return { ok: false, kind, reason: "Ogiltigt identitetsvärde (icke-siffror).", code: "IDENTITY_GARBAGE" };
  }

  if (kind === "cfarNr") {
    if (digits.length !== CFAR_LENGTH) {
      return {
        ok: false,
        kind,
        reason: `CfarNr ska vara ${CFAR_LENGTH} siffror (SCB-tilldelat), fick ${digits.length}.`,
        code: "IDENTITY_GARBAGE",
      };
    }
    return {
      ok: true,
      kind,
      value: digits,
      inputDigits: digits,
      fromLength: digits.length,
      personnummerLike: false,
    };
  }

  if (kind === "orgNr10") {
    return normalizeOrgNr10(digits);
  }
  return normalizePeOrgNrDigits(digits, kind);
}

export function normalizeIdentityInFilters(filters: ScbFilters, objectType: ObjectType): IdentityFilterResult {
  const next = cloneFilters(filters);
  const warnings: string[] = [];
  const changes: IdentityChange[] = [];
  let personnummerLike = false;

  for (const item of next.variables) {
    const kind = identityKindForVariable(item.variable, objectType);
    if (!kind || item.value === undefined) {
      continue;
    }
    const result = normalizeIdentityValue(item.value, kind);
    if (!result.ok) {
      return {
        filters: next,
        warnings,
        error: result.reason,
        changes,
        personnummerLike,
      };
    }
    if (item.operator !== "ArLikaMed") {
      warnings.push(
        `Identitetsvariabeln "${item.variable}" bör använda operator ArLikaMed (exakt), inte ${item.operator}.`,
      );
    }
    if (result.personnummerLike) {
      personnummerLike = true;
      warnings.push("PeOrgNr är personnummer-likt; värdet loggas inte.");
    }
    if (result.value !== item.value || result.fromLength !== result.value.length) {
      const change: IdentityChange = {
        variable: item.variable,
        kind,
        fromLength: result.fromLength,
        toLength: result.value.length,
        personnummerLike: result.personnummerLike,
      };
      changes.push(change);
      if (!result.personnummerLike && result.fromLength !== result.value.length) {
        warnings.push(identityChangeWarning(change));
      }
    }
    item.value = result.value;
  }

  return { filters: next, warnings, changes, personnummerLike };
}

export function identityInvalidErrorDetails(message: string): Record<string, unknown> {
  return {
    field: "filters.variables.value",
    origin: "identity",
    suggestion:
      "Använd 10-siffrigt organisationsnummer eller 12-siffrigt PeOrgNr (16+orgnr). CFAR är 8 siffror. Operator ArLikaMed.",
    message,
  };
}

function identityChangeWarning(change: IdentityChange): string {
  if (change.kind === "peOrgNr" || change.kind === "orgNr12") {
    if (change.fromLength === ORGNR_LENGTH && change.toLength === PEORGNR_LENGTH) {
      return `PeOrgNr normaliserades från 10 till 12 siffror (juridisk person, prefix ${LEGAL_PERSON_PREFIX}).`;
    }
    if (change.fromLength === PEORGNR_LENGTH && change.toLength === ORGNR_LENGTH) {
      return "OrgNr normaliserades till 10 siffror (prefix 16/19/20 togs bort).";
    }
  }
  if (change.kind === "orgNr10" && change.fromLength === PEORGNR_LENGTH) {
    return "OrgNr normaliserades till 10 siffror.";
  }
  return `Identitet för ${change.variable} normaliserades (${change.fromLength}→${change.toLength} siffror).`;
}

function normalizePeOrgNrDigits(digits: string, kind: IdentityKind): IdentityResult {
  if (digits.length === PEORGNR_LENGTH) {
    if (!isKnownPeOrgNrPrefix(digits)) {
      return {
        ok: false,
        kind,
        reason: "12-siffrigt PeOrgNr ska börja med 16 (juridisk person) eller 19/20 (fysisk person).",
        code: "IDENTITY_GARBAGE",
      };
    }
    const core = digits.slice(2);
    if (!luhn10(core)) {
      return { ok: false, kind, reason: "PeOrgNr har ogiltig kontrollsiffra.", code: "IDENTITY_GARBAGE" };
    }
    return {
      ok: true,
      kind,
      value: digits,
      inputDigits: digits,
      fromLength: PEORGNR_LENGTH,
      personnummerLike: digits.startsWith("19") || digits.startsWith("20"),
    };
  }
  if (digits.length === ORGNR_LENGTH) {
    const month = orgnrMonth(digits);
    if (month >= 1 && month <= 12) {
      return {
        ok: false,
        kind,
        reason:
          "10-siffrigt värde ser ut som personnummer. Ange 12-siffrigt PeOrgNr med sekelsiffra 19 eller 20.",
        code: "IDENTITY_AMBIGUOUS",
      };
    }
    if (month < 20) {
      return {
        ok: false,
        kind,
        reason: "10-siffrigt organisationsnummer har månadsdelen ≥ 20; värdet känns inte igen.",
        code: "IDENTITY_GARBAGE",
      };
    }
    if (!luhn10(digits)) {
      return { ok: false, kind, reason: "Organisationsnumret har ogiltig kontrollsiffra.", code: "IDENTITY_GARBAGE" };
    }
    return {
      ok: true,
      kind,
      value: `${LEGAL_PERSON_PREFIX}${digits}`,
      inputDigits: digits,
      fromLength: ORGNR_LENGTH,
      personnummerLike: false,
    };
  }
  return {
    ok: false,
    kind,
    reason: `PeOrgNr/org.nr ska vara 10 eller 12 siffror, fick ${digits.length}.`,
    code: "IDENTITY_GARBAGE",
  };
}

function normalizeOrgNr10(digits: string): IdentityResult {
  if (digits.length === PEORGNR_LENGTH && isKnownPeOrgNrPrefix(digits)) {
    const core = digits.slice(2);
    if (!luhn10(core)) {
      return { ok: false, kind: "orgNr10", reason: "OrgNr har ogiltig kontrollsiffra.", code: "IDENTITY_GARBAGE" };
    }
    return {
      ok: true,
      kind: "orgNr10",
      value: core,
      inputDigits: digits,
      fromLength: PEORGNR_LENGTH,
      personnummerLike: digits.startsWith("19") || digits.startsWith("20"),
    };
  }
  if (digits.length === ORGNR_LENGTH) {
    if (!luhn10(digits)) {
      return { ok: false, kind: "orgNr10", reason: "OrgNr har ogiltig kontrollsiffra.", code: "IDENTITY_GARBAGE" };
    }
    return {
      ok: true,
      kind: "orgNr10",
      value: digits,
      inputDigits: digits,
      fromLength: ORGNR_LENGTH,
      personnummerLike: isPersonnummerLikeDigits(digits),
    };
  }
  return {
    ok: false,
    kind: "orgNr10",
    reason: `OrgNr (10 siffror) ska vara 10 eller 12 siffror, fick ${digits.length}.`,
    code: "IDENTITY_GARBAGE",
  };
}

function isKnownPeOrgNrPrefix(digits: string): boolean {
  return digits.startsWith(LEGAL_PERSON_PREFIX) || digits.startsWith("19") || digits.startsWith("20");
}

function orgnrMonth(digits10: string): number {
  return Number(digits10.slice(2, 4));
}

/** Luhn checksum used by Swedish person-/organisationsnummer (10 digits). */
export function luhn10(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    let n = Number(digits[i]);
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function cloneFilters(filters: ScbFilters): ScbFilters {
  return {
    categories: filters.categories.map((item) => ({
      category: item.category,
      values: [...item.values],
      ...(item.branchLevel !== undefined ? { branchLevel: item.branchLevel } : {}),
    })),
    variables: filters.variables.map((item) => ({
      variable: item.variable,
      operator: item.operator,
      ...(item.value !== undefined ? { value: item.value } : {}),
      ...(item.value2 !== undefined ? { value2: item.value2 } : {}),
    })),
  };
}
