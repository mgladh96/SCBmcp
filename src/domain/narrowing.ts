export type ObjectTypeHint = "company" | "workplace";

export type NarrowingDimension = {
  dimension: "status" | "geography" | "sni" | "sizeClass" | "name";
  categoryHint?: string;
  variableHint?: string;
  operatorHint?: string;
  why: string;
};

const COMPANY_DIMENSIONS: NarrowingDimension[] = [
  {
    dimension: "status",
    categoryHint: "Företagsstatus / Registreringsstatus",
    why: "Aktiva och Skatteregistrerade företag. Hämta koder via scb_get_category_values.",
  },
  {
    dimension: "geography",
    categoryHint: "Säteslän / Säteskommun",
    why: "JE-geografi är säte. Kategorin Län tillhör AE om användaren inte uttryckligen menar säte.",
  },
  {
    dimension: "sni",
    categoryHint: "Bransch / SNI",
    why: "Namn som innehåller \"Bygg\" är inte SNI. Använd kodtabell och ev. branchLevel.",
  },
  {
    dimension: "sizeClass",
    categoryHint: "Storleksklass Anställda",
    why: "Inte AnstSME om frågan gäller SCB:s storleksklass. Koder från kodtabell, inte fritext 10-49.",
  },
  {
    dimension: "name",
    variableHint: "Företagsnamn / Firma",
    operatorHint: "Innehaller",
    why: "Fritextvariabel. Smalnar ofta för mycket; inte första steget för en populationsfråga.",
  },
];

const WORKPLACE_DIMENSIONS: NarrowingDimension[] = [
  {
    dimension: "status",
    categoryHint: "Arbetsställestatus",
    why: "AE använder Arbetsställestatus, inte Företagsstatus. Koder från kodtabell.",
  },
  {
    dimension: "geography",
    categoryHint: "Län / Kommun",
    why: "Gävleborg är AE-kategorin Län när frågan gäller belägenhet, inte JE-säte.",
  },
  {
    dimension: "sni",
    categoryHint: "Bransch / SNI",
    why: "Namn som innehåller \"Bygg\" är inte SNI. Använd kodtabell och ev. branchLevel.",
  },
  {
    dimension: "sizeClass",
    categoryHint: "Storleksklass Anställda",
    why: "Inte AnstSME om frågan gäller SCB:s storleksklass. Koder från kodtabell.",
  },
  {
    dimension: "name",
    variableHint: "Benämning",
    operatorHint: "Innehaller",
    why: "Fritextvariabel för arbetsställets namn. Operatorer är SCB-strängar, t.ex. Innehaller.",
  },
];

export function candidateNarrowingDimensions(
  objectType?: ObjectTypeHint,
): NarrowingDimension[] {
  if (objectType === "workplace") {
    return WORKPLACE_DIMENSIONS;
  }
  if (objectType === "company") {
    return COMPANY_DIMENSIONS;
  }
  return [...COMPANY_DIMENSIONS, ...WORKPLACE_DIMENSIONS];
}

export function narrowingCountTools(objectType?: ObjectTypeHint): string[] {
  if (objectType === "workplace") {
    return ["scb_count_workplaces", "scb_list_categories", "scb_get_category_values"];
  }
  if (objectType === "company") {
    return ["scb_count_companies", "scb_list_categories", "scb_get_category_values"];
  }
  return [
    "scb_count_companies",
    "scb_count_workplaces",
    "scb_list_categories",
    "scb_get_category_values",
  ];
}
