import type { CodeRow } from "../../domain/catalog.js";
import type { CoverageRelation, ResolvedEmployeeBand } from "./types.js";

const RANGE_RE = /(\d+)\s*[-–—]\s*(\d+)/u;
const PLUS_RE = /(\d+)\s*\+\s*/u;
const SINGLE_RE = /(?:^|[^\d])(\d+)\s*(?:anst|person)/iu;

export function parseEmployeeBand(row: CodeRow): ResolvedEmployeeBand | undefined {
  const label = row.label;
  const range = RANGE_RE.exec(label);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
      return { code: row.code, label, min, max };
    }
  }
  const plus = PLUS_RE.exec(label);
  if (plus) {
    const min = Number(plus[1]);
    if (Number.isFinite(min)) {
      return { code: row.code, label, min, max: null };
    }
  }
  const single = SINGLE_RE.exec(label);
  if (single) {
    const n = Number(single[1]);
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
