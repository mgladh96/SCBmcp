import { DEFAULT_LOOKUP_LIMIT, extractCodeRows, fold } from "../../domain/catalog.js";
import { ScbError } from "../../domain/errors.js";
import { discoverCodes, type CodeLookupMatch } from "../code-lookup.js";
import { extractMetadataItems } from "../payload.js";
import type { ScbFilters } from "../schemas.js";
import { layoutFor, type ObjectType } from "../types.js";
import {
  formatBound,
  parseEmployeeBands,
  rangeRelation,
  selectOverlappingBands,
  unionBandRange,
} from "./bands.js";
import { resolveSemanticFields } from "./fields.js";
import { isRevenueCategory, pickGeographyCategory, pickSizeCategory, pickStatusCategory } from "./geography.js";
import { applyIndustry } from "./industry.js";
import type { StructuredQuery } from "./schema.js";
import type {
  CompileMetadataSource,
  CompileResult,
  CoverageEntry,
  ResolvedCode,
  ResolvedMappings,
  UnresolvedConstraint,
} from "./types.js";

export async function compileStructuredQuery(
  query: StructuredQuery,
  client: CompileMetadataSource,
): Promise<CompileResult> {
  const objectType = query.objectType;
  const categoryNames = namesFrom(await client.listCategories(objectType, false));
  const variableNames = namesFrom(await client.listVariables(objectType, false));
  const catalogNames = unique([...categoryNames, ...variableNames]);

  const filters: ScbFilters = { categories: [], variables: [] };
  const coverage: CoverageEntry[] = [];
  const unresolved: UnresolvedConstraint[] = [];
  const warnings: string[] = [];
  const resolved: ResolvedMappings = {
    layout: layoutFor(objectType),
    fields: {},
  };

  await applyStatus(query, client, objectType, categoryNames, filters, resolved, coverage, unresolved, warnings);
  await applyGeography(query, client, objectType, categoryNames, filters, resolved, coverage, unresolved, warnings);
  await applyIndustry(query, client, objectType, categoryNames, filters, resolved, coverage, unresolved, warnings);
  await applyEmployees(query, client, objectType, categoryNames, filters, resolved, coverage, unresolved, warnings);
  applyFields(query, objectType, catalogNames, resolved, coverage, unresolved, warnings);

  const ok =
    unresolved.length === 0 && coverage.every((entry) => entry.relation !== "unrepresentable");

  return { ok, objectType, filters, resolved, coverage, warnings, unresolved };
}

