import { typicalOperatorsForVariableKind, type ScbOperator } from "../scb/operators.js";
import {
  extractMetadataItems,
  isTopLevelCategory,
  type MetadataItem,
} from "../scb/payload.js";
import { layoutFor, type ObjectType, type ScbLayout } from "../scb/types.js";

export type CategoryKind = "status" | "geography" | "industry" | "size" | "other";
export type VariableKind = "name" | "identity" | "date" | "text";
export type CategorySerialization = "top-level" | "Kategorier";

export type CodeRow = {
  code: string;
  label: string;
};

export type QuestionClass =
  | "companies_in_region"
  | "workplaces_in_region"
  | "industry_and_place"
  | "name_contains"
  | "employee_size"
  | "organization_number";

export type FilterHint = {
  questionClass: QuestionClass;
  objectType: ObjectType | "both";
  recommendedCategories: string[];
  recommendedVariables: string[];
  defaultStatus?: { category: string; value: string; meaning: string } | undefined;
  notes: string;
};

export const LOOKUP_KINDS: CategoryKind[] = ["geography", "status", "size", "industry"];

export function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

export function classifyCategoryKind(name: string): CategoryKind {
  const n = fold(name);
  if (n.includes("status")) {
    return "status";
  }
  if (
    n.includes("bransch") ||
    n.includes("sni") ||
    n.includes("avdelning") ||
    n.includes("naringsgren")
  ) {
    return "industry";
  }
  if (
    n.includes("storleksklass") ||
    n.includes("anstsme") ||
    (n.includes("omsattning") && n.includes("klass"))
  ) {
    return "size";
  }
  if (
    n.includes("lan") ||
    n.includes("kommun") ||
    n.includes("region") ||
    n.includes("postort") ||
    n.includes("postnr") ||
    n.includes("adress") ||
    n === "aregion"
  ) {
    return "geography";
  }
  return "other";
}

export function classifyVariableKind(name: string): VariableKind {
  const n = fold(name);
  if (n.includes("orgnr") || n.includes("peorgnr") || n.includes("cfarnr")) {
    return "identity";
  }
  if (n.includes("datum")) {
    return "date";
  }
  if (
    n.includes("namn") ||
    n.includes("firma") ||
    n.includes("benamning") ||
    n === "namn"
  ) {
    return "name";
  }
  return "text";
}

export function categorySerialization(name: string, objectType?: ObjectType): CategorySerialization {
  const layout = objectType ? layoutFor(objectType) : undefined;
  return isTopLevelCategory(name, layout) ? "top-level" : "Kategorier";
}

export function counterpartOnWorkplace(name: string): string | undefined {
  const n = fold(name);
  if (n.includes("sateslan") || n === "sateslan") {
    return "Län";
  }
  if (n.includes("sateskommun")) {
    return "Kommun";
  }
  return undefined;
}

export function counterpartOnCompany(name: string): string | undefined {
  const n = fold(name);
  if (n === "lan" || n === "län") {
    return "Säteslän";
  }
  if (n === "kommun") {
    return "Säteskommun";
  }
  return undefined;
}

