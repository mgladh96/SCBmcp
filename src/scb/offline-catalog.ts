import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyCategoryKind,
  extractCodeRows,
  fold,
  LOOKUP_KINDS,
  type CategoryKind,
} from "../domain/catalog.js";
import { SEMANTIC_ALIAS_VERSION } from "./compile/aliases.js";
import { lookupCategoryGroups } from "./code-lookup.js";
import { buildDiscoveryIndex, type DiscoveryIndex } from "./discovery.js";
import { extractMetadataItems } from "./payload.js";
import { isRateLimited, withRateLimitRetry, type RateLimitRetryOptions } from "./rate-limit-retry.js";
import type { ObjectType } from "./types.js";

export const CATALOG_FORMAT_VERSION = 1 as const;

export type CatalogSource = "scb-live" | "fixture";

export type CatalogRow = {
  code: string;
  label: string;
  level?: number;
  parentCode?: string;
  hasChildren?: boolean;
};

export type CatalogTable = {
  category: string;
  kind: CategoryKind;
  rows: CatalogRow[];
};

export type CatalogLayout = {
  objectType: ObjectType;
  categoryNames: string[];
  variableNames: string[];
  tables: CatalogTable[];
};

export type CatalogArtifact = {
  formatVersion: number;
  builtAt: string;
  source: CatalogSource;
  sourceVersion: string;
  layouts: {
    company: CatalogLayout;
    workplace: CatalogLayout;
  };
};

export type CatalogLayoutInput = {
  categoryNames: string[];
  variableNames: string[];
  tables: Array<{ category: string; rows: Array<{ code: string; label: string }> }>;
};

export type CatalogBuildInput = {
  builtAt?: string;
  source: CatalogSource;
  sourceVersion?: string;
  layouts: {
    company: CatalogLayoutInput;
    workplace: CatalogLayoutInput;
  };
};

export type CatalogMetadataSource = {
  listCategories: (objectType: ObjectType, includeCodeTables?: boolean) => Promise<unknown>;
  listVariables: (objectType: ObjectType, includeValueMetadata?: boolean) => Promise<unknown>;
  getCategoryValues: (objectType: ObjectType, category: string) => Promise<unknown>;
};

export type LoadedCatalog = {
  artifact: CatalogArtifact;
  indexes: Record<ObjectType, DiscoveryIndex>;
  path?: string;
};

const OBJECT_TYPES: ObjectType[] = ["company", "workplace"];

export function bundledCatalogPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "data", "scb-catalog", "catalog.json");
}

export function resolveCatalogPath(override?: string): string {
  const fromEnv = process.env.SCB_CATALOG_PATH?.trim();
  if (override && override.length > 0) {
    return override;
  }
  if (fromEnv) {
    return fromEnv;
  }
  return bundledCatalogPath();
}

export function catalogDisabled(): boolean {
  const raw = process.env.SCB_CATALOG_DISABLE?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

export function defaultCatalogSourceVersion(): string {
  return `aliases-${SEMANTIC_ALIAS_VERSION};format-${CATALOG_FORMAT_VERSION}`;
}

export function loadCatalogFromDisk(path = resolveCatalogPath()): CatalogArtifact | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parseCatalogArtifact(parsed);
  } catch {
    return undefined;
  }
}

export function parseCatalogArtifact(raw: unknown): CatalogArtifact | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.formatVersion !== CATALOG_FORMAT_VERSION) {
    return undefined;
  }
  if (typeof record.builtAt !== "string" || record.builtAt.length === 0) {
    return undefined;
  }
  if (record.source !== "scb-live" && record.source !== "fixture") {
    return undefined;
  }
  const layouts = record.layouts;
  if (!layouts || typeof layouts !== "object") {
    return undefined;
  }
  const company = parseLayout((layouts as Record<string, unknown>).company, "company");
  const workplace = parseLayout((layouts as Record<string, unknown>).workplace, "workplace");
  if (!company || !workplace) {
    return undefined;
  }
  return {
    formatVersion: CATALOG_FORMAT_VERSION,
    builtAt: record.builtAt,
    source: record.source,
    sourceVersion: typeof record.sourceVersion === "string" ? record.sourceVersion : defaultCatalogSourceVersion(),
    layouts: { company, workplace },
  };
}

