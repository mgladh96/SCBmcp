import {
  LIVE_NOISY_TWO_DIGIT_BRANSCH,
  LIVE_TWO_DIGIT_BRANSCH_CATEGORY,
} from "../fixtures/live-scb-metadata.js";
import type { MockCatalogSpec } from "../helpers.js";
import { liveConstructionCatalogSpec } from "../helpers.js";

/** Substring-noise 2-digit codes that must not win for construction aliases. */
export const CONSTRUCTION_NOISE_CODES = ["22", "30", "16", "23", "25", "28", "46"] as const;

const COUNTIES: Array<{ code: string; label: string }> = [
  { code: "01", label: "Stockholms län" },
  { code: "12", label: "Skåne län" },
  { code: "14", label: "Västra Götalands län" },
  { code: "21", label: "Gävleborgs län" },
  { code: "23", label: "Jämtlands län" },
  { code: "25", label: "Norrbottens län" },
];

const MUNICIPALITIES: Array<{ code: string; label: string }> = [
  { code: "0180", label: "Stockholm" },
  { code: "1280", label: "Malmö" },
  { code: "1480", label: "Göteborg" },
  { code: "2180", label: "Gävle" },
  { code: "2380", label: "Östersund" },
  { code: "2580", label: "Luleå" },
];

const AREGIONS: Array<{ code: string; label: string }> = [
  { code: "SE110", label: "Stockholms län" },
  { code: "SE322", label: "Jämtlands län" },
];

const SIZE_BANDS: Array<{ code: string; label: string }> = [
  { code: "0", label: "0 anställda" },
  { code: "1", label: "1-4 anställda" },
  { code: "2", label: "5-9 anställda" },
  { code: "4", label: "10-19 anställda" },
  { code: "5", label: "20-49 anställda" },
  { code: "6", label: "50-99 anställda" },
  { code: "7", label: "100-199 anställda" },
];

/**
 * Live-shaped kodtabell for blind cases: construction noise + restaurant/IT/transport/retail.
 * SCB metadata remains source of truth — no extra production aliases.
 */
export const DIVERSE_INDUSTRY_ROWS: Array<{ code: string; label: string }> = [
  ...LIVE_NOISY_TWO_DIGIT_BRANSCH,
  { code: "F", label: "Byggverksamhet" },
  { code: "G", label: "Handel; reparation av motorfordon och motorcyklar" },
  { code: "H", label: "Transport och magasinering" },
  { code: "I", label: "Hotell- och restaurangverksamhet" },
  { code: "J", label: "Informations- och kommunikationsverksamhet" },
  { code: "47", label: "Detaljhandel utom med motorfordon och motorcyklar" },
  { code: "49", label: "Landtransport; transport i rörsystem" },
  { code: "56", label: "Restaurangverksamhet" },
  { code: "62", label: "Dataprogrammering, konsultverksamhet avseende informationsteknik" },
  { code: "70", label: "Verksamhet vid huvudkontor; konsultverksamhet" },
  { code: "41200", label: "Byggande av bostadshus" },
  { code: "47111", label: "Detaljhandel med livsmedel" },
  { code: "49410", label: "Vägtransport av gods" },
  { code: "56100", label: "Restauranger" },
  { code: "56101", label: "Caféverksamhet" },
  { code: "56102", label: "Kaféer och konditorier" },
  { code: "62010", label: "Dataprogrammering" },
  { code: "62020", label: "Datakonsulter" },
  { code: "70220", label: "Konsultverksamhet avseende företags organisation" },
];

const TWO_DIGIT_INDUSTRY_ROWS = DIVERSE_INDUSTRY_ROWS.filter((row) => /^\d{2}$/u.test(row.code));

export function constructionCatalogSpec(): MockCatalogSpec {
  return liveConstructionCatalogSpec();
}

/** Richer live-shaped catalog for blind cases the golden path was not tuned on. */
export function diverseCatalogSpec(): MockCatalogSpec {
  return {
    shape: "live",
    categories: {
      company: [
        "Företagsstatus",
        "Registreringsstatus",
        "Säteslän",
        "Säteskommun",
        "SätesARegion",
        "Anställda",
        LIVE_TWO_DIGIT_BRANSCH_CATEGORY,
        "Bransch",
        "Omsättningsklass fin",
      ],
      workplace: [
        "Arbetsställestatus",
        "Län",
        "Kommun",
        "ARegion",
        LIVE_TWO_DIGIT_BRANSCH_CATEGORY,
        "Bransch",
        "Anställda",
        "Omsättningsklass fin",
      ],
    },
    variables: {
      company: ["Namn", "Firma", "Företagsnamn", "OrgNr (10 siffror)", "OrgNr (12 siffror)"],
      workplace: ["Benämning", "CfarNr", "OrgNr (12 siffror)"],
    },
    tables: {
      Säteslän: COUNTIES,
      Län: COUNTIES,
      Säteskommun: MUNICIPALITIES,
      Kommun: MUNICIPALITIES,
      SätesARegion: AREGIONS,
      ARegion: AREGIONS,
      Anställda: SIZE_BANDS,
      "Storleksklass Anställda": SIZE_BANDS,
      Bransch: DIVERSE_INDUSTRY_ROWS,
      [LIVE_TWO_DIGIT_BRANSCH_CATEGORY]: TWO_DIGIT_INDUSTRY_ROWS,
    },
  };
}

export function catalogSpecFor(fixture: "construction" | "diverse"): MockCatalogSpec {
  return fixture === "construction" ? constructionCatalogSpec() : diverseCatalogSpec();
}