export function layoutHint(
  unknownName: string,
  objectType: ObjectType,
  catalogNames: string[] = [],
): string | undefined {
  const n = fold(unknownName);
  const catalog = catalogNames.map((name) => ({ name, folded: fold(name) }));
  const has = (folded: string) => catalog.some((item) => item.folded === folded);

  if (n === "lan") {
    if (objectType === "company") {
      const seat = catalog.find((item) => item.folded.includes("sateslan"))?.name ?? "Säteslän";
      return `Kategorin Län hör till AE (workplace, belägenhet). På JE använd ${seat} (säte). Menade du objectType=workplace?`;
    }
  }
  if (n === "kommun" && objectType === "company") {
    const seat = catalog.find((item) => item.folded.includes("sateskommun"))?.name ?? "Säteskommun";
    return `Kategorin Kommun hör till AE (workplace). På JE använd ${seat}.`;
  }
  if (n.includes("sateslan") && objectType === "workplace") {
    const location = catalog.find((item) => item.folded === "lan")?.name ?? "Län";
    return `Säteslän hör till JE (company, säte). På AE använd ${location} (belägenhet).`;
  }
  if (n.includes("sateskommun") && objectType === "workplace") {
    const location = catalog.find((item) => item.folded === "kommun")?.name ?? "Kommun";
    return `Säteskommun hör till JE (company). På AE använd ${location}.`;
  }
  if (n.includes("foretagsstatus") && objectType === "workplace") {
    const ae = catalog.find((item) => item.folded.includes("arbetsstallestatus"))?.name ?? "Arbetsställestatus";
    return `Företagsstatus är JE. På AE använd ${ae}.`;
  }
  if (n.includes("arbetsstallestatus") && objectType === "company") {
    return "Arbetsställestatus är AE. På JE använd Företagsstatus / Registreringsstatus.";
  }
  if (objectType === "company" && has("sateslan") && n === "lan") {
    return "På JE heter länet Säteslän, inte Län.";
  }
  return undefined;
}

export function nearestNames(unknown: string, catalog: string[], limit = 5): string[] {
  const needle = fold(unknown);
  if (!needle || catalog.length === 0) {
    return [];
  }
  const scored = catalog
    .map((name) => ({ name, score: nameScore(needle, fold(name)) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "sv"));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of scored) {
    if (seen.has(item.name)) {
      continue;
    }
    seen.add(item.name);
    result.push(item.name);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function nameScore(needle: string, hay: string): number {
  if (!hay) {
    return 0;
  }
  if (hay === needle) {
    return 1000;
  }
  if (hay.startsWith(needle) || needle.startsWith(hay)) {
    return 800 - Math.abs(hay.length - needle.length);
  }
  if (hay.includes(needle) || needle.includes(hay)) {
    return 500 - Math.abs(hay.length - needle.length);
  }
  const distance = levenshtein(needle, hay);
  const maxLen = Math.max(needle.length, hay.length);
  if (maxLen === 0) {
    return 0;
  }
  if (distance <= 2 || distance / maxLen <= 0.34) {
    return 300 - distance * 20;
  }
  return 0;
}

function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[] = new Array<number>(rows * cols);
  for (let i = 0; i < rows; i += 1) {
    matrix[i * cols] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[j] = j;
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = matrix[(i - 1) * cols + j] ?? i;
      const insertion = matrix[i * cols + j - 1] ?? j;
      const substitution = matrix[(i - 1) * cols + j - 1] ?? Math.max(i, j);
      matrix[i * cols + j] = Math.min(deletion + 1, insertion + 1, substitution + cost);
    }
  }
  return matrix[a.length * cols + b.length] ?? Math.max(a.length, b.length);
}

/** Live kodtabell uses Varde (code) + Text (label). Older dumps use Kod. */
const CODE_KEYS = ["Varde", "varde", "Kod", "kod", "code"];
const LABEL_KEYS = [
  "Text",
  "text",
  "Benämning",
  "Benamning",
  "Beskrivning",
  "label",
  "Namn",
  "namn",
];

export function extractCodeRows(raw: unknown): CodeRow[] {
  return extractMetadataItems(raw)
    .map((item) => {
      const code = firstString(item, CODE_KEYS) || item.name;
      const label = firstString(item, LABEL_KEYS) || code;
      return { code, label };
    })
    .filter((row) => row.code.length > 0);
}