function namesFrom(raw: unknown): string[] {
  return extractMetadataItems(raw)
    .map((item) => item.name)
    .filter((name) => name.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function applyStatus(
  query: StructuredQuery,
  client: CompileMetadataSource,
  objectType: ObjectType,
  categoryNames: string[],
  filters: ScbFilters,
  resolved: ResolvedMappings,
  coverage: CoverageEntry[],
  unresolved: UnresolvedConstraint[],
  warnings: string[],
): Promise<void> {
  const requested = query.status;
  if (requested === "any") {
    coverage.push({
      constraint: "status",
      requested,
      applied: null,
      relation: "exact",
      exact: true,
      message: "Ingen statusfiltrering (status=any).",
    });
    return;
  }

  const category = pickStatusCategory(categoryNames, objectType);
  if (!category) {
    unresolved.push({
      constraint: "status",
      requested,
      reason: "Ingen statuskategori i SCB-katalogen för objectType.",
    });
    coverage.push({
      constraint: "status",
      requested,
      applied: null,
      relation: "unrepresentable",
      exact: false,
      message: "Ingen Företagsstatus/Arbetsställestatus i metadata.",
    });
    return;
  }

  let rows: ReturnType<typeof extractCodeRows> = [];
  try {
    rows = extractCodeRows(await client.getCategoryValues(objectType, category));
  } catch (error) {
    if (error instanceof ScbError) {
      unresolved.push({
        constraint: "status",
        requested,
        reason: error.message,
      });
      return;
    }
    throw error;
  }

  const active =
    rows.find((row) => {
      const label = fold(row.label);
      return label === "verksam" || label.startsWith("verksam") || label === "aktiv";
    }) ?? rows.find((row) => row.code === "1");

  if (!active) {
    unresolved.push({
      constraint: "status",
      requested,
      reason: `Hittade inte verksam/aktiv i ${category}.`,
    });
    return;
  }

  filters.categories.push({ category, values: [active.code] });
  resolved.status = { category, value: active.code, label: active.label };
  coverage.push({
    constraint: "status",
    requested,
    applied: { category, value: active.code, label: active.label },
    relation: "exact",
    exact: true,
    message: `${category}=${active.code} (${active.label}).`,
  });
  warnings.push(`Standardstatus active → ${category}=${active.code} (${active.label}).`);
}

async function applyGeography(
  query: StructuredQuery,
  client: CompileMetadataSource,
  objectType: ObjectType,
  categoryNames: string[],
  filters: ScbFilters,
  resolved: ResolvedMappings,
  coverage: CoverageEntry[],
  unresolved: UnresolvedConstraint[],
  warnings: string[],
): Promise<void> {
  const slot = query.geography;
  if (!slot) {
    return;
  }

  const category = pickGeographyCategory(categoryNames, objectType, slot.type);
  if (!category) {
    const reason =
      objectType === "company" && slot.type === "county"
        ? "JE-katalog saknar Säteslän/SätesLän (använd inte AE-kategorin Län)."
        : `Ingen SCB-kategori för geography.type=${slot.type} på ${objectType}.`;
    unresolved.push({ constraint: "geography", requested: slot, reason });
    coverage.push({
      constraint: "geography",
      requested: slot,
      applied: null,
      relation: "unrepresentable",
      exact: false,
      message: reason,
    });
    return;
  }

  const matches = await lookupGeography(client, objectType, slot.value, category);
  const chosen = pickBestCodes(matches, slot.value);
  if (chosen.length === 0) {
    unresolved.push({
      constraint: "geography",
      requested: slot,
      reason: `Ingen kod för "${slot.value}" i ${category}.`,
    });
    coverage.push({
      constraint: "geography",
      requested: slot,
      applied: { category, codes: [] },
      relation: "unrepresentable",
      exact: false,
      message: `Kunde inte slå upp ${slot.type} "${slot.value}" i ${category}.`,
    });
    return;
  }

  filters.categories.push({ category, values: chosen.map((item) => item.code) });
  resolved.geography = { category, type: slot.type, codes: chosen };

  const labelFold = fold(chosen[0]?.label ?? "");
  const valueFold = fold(slot.value);
  const exactLabel =
    chosen.length === 1 &&
    (labelFold === valueFold || labelFold.includes(valueFold) || valueFold.includes(labelFold) || chosen[0]?.code === slot.value.trim());

  coverage.push({
    constraint: "geography",
    requested: slot,
    applied: { category, codes: chosen },
    relation: exactLabel ? "exact" : "partial",
    exact: exactLabel,
    message: exactLabel
      ? `${slot.type} "${slot.value}" → ${category} kod ${chosen.map((item) => item.code).join(", ")} (${chosen.map((item) => item.label).join(", ")}).`
      : `Geografi "${slot.value}" approximerades mot ${category}.`,
  });

  if (objectType === "company" && slot.type === "county") {
    warnings.push(`JE-geografi är säte: ${category} (inte AE-kategorin Län).`);
  } else if (objectType === "workplace" && slot.type === "county") {
    warnings.push(`AE-geografi är belägenhet: ${category} (inte JE-säte).`);
  }
}

async function applyEmployees(
  query: StructuredQuery,
  client: CompileMetadataSource,
  objectType: ObjectType,
  categoryNames: string[],
  filters: ScbFilters,
  resolved: ResolvedMappings,
  coverage: CoverageEntry[],
  unresolved: UnresolvedConstraint[],
  warnings: string[],
): Promise<void> {
  const slot = query.employees;
  if (!slot) {
    return;
  }
  if (slot.min === undefined && slot.max === undefined) {
    unresolved.push({
      constraint: "employees",
      requested: slot,
      reason: "employees kräver min och/eller max.",
    });
    return;
  }
  if (slot.min !== undefined && slot.max !== undefined && slot.min > slot.max) {
    unresolved.push({
      constraint: "employees",
      requested: slot,
      reason: "employees.min får inte vara större än employees.max.",
    });
    return;
  }

  const category = pickSizeCategory(categoryNames);
  if (!category || isRevenueCategory(category)) {
    const reason = "Ingen storleksklass för anställda i SCB-katalogen.";
    unresolved.push({ constraint: "employees", requested: slot, reason });
    coverage.push({
      constraint: "employees",
      requested: slot,
      applied: null,
      relation: "unrepresentable",
      exact: false,
      message: reason,
    });
    return;
  }

  let rows: ReturnType<typeof extractCodeRows> = [];
  try {
    rows = extractCodeRows(await client.getCategoryValues(objectType, category));
  } catch (error) {
    if (error instanceof ScbError) {
      unresolved.push({ constraint: "employees", requested: slot, reason: error.message });
      return;
    }
    throw error;
  }

  const bands = parseEmployeeBands(rows);
  const selected = selectOverlappingBands(bands, slot.min, slot.max);
  const requestedMin = slot.min ?? 0;
  const requestedMax = slot.max ?? Number.POSITIVE_INFINITY;

  if (selected.length === 0) {
    const reason = `Ingen storleksklass överlappar ${formatBound(slot.min)}–${formatBound(slot.max)} anställda.`;
    unresolved.push({ constraint: "employees", requested: slot, reason });
    coverage.push({
      constraint: "employees",
      requested: slot,
      applied: { category, bands: [] },
      relation: "unrepresentable",
      exact: false,
      message: reason,
    });
    return;
  }

  const union = unionBandRange(selected);
  const relation = union
    ? rangeRelation(requestedMin, requestedMax, union.min, union.max)
    : "unrepresentable";
  const exact = relation === "exact";

  filters.categories.push({ category, values: selected.map((band) => band.code) });
  resolved.employees = { category, bands: selected };

  const appliedLabel = selected.map((band) => band.label).join(", ");
  const message =
    relation === "exact"
      ? `Anställda ${formatBound(slot.min)}–${formatBound(slot.max)} matchar ${category} (${appliedLabel}).`
      : `Begärt ${formatBound(slot.min)}–${formatBound(slot.max)} anställda; SCB har klass(er) ${appliedLabel} (${formatBound(union?.min)}–${formatBound(union?.max)}). relation=${relation}, exact=false.`;

  coverage.push({
    constraint: "employees",
    requested: slot,
    applied: { category, bands: selected },
    relation,
    exact,
    message,
  });

  if (!exact) {
    warnings.push(message);
  }
}

function applyFields(
  query: StructuredQuery,
  objectType: ObjectType,
  catalogNames: string[],
  resolved: ResolvedMappings,
  coverage: CoverageEntry[],
  unresolved: UnresolvedConstraint[],
  warnings: string[],
): void {
  const requested = query.fields;
  const { fields, missing } = resolveSemanticFields(objectType, requested, catalogNames);
  resolved.fields = fields;
  const usedDefault = !requested || requested.length === 0;
  if (missing.length > 0 && requested && requested.length > 0) {
    unresolved.push({
      constraint: "fields",
      requested: missing,
      reason: `Okända semantiska fält för ${objectType}: ${missing.join(", ")}.`,
    });
  } else if (missing.length > 0) {
    warnings.push(`Standardfält som saknas i katalogen hoppades över: ${missing.join(", ")}.`);
  }
  coverage.push({
    constraint: "fields",
    requested: usedDefault ? { default: true, ids: requested ?? ["name", "organizationNumber", "municipality", "employeeCount"] } : requested,
    applied: fields,
    relation: missing.length === 0 ? "exact" : requested && requested.length > 0 ? "partial" : "partial",
    exact: missing.length === 0,
    message:
      missing.length === 0
        ? `Semantiska fält → SCB-namn för ${objectType}.`
        : `Fält utan katalogträff: ${missing.join(", ")}.`,
  });
}

async function lookupGeography(
  client: CompileMetadataSource,
  objectType: ObjectType,
  value: string,
  category: string,
): Promise<CodeLookupMatch[]> {
  try {
    const result = await discoverCodes(client, objectType, value, {
      kind: "geography",
      category,
      limit: DEFAULT_LOOKUP_LIMIT,
    });
    return result.matches;
  } catch (error) {
    if (error instanceof ScbError && (error.code === "SCB_UNKNOWN_CATEGORY" || error.code === "SCB_INVALID_QUERY")) {
      return [];
    }
    throw error;
  }
}

function pickBestCodes(matches: CodeLookupMatch[], requested: string): ResolvedCode[] {
  if (matches.length === 0) {
    return [];
  }
  const trimmed = requested.trim();
  const exactCode = matches.filter((item) => item.code === trimmed);
  if (exactCode.length > 0) {
    return uniqueCodes(exactCode);
  }
  const folded = fold(requested);
  const exactLabel = matches.filter((item) => fold(item.label) === folded);
  if (exactLabel.length > 0) {
    return uniqueCodes(exactLabel);
  }
  return uniqueCodes(matches.slice(0, 1));
}

function uniqueCodes(matches: Array<{ code: string; label: string; score?: number | undefined }>): Array<ResolvedCode & { score?: number | undefined }> {
  const seen = new Set<string>();
  const codes: Array<ResolvedCode & { score?: number | undefined }> = [];
  for (const match of matches) {
    if (seen.has(match.code)) {
      continue;
    }
    seen.add(match.code);
    const item: ResolvedCode & { score?: number | undefined } = { code: match.code, label: match.label };
    if (match.score !== undefined) {
      item.score = match.score;
    }
    codes.push(item);
  }
  return codes;
}

export {
  BRANSCH_API_LEVEL_MAX,
  BRANSCH_API_LEVEL_MIN,
  branschLevelForCode,
  clampBranchLevel,
} from "./industry.js";
export { sniLevel } from "../discovery.js";

