import { fold } from "../domain/catalog.js";
import { parseEmployeeBand, parseSwedishInt } from "../scb/compile/bands.js";

/** Voice lookup speaks at most this many companies. */
export const VOICE_COMPANY_LIMIT = 3;

/**
 * SCB Storleksklass Anställda. Code 0 is missing data, not a headcount.
 * Higher codes are larger firms.
 */
const SIZE_CLASS_LABELS: Record<string, string> = {
  "0": "uppgift saknas",
  "1": "0 anställda",
  "2": "1-4 anställda",
  "3": "5-9 anställda",
  "4": "10-19 anställda",
  "5": "20-49 anställda",
  "6": "50-99 anställda",
  "7": "100-199 anställda",
  "8": "200-499 anställda",
  "9": "500-999 anställda",
  "10": "1000-1499 anställda",
  "11": "1500-1999 anställda",
  "12": "2000-2999 anställda",
  "13": "3000-3999 anställda",
  "14": "4000-4999 anställda",
  "15": "5000-9999 anställda",
  "16": "10000- anställda",
};

const STATUS_LABELS: Record<string, string> = {
  "0": "aldrig verksam",
  "1": "verksam",
  "9": "ej verksam",
};

export type VoiceCompany = {
  organizationNumber?: string;
  name?: string;
  city?: string;
  sizeClass?: string;
  industry?: string;
  status?: string;
};

export type VoiceCompanyPayload = {
  count: number;
  returned: number;
  results: VoiceCompany[];
  message?: string;
  note?: string;
};

type Activity = "active" | "inactive" | "unknown";
type Seat = "swedish" | "foreign" | "unknown";

type Ranked = {
  index: number;
  company: VoiceCompany;
  activity: Activity;
  seat: Seat;
  size: number;
  nameScore: number;
};

export function voiceCompanyPayload(
  rows: unknown[],
  options: {
    count: number;
    nameQuery?: string | undefined;
    limit?: number | undefined;
    municipalityLabels?: ReadonlyMap<string, string> | undefined;
  },
): VoiceCompanyPayload {
  const limit = Math.min(Math.max(options.limit ?? VOICE_COMPANY_LIMIT, 1), VOICE_COMPANY_LIMIT);
  if (options.count === 0 || rows.length === 0) {
    return {
      count: options.count,
      returned: 0,
      results: [],
      message: "Inget företag hittades.",
    };
  }
  const ranked = rows.map((row, index) => rankRow(row, index, options.nameQuery, options.municipalityLabels));
  const preferred = ranked.filter((item) => item.activity !== "inactive" && item.seat !== "foreign");
  const pool = preferred.length > 0 ? preferred : ranked;
  pool.sort(compareRanked);
  const results = pool.slice(0, limit).map((item) => item.company);
  const payload: VoiceCompanyPayload = {
    count: options.count,
    returned: results.length,
    results,
  };
  if (preferred.length === 0) {
    payload.note = "Inga verksamma svenska träffar.";
  } else if (preferred.length < ranked.length) {
    payload.note = "Visar verksamma företag med säte i Sverige.";
  }
  return payload;
}

/** Active, non-foreign rows. These outrank every inactive or foreign company. */
export function voicePreferredPopulation(rows: unknown[]): number {
  return voicePreferredAtLeast(rows, Number.NEGATIVE_INFINITY);
}

/**
 * Active Swedish rows whose size-class floor is at least `minSize`.
 * Employee bands are comparable: 10–19 has floor 10, 1–4 has floor 1, 0 employees has floor 0.
 */
export function voicePreferredAtLeast(rows: unknown[], minSize: number): number {
  let preferred = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const ranked = rankRow(rows[index], index, undefined, undefined);
    if (ranked.activity === "inactive" || ranked.seat === "foreign") {
      continue;
    }
    if (ranked.size >= minSize) {
      preferred += 1;
    }
  }
  return preferred;
}

function compareRanked(a: Ranked, b: Ranked): number {
  const activity = activityRank(b.activity) - activityRank(a.activity);
  if (activity !== 0) {
    return activity;
  }
  const seat = seatRank(b.seat) - seatRank(a.seat);
  if (seat !== 0) {
    return seat;
  }
  if (b.size !== a.size) {
    return b.size - a.size;
  }
  if (b.nameScore !== a.nameScore) {
    return b.nameScore - a.nameScore;
  }
  return a.index - b.index;
}

function activityRank(activity: Activity): number {
  if (activity === "active") {
    return 2;
  }
  if (activity === "unknown") {
    return 1;
  }
  return 0;
}

