export const SOURCE_REGISTRY = "Allmänna företagsregistret";
export const SOURCE_PROVIDER = "SCB";
export const SOURCE_LABEL = "SCB Allmänna företagsregister";
export const MAX_RESULTS = 2000;
export const RATE_LIMIT_MAX_CALLS = 10;
export const RATE_LIMIT_WINDOW_MS = 10_000;

export type ObjectType = "company" | "workplace";
export type ScbLayout = "je" | "ae";

export function layoutFor(objectType: ObjectType): ScbLayout {
  return objectType === "company" ? "je" : "ae";
}

export function objectTypeFor(layout: ScbLayout): ObjectType {
  return layout === "je" ? "company" : "workplace";
}
