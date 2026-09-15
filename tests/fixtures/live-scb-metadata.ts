/**
 * Shapes confirmed against live privateapi.scb.se (mTLS).
 * Category list rows use Id_Kategori_JE / Id_Kategori_AE — no Kategori/Namn.
 * Variable list rows use Id_Variabel_JE / Id_Variabel_AE — e.g. OrgNr (12 siffror).
 * Kodtabell rows use Varde (code) + Text (label) — not Kod.
 */

export const LIVE_AE_CATEGORY_LIST = {
  KategoriGrupp: "KategoriAE",
  HemTyp: "HemTagValAE",
  Kategorier: [
    { Id_Kategori_AE: "Län", TillaggsGrupp: "BasUtbud" },
    { Id_Kategori_JE: "Företagsstatus", TillaggsGrupp: "BasUtbud" },
    { Id_Kategori_AE: "Arbetsställestatus", TillaggsGrupp: "BasUtbud" },
    { Id_Kategori_AE: "Kommun", TillaggsGrupp: "BasUtbud" },
    { Id_Kategori_AE: "Bransch", TillaggsGrupp: "BasUtbud" },
    { Id_Kategori_AE: "Storleksklass Anställda", TillaggsGrupp: "BasUtbud" },
  ],
};

export const LIVE_JE_CATEGORY_LIST = {
  KategoriGrupp: "KategoriJE",
  HemTyp: "HemTagValJE",
  Kategorier: [
    { Id_Kategori_JE: "Företagsstatus", TillaggsGrupp: "BasUtbud" },
    { Id_Kategori_JE: "Registreringsstatus", TillaggsGrupp: "BasUtbud" },
    { Id_Kategori_JE: "Säteslän", TillaggsGrupp: "BasUtbud" },
    { Id_Kategori_JE: "Säteskommun", TillaggsGrupp: "BasUtbud" },
    { Id_Kategori_JE: "Bransch", TillaggsGrupp: "BasUtbud" },
    { Id_Kategori_JE: "Storleksklass Anställda", TillaggsGrupp: "BasUtbud" },
  ],
};

export const LIVE_AE_VARIABLE_LIST = {
  Variabler: [
    { Id_Variabel_AE: "Benämning", TillaggsGrupp: "BasUtbud" },
    { Id_Variabel_AE: "CfarNr", TillaggsGrupp: "BasUtbud" },
    { Id_Variabel_JE: "OrgNr (12 siffror)", TillaggsGrupp: "BasUtbud" },
    { Id_Variabel: "BesöksPostOrt", TillaggsGrupp: "BasUtbud" },
  ],
};

export const LIVE_JE_VARIABLE_LIST = {
  Variabler: [
    { Id_Variabel_JE: "Namn", TillaggsGrupp: "BasUtbud" },
    { Id_Variabel_JE: "Företagsnamn", TillaggsGrupp: "BasUtbud" },
    { Id_Variabel_JE: "Firma", TillaggsGrupp: "BasUtbud" },
    { Id_Variabel_JE: "OrgNr (10 siffror)", TillaggsGrupp: "BasUtbud" },
    { Id_Variabel_JE: "OrgNr (12 siffror)", TillaggsGrupp: "BasUtbud" },
  ],
};

/** Live JE category used by `{ query: "41", level: 2 }` (2026-09-15). */
export const LIVE_TWO_DIGIT_BRANSCH_CATEGORY = "2-siffrig bransch 1";

/**
 * Live-shaped 2-digit bransch rows: construction 41–43 plus substring noise
 * that contains "bygg" (plast, fartyg, handel, …). No section F.
 */
export const LIVE_NOISY_TWO_DIGIT_BRANSCH = [
  { code: "22", label: "Tillverkning av byggplast" },
  { code: "30", label: "Byggande av fartyg och båtar" },
  { code: "41", label: "Byggande av hus" },
  { code: "42", label: "Anläggningsarbeten" },
  { code: "43", label: "Specialiserad bygg- och anläggningsverksamhet" },
  { code: "16", label: "Tillverkning av varor av trä för bygg" },
  { code: "23", label: "Tillverkning av andra icke-metalliska mineraliska produkter för bygg" },
  { code: "25", label: "Tillverkning av metallvaror för bygg" },
  { code: "28", label: "Tillverkning av maskiner för bygg" },
  { code: "46", label: "Partihandel med byggvaror" },
];

/** Live kodtabell: Varde is the code, Text is the label. */
export const LIVE_LAN_KODTABELL = {
  Varden: [
    { Varde: "21", Text: "Gävleborg" },
    { Varde: "01", Text: "Stockholm" },
  ],
};

export const LIVE_STATUS_KODTABELL = {
  Varden: [
    { Varde: "1", Text: "verksam" },
    { Varde: "0", Text: "aldrig verksam" },
  ],
};

export const LIVE_OMSATTNING_KODTABELL = {
  Varden: [
    { Varde: "01", Text: "1 - 49 tkr" },
    { Varde: "04", Text: "10 000 - 19 999 tkr" },
  ],
};

/**
 * Default JE hamta columns when POST has category filters only (no variabler).
 * Confirmed against privateapi.scb.se 2026-09-15 — not Namn / OrgNr (10 siffror).
 */
export const LIVE_JE_SEARCH_ROW = {
  Företagsnamn: "Jämtlands Bygg AB",
  OrgNr: "5560747569",
  PeOrgNr: "165560747569",
  Säteskommun: "Östersund",
  Säteslän: "Jämtlands län",
  Storleksklass: "10-19 anställda",
  "Stkl, kod": "4",
  Reklam: "11",
  Telefon: "should-not-leak",
};

/** Default AE hamta columns with category filters only (no Finns projection). */
export const LIVE_AE_SEARCH_ROW = {
  Benämning: "Jämtlands Bygg Östersund",
  OrgNr: "5560747569",
  PeOrgNr: "165560747569",
  Kommun: "Östersund",
  Län: "Jämtlands län",
  Storleksklass: "10-19 anställda",
  "Stkl, kod": "4",
  Reklam: "11",
  Telefon: "should-not-leak",
};