function seatRank(seat: Seat): number {
  if (seat === "swedish") {
    return 2;
  }
  if (seat === "unknown") {
    return 1;
  }
  return 0;
}

function rankRow(
  row: unknown,
  index: number,
  nameQuery: string | undefined,
  municipalityLabels: ReadonlyMap<string, string> | undefined,
): Ranked {
  const fields = stringFields(row);
  const statusRaw = fieldValue(fields, (folded) => folded === "foretagsstatus" || folded.startsWith("foretagsstatus"));
  const municipalityRaw = fieldValue(fields, (folded) => folded === "sateskommun" || folded.startsWith("sateskommun"));
  const countyRaw = fieldValue(fields, (folded) => folded === "sateslan" || folded.startsWith("sateslan"));
  const name = fieldValue(fields, (folded) => folded === "foretagsnamn" || folded === "firma" || folded === "namn");
  const organizationNumber = organizationNumberValue(fields);
  const sizeRaw = sizeRawValue(fields);
  const city = cityValue(municipalityRaw, countyRaw, fields, municipalityLabels);
  const sizeClass = sizeLabel(sizeRaw);
  const industry = industryValue(fields);
  const status = statusLabel(statusRaw);
  const company: VoiceCompany = {};
  if (organizationNumber) {
    company.organizationNumber = organizationNumber;
  }
  if (name) {
    company.name = name;
  }
  if (city) {
    company.city = city;
  }
  if (sizeClass) {
    company.sizeClass = sizeClass;
  }
  if (industry) {
    company.industry = industry;
  }
  if (status) {
    company.status = status;
  }
  return {
    index,
    company,
    activity: activityOf(statusRaw),
    seat: seatOf(municipalityRaw, countyRaw),
    size: sizeMin(sizeRaw),
    nameScore: nameMatchScore(name, nameQuery),
  };
}

function organizationNumberValue(fields: StringField[]): string | undefined {
  const ten = fieldValue(fields, (folded) => folded === "orgnr" || folded.startsWith("orgnr"));
  if (ten) {
    return ten.replace(/\s+/gu, "");
  }
  return fieldValue(fields, (folded) => folded === "peorgnr" || folded.startsWith("peorgnr"))?.replace(/\s+/gu, "");
}

function sizeRawValue(fields: StringField[]): string | undefined {
  const label = fieldValue(
    fields,
    (folded) =>
      (folded === "storleksklass" || folded.startsWith("storleksklass")) && !folded.endsWith("kod"),
  );
  if (label && !/^\d{1,2}$/u.test(label.trim())) {
    return label;
  }
  return (
    fieldValue(fields, (folded) => folded === "stklkod" || folded.endsWith("stklkod") || folded === "storleksklasskod") ??
    label
  );
}

function cityValue(
  municipalityRaw: string | undefined,
  _countyRaw: string | undefined,
  fields: StringField[],
  municipalityLabels: ReadonlyMap<string, string> | undefined,
): string | undefined {
  const label = speakablePlace(municipalityRaw, municipalityLabels);
  if (label) {
    return label;
  }
  const postal = fieldValue(fields, (folded) => folded === "postort");
  return speakablePlace(postal, undefined);
}

function speakablePlace(
  value: string | undefined,
  labels: ReadonlyMap<string, string> | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || fold(trimmed).includes("utland")) {
    return trimmed || undefined;
  }
  const digits = trimmed.replace(/\D/gu, "");
  if (digits && digits === trimmed.replace(/\s+/gu, "")) {
    const padded = digits.padStart(4, "0");
    return labels?.get(digits) ?? labels?.get(padded) ?? labels?.get(digits.replace(/^0+/u, "")) ?? undefined;
  }
  return trimmed;
}

function industryValue(fields: StringField[]): string | undefined {
  const industryFields = fields.filter((field) => /bransch|sni|naringsgren/u.test(field.folded));
  const label = industryFields.find((field) => !field.folded.endsWith("kod") && !isIndustryCode(field.value));
  const code = industryFields.find((field) => field.folded.endsWith("kod") || isIndustryCode(field.value));
  if (label && code && fold(label.value) !== fold(code.value)) {
    return `${code.value.trim()} ${label.value.trim()}`;
  }
  return label?.value.trim() ?? code?.value.trim();
}

function isIndustryCode(value: string): boolean {
  return /^[A-Za-z]?\d{2,5}$/u.test(value.trim()) || /^\d{2}\.\d{2,3}$/u.test(value.trim());
}

