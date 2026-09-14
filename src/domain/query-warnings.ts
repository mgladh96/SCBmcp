import { branchLevelWarnings, layoutHint } from "./catalog.js";
import { isUnboundedFilters, type ScbFilters } from "../scb/schemas.js";
import { layoutFor, type ObjectType } from "../scb/types.js";
import { classifyCategoryKind } from "./catalog.js";

export const UNBOUNDED_QUERY_WARNING =
  "Obegränsad fråga: tomma filter matchar hela JE/AE-populationen och ger nästan alltid QUERY_TOO_BROAD vid hämtning. Lägg på status, geografi, SNI eller storleksklass från listverktygen.";

export function collectQueryWarnings(objectType: ObjectType, filters: ScbFilters): string[] {
  const warnings: string[] = [];
  if (isUnboundedFilters(filters)) {
    warnings.push(UNBOUNDED_QUERY_WARNING);
  }
  warnings.push(...branchLevelWarnings(filters, layoutFor(objectType)));
  for (const item of filters.categories) {
    const hint = layoutHint(item.category, objectType);
    if (hint) {
      warnings.push(hint);
    }
  }
  return [...new Set(warnings)];
}

export function missingStatusWarning(objectType: ObjectType, filters: ScbFilters): string | undefined {
  const statusName = objectType === "workplace" ? "Arbetsställestatus" : "Företagsstatus";
  const hasStatus = filters.categories.some((item) => classifyCategoryKind(item.category) === "status");
  if (hasStatus || isUnboundedFilters(filters)) {
    return undefined;
  }
  return `Ingen statuskategori i filtret. Överväg ${statusName}=1 (verksam) så att aldrig-verksamma/ej verksamma inte räknas med.`;
}