export function buildCatalogArtifact(input: CatalogBuildInput): CatalogArtifact {
  return {
    formatVersion: CATALOG_FORMAT_VERSION,
    builtAt: input.builtAt ?? new Date().toISOString(),
    source: input.source,
    sourceVersion: input.sourceVersion ?? defaultCatalogSourceVersion(),
    layouts: {
      company: materializeLayout("company", input.layouts.company),
      workplace: materializeLayout("workplace", input.layouts.workplace),
    },
  };
}

export type CatalogBuildOptions = {
  source?: CatalogSource;
  sourceVersion?: string;
  builtAt?: string;
  sleep?: (ms: number) => Promise<void>;
  onRateLimitWait?: (waitMs: number) => void;
};

export async function buildCatalogFromClient(
  client: CatalogMetadataSource,
  options: CatalogBuildOptions = {},
): Promise<CatalogArtifact> {
  const retry: RateLimitRetryOptions = {
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onRateLimitWait ? { onWait: options.onRateLimitWait } : {}),
  };
  const layouts: CatalogBuildInput["layouts"] = {
    company: await fetchLayout(client, "company", retry),
    workplace: await fetchLayout(client, "workplace", retry),
  };
  return buildCatalogArtifact({
    source: options.source ?? "scb-live",
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    ...(options.builtAt ? { builtAt: options.builtAt } : {}),
    layouts,
  });
}

export function discoveryIndexFromLayout(layout: CatalogLayout): DiscoveryIndex {
  return buildDiscoveryIndex(
    layout.objectType,
    layout.tables.map((table) => ({
      category: table.category,
      raw: kodtabellPayload(table.rows),
    })),
  );
}

export function loadCatalogBundle(path = resolveCatalogPath()): LoadedCatalog | undefined {
  const artifact = loadCatalogFromDisk(path);
  if (!artifact) {
    return undefined;
  }
  return {
    artifact,
    indexes: {
      company: discoveryIndexFromLayout(artifact.layouts.company),
      workplace: discoveryIndexFromLayout(artifact.layouts.workplace),
    },
    path,
  };
}

export function catalogDocCount(artifact: CatalogArtifact): number {
  return OBJECT_TYPES.reduce((sum, objectType) => {
    return sum + artifact.layouts[objectType].tables.reduce((inner, table) => inner + table.rows.length, 0);
  }, 0);
}