function statusLabel(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const activity = activityOf(raw);
  if (activity === "active") {
    return "verksam";
  }
  if (activity === "inactive") {
    const folded = fold(raw);
    if (folded === "0" || folded.includes("aldrig")) {
      return "aldrig verksam";
    }
    return "ej verksam";
  }
  return STATUS_LABELS[raw.trim()] ?? raw.trim();
}

function activityOf(raw: string | undefined): Activity {
  if (!raw) {
    return "unknown";
  }
  const folded = fold(raw.trim());
  if (folded === "1") {
    return "active";
  }
  if (folded === "0" || folded === "9") {
    return "inactive";
  }
  if (folded.includes("aldrig") || folded.includes("ej")) {
    return "inactive";
  }
  if (folded.includes("verksam")) {
    return "active";
  }
  return "unknown";
}

function seatOf(municipality: string | undefined, county: string | undefined): Seat {
  const texts = [municipality, county].filter((item): item is string => Boolean(item?.trim()));
  if (texts.length === 0) {
    return "unknown";
  }
  if (texts.some((item) => fold(item).includes("utland"))) {
    return "foreign";
  }
  const municipalityDigits = digitsOf(municipality);
  const countyDigits = digitsOf(county);
  if (municipalityDigits === "0000" || countyDigits === "00") {
    return "foreign";
  }
  if (municipalityDigits.length === 4) {
    const countyPart = Number(municipalityDigits.slice(0, 2));
    return countyPart >= 1 && countyPart <= 25 ? "swedish" : "foreign";
  }
  if (countyDigits.length === 2) {
    const countyPart = Number(countyDigits);
    if (countyPart >= 1 && countyPart <= 25) {
      return "swedish";
    }
    return "foreign";
  }
  if (texts.some((item) => /\p{L}/u.test(item))) {
    return "swedish";
  }
  return "unknown";
}

function digitsOf(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return "";
  }
  return trimmed.length === 3 ? trimmed.padStart(4, "0") : trimmed.padStart(trimmed.length <= 2 ? 2 : 4, "0");
}

function sizeLabel(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (SIZE_CLASS_LABELS[trimmed]) {
    return SIZE_CLASS_LABELS[trimmed];
  }
  return trimmed;
}

function sizeMin(raw: string | undefined): number {
  if (!raw) {
    return -1;
  }
  const trimmed = raw.trim();
  if (SIZE_CLASS_LABELS[trimmed]) {
    const label = SIZE_CLASS_LABELS[trimmed];
    if (trimmed === "0") {
      return -1;
    }
    return sizeMin(label);
  }
  const band = parseEmployeeBand({ code: "", label: trimmed });
  if (band) {
    return band.min;
  }
  const open = /^(\d[\d\s]*)\s*[-–—+]/u.exec(trimmed);
  if (open?.[1]) {
    return parseSwedishInt(open[1]);
  }
  return -1;
}

function nameMatchScore(name: string | undefined, query: string | undefined): number {
  if (!name || !query?.trim()) {
    return 0;
  }
  const foldedName = fold(name);
  const foldedQuery = fold(query);
  if (!foldedName || !foldedQuery) {
    return 0;
  }
  if (foldedName === foldedQuery) {
    return 4;
  }
  const withoutLegalForm = foldedName.replace(/(ab|hb|kb|ekfor|ekonomiskforening)$/u, "");
  if (withoutLegalForm === foldedQuery) {
    return 3;
  }
  if (foldedName.startsWith(foldedQuery)) {
    return 2;
  }
  if (foldedName.includes(foldedQuery)) {
    return 1;
  }
  return 0;
}

type StringField = { folded: string; value: string };

function stringFields(row: unknown): StringField[] {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return [];
  }
  const fields: StringField[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string" && typeof value !== "number") {
      continue;
    }
    const text = String(value).trim();
    if (!text) {
      continue;
    }
    fields.push({ folded: fold(key), value: text });
  }
  return fields;
}

function fieldValue(fields: StringField[], matches: (folded: string) => boolean): string | undefined {
  const hits = fields.filter((field) => matches(field.folded));
  hits.sort((a, b) => fieldPreference(a.folded) - fieldPreference(b.folded));
  return hits[0]?.value;
}

function fieldPreference(folded: string): number {
  if (folded.endsWith("text")) {
    return 0;
  }
  if (folded.endsWith("kod")) {
    return 2;
  }
  return 1;
}
