export const LIST_CATEGORIES_DESCRIPTION = `Lista kategorier (kodtabeller) som det konfigurerade SCB-kontot får använda för company (JE) eller workplace (AE).

Svar: { objectType, items: [{ name, ... }], raw }. Använd items[].name exakt som category i filter.

Anti-mönster:
- Hårdkoda inte "Län", "Bransch" eller "Bygg". Namn måste komma härifrån.
- Gävleborg / län på JE är Säteslän (säte), på AE är Län (belägenhet).
- includeCodeTables=true hämtar alla kodtabeller (SNI är enormt). Föredra scb_get_category_values för en kategori.
- bypassCache=true hoppar över processcachen (timmar; SCB uppdaterar över natten).`;

export const GET_CATEGORY_VALUES_DESCRIPTION = `Hämta kodtabellen för en kategori på company (JE) eller workplace (AE).

Använd category-namnet från scb_list_categories (exakt stavning, inkl. diakriter). Svar: { objectType, category, items, raw }.

Anti-mönster:
- Skicka inte svenska etiketter ("Gävleborg", "aktiv") som category. Category är t.ex. Län eller Företagsstatus; koden är items[].name/Kod.
- Namn som innehåller "Bygg" är inte SNI — slå upp branschkategorin här.
- Vid SCB_UNKNOWN_CATEGORY: nextAction=retry_modified, scb_list_categories.`;

export const LIST_VARIABLES_DESCRIPTION = `Lista fritextvariabler (inte kodtabeller) för company (JE) eller workplace (AE).

Svar: { objectType, items: [{ name, ... }], raw }. Använd items[].name som variable i filter.

Operatorer är SCB-strängar, t.ex. Innehaller — inte Contains/Equals. Kontrollera ev. värdedomän med includeValueMetadata.

Anti-mönster:
- Firma vs Företagsnamn (JE) vs Benämning (AE) är olika fält.
- AnstSME är inte samma sak som kategorin Storleksklass Anställda.`;

export const COUNT_COMPANIES_DESCRIPTION = `Räkna juridiska enheter (JE) som matchar SCB-filter. Använd för att iterera — search räknar redan internt.

JE-geografi är Säteslän/Säteskommun, inte AE:s Län. Gävleborg som belägenhet är workplace.

Alltid count före bred hämtning. SCB max 2000 rader, ingen paginering, ingen historik.
Om count=0: stanna eller kontrollera koder/JE vs AE. Om count>2000: smalna innan scb_search_companies.
Tomma filter = hela populationen (warning). Behåll Reklam i senare sökresultat.

Anti-mönster: "Bygg" i namn ≠ SNI; operatorer som Contains; AnstSME vs Storleksklass Anställda.`;

export const SEARCH_COMPANIES_DESCRIPTION = `Hämta juridiska enheter (JE). Räknar först (återanvänder nylig count, ~5 s). Om count=0 hoppas hamta över. Om count>2000: QUERY_TOO_BROAD (paginera inte).

Filter: categories[] och variables[] med SCB-namn från listverktygen. Operatorer t.ex. Innehaller.
JE-geografi = säte (Säteslän), inte Län. Namn "Bygg" ≠ SNI.

Search är två kvotplatser om count inte cacheas (10 anrop / 10 s). Vid SCB_RATE_LIMITED: vänta retryAfterMs, retry_same.
Vid SCB_UNKNOWN_CATEGORY/VARIABLE: nextTools pekar på listverktygen. SCB_AUTH_ERROR går inte att rätta med andra filter.`;

export const COUNT_WORKPLACES_DESCRIPTION = `Räkna arbetsställen (AE) som matchar SCB-filter. Använd för att iterera — search räknar redan internt.

AE-geografi är Län/Kommun där stället ligger. Gävleborg som belägenhet hör hit, inte till JE-säte.
Status är Arbetsställestatus, inte Företagsstatus.

SCB max 2000 rader, ingen paginering, ingen historik. count=0 → stanna. count>2000 → smalna.
Tomma filter = hela populationen (warning).`;

export const SEARCH_WORKPLACES_DESCRIPTION = `Hämta arbetsställen (AE). Räknar först (återanvänder nylig count, ~5 s). Om count=0 hoppas hamta över. Om count>2000: QUERY_TOO_BROAD (paginera inte).

Gävleborg är AE Län när frågan gäller belägenhet. Namn "Bygg" ≠ SNI. Operatorer är SCB-strängar (Innehaller).
Storleksklass Anställda ≠ AnstSME. Behåll Reklam.

Vid SCB_RATE_LIMITED: retryAfterMs + retry_same. Vid UNKNOWN_*: listverktygen. Ingen historik.`;
