import { classifyCategoryKind, fold } from "../../domain/catalog.js";
import type { ObjectType } from "../types.js";

/**
 * Pick the live catalog geography category for a semantic geo slot.
 * JE (company) uses säte (Säteslän / Säteskommun / seat aregion) — never AE Län.
 * AE (workplace) uses belägenhet (Län / Kommun / ARegion).
 */
export function pickGeographyCategory(
  categoryNames: string[],
  objectType: ObjectType,
  geoType: "county" | "municipality" | "aregion",
): string | undefined {
  const geo = categoryNames
    .map((name) => ({ name, folded: fold(name) }))
    .filter((item) => classifyCategoryKind(item.name) === "geography");

  if (geoType === "county") {
    if (objectType === "company") {
      return (
        geo.find((item) => item.folded.includes("sateslan"))?.name ??
        geo.find(
          (item) =>
            item.folded.includes("sates") && item.folded.includes("lan") && !item.folded.includes("kommun"),
        )?.name
      );
    }
    return (
      geo.find((item) => item.folded === "lan")?.name ??
      geo.find(
        (item) =>
          item.folded.endsWith("lan") &&
          !item.folded.includes("sates") &&
          !item.folded.includes("kommun") &&
          item.folded !== "plan",
      )?.name
    );
  }

  if (geoType === "municipality") {
    if (objectType === "company") {
      return geo.find((item) => item.folded.includes("sateskommun"))?.name;
    }
    return (
      geo.find((item) => item.folded === "kommun")?.name ??
      geo.find((item) => item.folded.includes("kommun") && !item.folded.includes("sates"))?.name
    );
  }

  const aregion = geo.filter((item) => item.folded.includes("aregion"));
  if (objectType === "company") {
    return aregion.find((item) => item.folded.includes("sates"))?.name ?? aregion[0]?.name;
  }
  return aregion.find((item) => !item.folded.includes("sates"))?.name ?? aregion[0]?.name;
}

export function pickStatusCategory(categoryNames: string[], objectType: ObjectType): string | undefined {
  const status = categoryNames.filter((name) => classifyCategoryKind(name) === "status");
  if (objectType === "workplace") {
    return (
      status.find((name) => fold(name).includes("arbetsstallestatus")) ??
      status.find((name) => fold(name).includes("arbetsstalle")) ??
      status[0]
    );
  }
  return (
    status.find((name) => fold(name).includes("foretagsstatus")) ??
    status.find((name) => fold(name) === "foretagsstatus") ??
    status.find((name) => !fold(name).includes("registrerings")) ??
    status[0]
  );
}

export function pickIndustryCategory(
  categoryNames: string[],
  preferLevel?: number,
): string | undefined {
  const industry = categoryNames.filter((name) => classifyCategoryKind(name) === "industry");
  if (preferLevel === 2) {
    const twoDigit = industry.find((name) => {
      const n = fold(name);
      return n.includes("2siffrig") || n.includes("tvasiffrig") || n.includes("tvasiffer");
    });
    if (twoDigit) {
      return twoDigit;
    }
  }
  if (preferLevel === 1) {
    const section = industry.find((name) => {
      const n = fold(name);
      return n.includes("avdelning") || n.includes("1siffrig") || n.includes("sektion");
    });
    if (section) {
      return section;
    }
  }
  return (
    industry.find((name) => fold(name) === "bransch") ??
    industry.find((name) => fold(name).includes("bransch") && !fold(name).includes("siffrig")) ??
    industry.find((name) => fold(name).includes("bransch")) ??
    industry.find((name) => fold(name).includes("sni")) ??
    industry[0]
  );
}

/** Live Omsättningsklass* is revenue, not headcount. */
export function isRevenueCategory(name: string): boolean {
  return fold(name).includes("omsattning");
}

/**
 * Live Bransch POSTs require Branschniva 1–3 on that category.
 * Dedicated 2-siffrig / nivå tables encode the level in the category name.
 */
export function categoryNeedsBranchLevel(category: string): boolean {
  const n = fold(category);
  if (n === "bransch") {
    return true;
  }
  if (!n.includes("bransch")) {
    return false;
  }
  if (n.includes("siffrig") || n.includes("niva")) {
    return false;
  }
  return classifyCategoryKind(category) === "industry";
}

export function pickSizeCategory(categoryNames: string[]): string | undefined {
  const size = categoryNames.filter(
    (name) => classifyCategoryKind(name) === "size" && !isRevenueCategory(name),
  );
  return (
    size.find((name) => fold(name).includes("storleksklass") && fold(name).includes("anst")) ??
    size.find((name) => fold(name).includes("anstalld") && !fold(name).includes("sme")) ??
    size.find((name) => fold(name).includes("storleksklass")) ??
    size.find((name) => fold(name).includes("anstsme")) ??
    size[0]
  );
}