export function writeCatalogToDisk(path: string, artifact: CatalogArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function categoryListPayload(objectType: ObjectType, names: string[]): unknown {
  return {
    KategoriGrupp: objectType === "workplace" ? "KategoriAE" : "KategoriJE",
    HemTyp: objectType === "workplace" ? "HemTagValAE" : "HemTagValJE",
    Kategorier: names.map((name) => {
      const jeName =
        name === "Företagsstatus" || name === "Registreringsstatus" || name.startsWith("Sätes");
      const key = objectType === "company" || jeName ? "Id_Kategori_JE" : "Id_Kategori_AE";
      return { [key]: name, TillaggsGrupp: "BasUtbud" };
    }),
  };
}

export function variableListPayload(objectType: ObjectType, names: string[]): unknown {
  const key = objectType === "workplace" ? "Id_Variabel_AE" : "Id_Variabel_JE";
  return { Variabler: names.map((name) => ({ [key]: name })) };
}

export function kodtabellPayload(rows: Array<{ code: string; label: string }>): unknown {
  return { Varden: rows.map((row) => ({ Varde: row.code, Text: row.label })) };
}

export function findCatalogTable(layout: CatalogLayout, category: string): CatalogTable | undefined {
  const folded = fold(category);
  return layout.tables.find((table) => fold(table.category) === folded);
}

function materializeLayout(objectType: ObjectType, input: CatalogLayoutInput): CatalogLayout {
  const tables: CatalogTable[] = input.tables.map((table) => {
    const kind = classifyCategoryKind(table.category);
    return {
      category: table.category,
      kind,
      rows: table.rows.map((row) => ({ code: row.code, label: row.label })),
    };
  });
  const index = buildDiscoveryIndex(
    objectType,
    tables.map((table) => ({ category: table.category, raw: kodtabellPayload(table.rows) })),
  );
  for (const table of tables) {
    table.rows = table.rows.map((row) => {
      const doc = index.docs.find((item) => item.category === table.category && item.code === row.code);
      const next: CatalogRow = { code: row.code, label: row.label };
      if (doc?.level !== undefined) {
        next.level = doc.level;
      }
      if (doc?.parentCode !== undefined) {
        next.parentCode = doc.parentCode;
      }
      if (doc && table.kind === "industry") {
        next.hasChildren = doc.hasChildren;
      }
      return next;
    });
  }
  return {
    objectType,
    categoryNames: unique(input.categoryNames),
    variableNames: unique(input.variableNames),
    tables,
  };
}

async function fetchLayout(
  client: CatalogMetadataSource,
  objectType: ObjectType,
  retry: RateLimitRetryOptions,
): Promise<CatalogLayoutInput> {
  const categoriesRaw = await withRateLimitRetry(() => client.listCategories(objectType, false), retry);
  const variablesRaw = await withRateLimitRetry(() => client.listVariables(objectType, false), retry);
  const categoryNames = namesFrom(categoriesRaw);
  const variableNames = namesFrom(variablesRaw);
  const groups = lookupCategoryGroups(categoriesRaw).filter((group) =>
    LOOKUP_KINDS.includes(classifyCategoryKind(group[0] ?? "")),
  );
  const tables: CatalogLayoutInput["tables"] = [];
  for (const group of groups) {
    for (const category of group) {
      try {
        const rows = extractCodeRows(
          await withRateLimitRetry(() => client.getCategoryValues(objectType, category), retry),
        );
        if (rows.length === 0) {
          continue;
        }
        tables.push({ category, rows });
      } catch (error) {
        if (isRateLimited(error)) {
          throw error;
        }
        // Keep the snapshot useful even if one kodtabell is missing.
      }
    }
  }
  return { categoryNames, variableNames, tables };
}

function parseLayout(raw: unknown, objectType: ObjectType): CatalogLayout | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.categoryNames) || !Array.isArray(record.variableNames) || !Array.isArray(record.tables)) {
    return undefined;
  }
  const categoryNames = record.categoryNames.filter((item): item is string => typeof item === "string" && item.length > 0);
  const variableNames = record.variableNames.filter((item): item is string => typeof item === "string" && item.length > 0);
  const tables: CatalogTable[] = [];
  for (const tableRaw of record.tables) {
    const table = parseTable(tableRaw);
    if (table) {
      tables.push(table);
    }
  }
  if (tables.length === 0) {
    return undefined;
  }
  return { objectType, categoryNames, variableNames, tables };
}

function parseTable(raw: unknown): CatalogTable | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.category !== "string" || record.category.length === 0 || !Array.isArray(record.rows)) {
    return undefined;
  }
  const kind =
    record.kind === "status" ||
    record.kind === "geography" ||
    record.kind === "industry" ||
    record.kind === "size" ||
    record.kind === "other"
      ? record.kind
      : classifyCategoryKind(record.category);
  const rows: CatalogRow[] = [];
  for (const rowRaw of record.rows) {
    if (!rowRaw || typeof rowRaw !== "object") {
      continue;
    }
    const row = rowRaw as Record<string, unknown>;
    if (typeof row.code !== "string" || row.code.length === 0 || typeof row.label !== "string") {
      continue;
    }
    const item: CatalogRow = { code: row.code, label: row.label };
    if (typeof row.level === "number") {
      item.level = row.level;
    }
    if (typeof row.parentCode === "string") {
      item.parentCode = row.parentCode;
    }
    if (typeof row.hasChildren === "boolean") {
      item.hasChildren = row.hasChildren;
    }
    rows.push(item);
  }
  return { category: record.category, kind, rows };
}

function namesFrom(raw: unknown): string[] {
  return extractMetadataItems(raw)
    .map((item) => item.name)
    .filter((name) => name.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
