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
    { Id_Variabel_JE: "Företagsnamn", TillaggsGrupp: "BasUtbud" },
    { Id_Variabel_JE: "Firma", TillaggsGrupp: "BasUtbud" },
    { Id_Variabel_JE: "OrgNr (10 siffror)", TillaggsGrupp: "BasUtbud" },
    { Id_Variabel_JE: "OrgNr (12 siffror)", TillaggsGrupp: "BasUtbud" },
  ],
};

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