function firstString(item: MetadataItem, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

export function codeRowMatches(row: CodeRow, query: string): number {
  const needle = fold(query);
  if (!needle) {
    return 0;
  }
  const code = fold(row.code);
  const label = fold(row.label);
  if (code === needle || label === needle) {
    return 100;
  }
  if (label.startsWith(needle) || code.startsWith(needle)) {
    return 80;
  }
  if (label.includes(needle) || code.includes(needle)) {
    return 50;
  }
  return 0;
}

export function isCheapSampleCategory(name: string): boolean {
  const kind = classifyCategoryKind(name);
  if (kind === "status" || kind === "size") {
    return true;
  }
  if (kind === "geography") {
    const n = fold(name);
    return n.includes("lan") && !n.includes("kommun");
  }
  return false;
}

export function shouldPrefetchForLookup(name: string, specifiedCategory?: string): boolean {
  if (specifiedCategory) {
    return fold(name) === fold(specifiedCategory);
  }
  return LOOKUP_KINDS.includes(classifyCategoryKind(name));
}

export function resolveCatalogName(candidates: string[], catalogNames?: string[]): string | undefined {
  if (!catalogNames || catalogNames.length === 0) {
    return candidates[0];
  }
  for (const candidate of candidates) {
    const folded = fold(candidate);
    const hit = catalogNames.find((name) => fold(name) === folded);
    if (hit) {
      return hit;
    }
  }
  for (const candidate of candidates) {
    const folded = fold(candidate);
    const hit = catalogNames.find((name) => fold(name).includes(folded) || folded.includes(fold(name)));
    if (hit) {
      return hit;
    }
  }
  return candidates[0];
}

export function resolveCatalogNames(candidates: string[], catalogNames?: string[]): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const name = resolveCatalogName([candidate], catalogNames);
    if (!name || seen.has(name)) {
      continue;
    }
    if (catalogNames && catalogNames.length > 0 && !catalogNames.some((item) => fold(item) === fold(name))) {
      const nearest = nearestNames(candidate, catalogNames, 1)[0];
      if (nearest && !seen.has(nearest)) {
        seen.add(nearest);
        resolved.push(nearest);
      }
      continue;
    }
    seen.add(name);
    resolved.push(name);
  }
  return resolved;
}

export const FILTER_HINTS: FilterHint[] = [
  {
    questionClass: "companies_in_region",
    objectType: "company",
    recommendedCategories: ["Säteslän", "Säteskommun", "Företagsstatus"],
    recommendedVariables: [],
    defaultStatus: { category: "Företagsstatus", value: "1", meaning: "verksam" },
    notes: "JE-geografi är säte, inte arbetsställets belägenhet.",
  },
  {
    questionClass: "workplaces_in_region",
    objectType: "workplace",
    recommendedCategories: ["Län", "Kommun", "Arbetsställestatus"],
    recommendedVariables: ["BesöksPostOrt"],
    defaultStatus: { category: "Arbetsställestatus", value: "1", meaning: "verksam" },
    notes: "AE-geografi är belägenhet. Gävleborg är Län, inte Säteslän.",
  },
  {
    questionClass: "industry_and_place",
    objectType: "workplace",
    recommendedCategories: ["Bransch", "Län", "Kommun", "Arbetsställestatus"],
    recommendedVariables: [],
    defaultStatus: { category: "Arbetsställestatus", value: "1", meaning: "verksam" },
    notes: "Bransch + plats är nästan alltid AE. Använd kodtabell och ev. branchLevel/Branschniva. Namn \"Bygg\" är inte SNI.",
  },
  {
    questionClass: "name_contains",
    objectType: "company",
    recommendedCategories: ["Företagsstatus"],
    recommendedVariables: ["Företagsnamn", "Firma"],
    defaultStatus: { category: "Företagsstatus", value: "1", meaning: "verksam" },
    notes: "Operator Innehaller. Firma och Företagsnamn är olika fält — ta namnet från scb_list_variables.",
  },
  {
    questionClass: "name_contains",
    objectType: "workplace",
    recommendedCategories: ["Arbetsställestatus"],
    recommendedVariables: ["Benämning"],
    defaultStatus: { category: "Arbetsställestatus", value: "1", meaning: "verksam" },
    notes: "Operator Innehaller. AE-namn är Benämning, inte Företagsnamn.",
  },
  {
    questionClass: "employee_size",
    objectType: "both",
    recommendedCategories: ["Storleksklass Anställda", "AnstSME"],
    recommendedVariables: [],
    notes: "Storleksklass Anställda ≠ AnstSME. Koder från kodtabell, inte fritext 10-49.",
  },
  {
    questionClass: "organization_number",
    objectType: "both",
    recommendedCategories: [],
    recommendedVariables: ["PeOrgNr", "OrgNr", "CfarNr"],
    notes:
      "Exakt operator ArLikaMed. 10-siffrigt org.nr → PeOrgNr (prefix 16). CFAR/CfarNr är 8 siffror. Personnummer-lika PeOrgNr loggas inte.",
  },
];

