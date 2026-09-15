import type { CodeRow } from "../../domain/catalog.js";
import type { CoverageRelation, ResolvedEmployeeBand } from "./types.js";

/** Swedish grouped thousands: "10 000" — not a headcount of 10. */
const GROUPED_INT = String.raw`\d{1,3}(?:\s\d{3})+|\d+`;
const RANGE_RE = new RegExp(`(${GROUPED_INT})\\s*[-–—]\\s*(${GROUPED_INT})`, "u");
const PLUS_RE = new RegExp(`(${GROUPED_INT})\\s*\\+`, "u");
const SINGLE_RE = new RegExp(`(?:^|[^\\d])(${GROUPED_INT})\\s*(?:anst|person)`, "iu");

const MONETARY_RE = /(?:tkr|mkr|mdkr|kkr|\bkr\b|kronor|omsätt)/iu;

/** Revenue / monetary kodtabell labels must never be parsed as headcount bands. */
export function isMonetaryLabel(label: string): boolean {
  return MONETARY_RE.test(label);
}

export function parseSwedishInt(raw: string): number {
  return Number(raw.replace(/\s+/gu, ""));
}

export function parseEmployeeBand(row: CodeRow): ResolvedEmployeeBand | undefined {
  const label = row.label;
  if (isMonetaryLabel(label)) {
    return undefined;
  }
  const range = RANGE_RE.exec(label);
  if (range?.[1] && range[2]) {
    const min = parseSwedishInt(range[1]);
    const max = parseSwedishInt(range[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
      return { code: row.code, label, min, max };
    }
  }
  const plus = PLUS_RE.exec(label);
  if (plus?.[1]) {
    const min = parseSwedishInt(plus[1]);
    if (Number.isFinite(min)) {
      return { code: row.code, label, min, max: null };
    }
  }
  const single = SINGLE_RE.exec(label);
  if (single?.[1]) {
    const n = parseSwedishInt(single[1]);
    if (Number.isFinite(n)) {
      return { code: row.code, label, min: n, max: n };
    }
  }
  return undefined;
}

export function parseEmployeeBands(rows: CodeRow[]): ResolvedEmployeeBand[] {
  const bands: ResolvedEmployeeBand[] = [];
  for (const row of rows) {
    const band = parseEmployeeBand(row);
    if (band) {
      bands.push(band);
    }
  }
  return bands;
}

export function bandOverlapsRange(
  band: ResolvedEmployeeBand,
  requestedMin: number,
  requestedMax: number,
): boolean {
  const bandMax = band.max ?? Number.POSITIVE_INFINITY;
  return band.min <= requestedMax && bandMax >= requestedMin;
}

export function selectOverlappingBands(
  bands: ResolvedEmployeeBand[],
  min?: number,
  max?: number,
): ResolvedEmployeeBand[] {
  const requestedMin = min ?? 0;
  const requestedMax = max ?? Number.POSITIVE_INFINITY;
  return bands.filter((band) => bandOverlapsRange(band, requestedMin, requestedMax));
}

export function unionBandRange(bands: ResolvedEmployeeBand[]): { min: number; max: number | null } | undefined {
  if (bands.length === 0) {
    return undefined;
  }
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  let open = false;
  for (const band of bands) {
    lo = Math.min(lo, band.min);
    if (band.max === null) {
      open = true;
    } else {
      hi = Math.max(hi, band.max);
    }
  }
  return { min: lo, max: open ? null : hi };
}

/**
 * Compare a requested numeric headcount range with the SCB class union actually applied.
 * A wider SCB class than the user asked for is ALWAYS superset (never silent exact).
 */
export function rangeRelation(
  requestedMin: number,
  requestedMax: number,
  appliedMin: number,
  appliedMax: number | null,
): CoverageRelation {
  const aMax = appliedMax ?? Number.POSITIVE_INFINITY;
  const appliedCoversRequested = appliedMin <= requestedMin && aMax >= requestedMax;
  const requestedCoversApplied = requestedMin <= appliedMin && requestedMax >= aMax;
  if (appliedCoversRequested && requestedCoversApplied) {
    return "exact";
  }
  if (appliedCoversRequested) {
    return "superset";
  }
  if (requestedCoversApplied) {
    return "subset";
  }
  if (appliedMin <= requestedMax && aMax >= requestedMin) {
    return "partial";
  }
  return "unrepresentable";
}

export function formatBound(value: number | null | undefined): string {
  if (value === undefined) {
    return "…";
  }
  if (value === null || value === Number.POSITIVE_INFINITY) {
    return "∞";
  }
  return String(value);
}
