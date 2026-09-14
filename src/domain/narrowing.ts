import { resolveCatalogName, resolveCatalogNames } from "./catalog.js";

export type ObjectTypeHint = "company" | "workplace";

export type NarrowingDimension = {
  dimension: "status" | "geography" | "sni" | "sizeClass" | "name";
  categoryHint?: string;
  categoryNames?: string[];
  variableHint?: string;
  operatorHint?: string;
  why: string;
};

export type CatalogNameHints = {
  categoryNames?: string[] | undefined;
  variableNames?: string[] | undefined;
};

const COMPANY_DIMENSIONS: NarrowingDimension[] = [
  {
    dimension: "status",
    categoryHint: "Företagsstatus / Registreringsstatus",
    why: "Aktiva och Skatteregistrerade företag. Hämta koder via scb_get_category_values eller scb_lookup_codes.",
  },
  {
    dimension: "geography",
    categoryHint: "Säteslän / Säteskommun",
    why: "JE-geografi är säte. Kategorin Län tillhör AE om användaren inte uttryckligen menar säte.",
  },
  {
    dimension: "sni",
    categoryHint: "Bransch / SNI",
    why: "Namn som innehåller \"Bygg\" är inte SNI. Använd scb_lookup_codes och ev. branchLevel (Branschniva).",
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
    why: "Namn som innehåller \"Bygg\" är inte SNI. Använd scb_lookup_codes och ev. branchLevel (Branschniva).",
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

const COMPANY_CANDIDATES: Record<NarrowingDimension["dimension"], { categories?: string[]; variables?: string[] }> =
  {
    status: { categories: ["Företagsstatus", "Registreringsstatus"] },
    geography: { categories: ["Säteslän", "Säteskommun", "SätesLän", "SätesKommun"] },
    sni: { categories: ["Bransch", "SNI"] },
    sizeClass: { categories: ["Storleksklass Anställda", "Storleksklass anställda", "AnstSME"] },
    name: { variables: ["Företagsnamn", "Firma", "Namn"] },
  };

const WORKPLACE_CANDIDATES: Record<NarrowingDimension["dimension"], { categories?: string[]; variables?: string[] }> =
  {
    status: { categories: ["Arbetsställestatus"] },
    geography: { categories: ["Län", "Kommun"] },
    sni: { categories: ["Bransch", "SNI"] },
    sizeClass: { categories: ["Storleksklass Anställda", "Storleksklass anställda", "AnstSME"] },
    name: { variables: ["Benämning"] },
  };

export function candidateNarrowingDimensions(
  objectType?: ObjectTypeHint,
  catalog?: CatalogNameHints,
): NarrowingDimension[] {
  if (objectType === "workplace") {
    return bindDimensions(WORKPLACE_DIMENSIONS, WORKPLACE_CANDIDATES, catalog);
  }
  if (objectType === "company") {
    return bindDimensions(COMPANY_DIMENSIONS, COMPANY_CANDIDATES, catalog);
  }
  return [
    ...bindDimensions(COMPANY_DIMENSIONS, COMPANY_CANDIDATES, catalog),
    ...bindDimensions(WORKPLACE_DIMENSIONS, WORKPLACE_CANDIDATES, catalog),
  ];
}

function bindDimensions(
  dimensions: NarrowingDimension[],
  candidates: Record<NarrowingDimension["dimension"], { categories?: string[]; variables?: string[] }>,
  catalog?: CatalogNameHints,
): NarrowingDimension[] {
  return dimensions.map((dimension) => {
    const spec = candidates[dimension.dimension];
    const categoryNames = spec.categories
      ? resolveCatalogNames(spec.categories, catalog?.categoryNames)
      : undefined;
    const variableName = spec.variables
      ? resolveCatalogName(spec.variables, catalog?.variableNames)
      : undefined;
    return {
      ...dimension,
      ...(categoryNames && categoryNames.length > 0
        ? { categoryNames, categoryHint: categoryNames.join(" / ") }
        : {}),
      ...(variableName ? { variableHint: variableName } : {}),
    };
  });
}

export function narrowingCountTools(objectType?: ObjectTypeHint): string[] {
  if (objectType === "workplace") {
    return [
      "scb_count_workplaces",
      "scb_schema_summary",
      "scb_list_categories",
      "scb_lookup_codes",
      "scb_get_category_values",
    ];
  }
  if (objectType === "company") {
    return [
      "scb_count_companies",
      "scb_schema_summary",
      "scb_list_categories",
      "scb_lookup_codes",
      "scb_get_category_values",
    ];
  }
  return [
    "scb_count_companies",
    "scb_count_workplaces",
    "scb_schema_summary",
    "scb_list_categories",
    "scb_lookup_codes",
    "scb_get_category_values",
  ];
}