export function filterHintsFor(
  objectType?: ObjectType,
  questionClass?: QuestionClass,
  catalog?: { categoryNames?: string[] | undefined; variableNames?: string[] | undefined },
): FilterHint[] {
  return FILTER_HINTS.filter((hint) => {
    if (questionClass && hint.questionClass !== questionClass) {
      return false;
    }
    if (objectType && hint.objectType !== "both" && hint.objectType !== objectType) {
      return false;
    }
    return true;
  }).map((hint) => bindHintToCatalog(hint, objectType, catalog));
}

function bindHintToCatalog(
  hint: FilterHint,
  objectType: ObjectType | undefined,
  catalog?: { categoryNames?: string[] | undefined; variableNames?: string[] | undefined },
): FilterHint {
  const categories = resolveCatalogNames(hint.recommendedCategories, catalog?.categoryNames);
  const variables = resolveCatalogNames(hint.recommendedVariables, catalog?.variableNames);
  const statusCategory = hint.defaultStatus
    ? resolveCatalogName([hint.defaultStatus.category], catalog?.categoryNames)
    : undefined;
  const bound: FilterHint = {
    ...hint,
    objectType: hint.objectType === "both" && objectType ? objectType : hint.objectType,
    recommendedCategories: categories,
    recommendedVariables: variables,
  };
  if (hint.defaultStatus && statusCategory) {
    bound.defaultStatus = { ...hint.defaultStatus, category: statusCategory };
  } else if (hint.defaultStatus) {
    bound.defaultStatus = hint.defaultStatus;
  }
  return bound;
}

export function schemaWarnings(objectType: ObjectType): string[] {
  const warnings =
    objectType === "company"
      ? [
          "JE-geografi är säte (Säteslän/Säteskommun), inte AE-belägenhet (Län/Kommun).",
          "Företagsstatus och Registreringsstatus serialiseras som toppnivåfält, inte Kategorier[].",
        ]
      : [
          "AE-geografi är belägenhet (Län/Kommun). Gävleborg är Län, inte JE-säte.",
          "Arbetsställestatus serialiseras som toppnivåfält tills live /help/exampleAe bekräftas (certifikat). Defaulten ändras inte utan evidens. Om exampleAe visar Kategorier[]: SCB_AE_STATUS_TOP_LEVEL=false.",
        ];
  warnings.push(
    "Dumpa inte SNI med includeCodeTables=true — använd scb_lookup_codes eller scb_get_category_values med query.",
    "branchLevel (Branschniva) är bara meningsfullt på bransch/SNI-kategorier.",
    "AnstSME är inte samma sak som Storleksklass Anställda.",
  );
  return warnings;
}

export function typicalOperators(name: string): ScbOperator[] {
  return typicalOperatorsForVariableKind(classifyVariableKind(name));
}

export const DEFAULT_LOOKUP_LIMIT = 25;
export const DEFAULT_CATEGORY_VALUES_LIMIT = 50;
export const MAX_SAMPLE_VALUES = 5;

export function branchLevelWarnings(
  filters: { categories: Array<{ category: string; branchLevel?: number | undefined }> },
  layout?: ScbLayout,
): string[] {
  const warnings: string[] = [];
  for (const item of filters.categories) {
    if (item.branchLevel === undefined) {
      continue;
    }
    if (isTopLevelCategory(item.category, layout)) {
      warnings.push(
        `branchLevel/Branschniva ignoreras för toppnivåkategorin "${item.category}".`,
      );
      continue;
    }
    const kind = classifyCategoryKind(item.category);
    if (kind !== "industry") {
      warnings.push(
        `branchLevel/Branschniva är bara meningsfullt på bransch/SNI-kategorier; "${item.category}" klassas som ${kind}.`,
      );
    }
  }
  return warnings;
}
