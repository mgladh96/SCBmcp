export const LIST_CATEGORIES_DESCRIPTION = `Lista kategorier (kodtabeller) som det konfigurerade SCB-kontot får använda för company (JE) eller workplace (AE).

Svar: { objectType, items: [{ name, ... }], raw }. Använd items[].name exakt som category i filter.

Anti-mönster:
- Hårdkoda inte "Län", "Bransch" eller "Bygg". Namn måste komma härifrån.
- Gävleborg / län på JE är Säteslän (säte), på AE är Län (belägenhet).
- includeCodeTables=true hämtar alla kodtabeller (SNI är enormt). Föredra scb_schema_summary och scb_lookup_codes.
- bypassCache=true hoppar över processcachen (timmar; SCB uppdaterar över natten).`;

export const GET_CATEGORY_VALUES_DESCRIPTION = `Hämta kodtabellen för en kategori på company (JE) eller workplace (AE).

Använd category-namnet från scb_schema_summary / scb_list_categories (exakt stavning). Svar: { total, returned, items, truncated }.

Valfritt query filtrerar på kod/etikett (t.ex. Gävleborg). Standard limit ~50. Full dump bara med includeAll=true eller limit=0 — använd inte för SNI.

Anti-mönster:
- Skicka inte svenska etiketter ("Gävleborg", "aktiv") som category. Category är t.ex. Län eller Företagsstatus; koden är items[].name (live: Varde, äldre: Kod).
- Namn som innehåller "Bygg" är inte SNI — sök med scb_lookup_codes.
- Vid SCB_UNKNOWN_CATEGORY: nearestNames + scb_schema_summary.`;

export const LIST_VARIABLES_DESCRIPTION = `Lista fritextvariabler (inte kodtabeller) för company (JE) eller workplace (AE).

Svar: { objectType, items: [{ name, ... }], raw }. Använd items[].name som variable i filter.

Live JE-rader har Id_Variabel_JE (ingen Variabel/Namn). Org.nr heter exakt "OrgNr (10 siffror)" och "OrgNr (12 siffror)" — inte PeOrgNr (SCB 400). PeOrgNr/CfarNr känns igen som alias i identitetssockret.

Operatorer är SCB-enum: Innehaller, ArLikaMed, BorjarPa, Mellan, FranOchMed, TillOchMed, Finns, FinnsInte — inte Contains/Equals. Kontrollera ev. värdedomän med includeValueMetadata.

Anti-mönster:
- Firma vs Företagsnamn (JE) vs Benämning (AE) är olika fält.
- AnstSME är inte samma sak som kategorin Storleksklass Anställda.
- Skicka inte PeOrgNr live på JE.`;

export const COUNT_COMPANIES_DESCRIPTION = `Räkna juridiska enheter (JE) som matchar SCB-filter. Använd för att iterera — search räknar redan internt.

JE-geografi är Säteslän/Säteskommun, inte AE:s Län. Gävleborg som belägenhet är workplace.

Alltid count före bred hämtning. SCB max 2000 rader, ingen paginering, ingen historik.
Om count=0: stanna eller kontrollera koder/JE vs AE. Om count>2000: smalna innan scb_search_companies.
Tomma filter = hela populationen (warning). Behåll Reklam i senare sökresultat.

Anti-mönster: "Bygg" i namn ≠ SNI; operatorer som Contains; AnstSME vs Storleksklass Anställda.`;

export const SEARCH_COMPANIES_DESCRIPTION = `Hämta juridiska enheter (JE). Räknar först (återanvänder nylig count, ~5 s). Om count=0 hoppas hamta över. Om count>2000: QUERY_TOO_BROAD (paginera inte).

SCB-kostnad: search hämtar hela resultatmängden från SCB (efter 2000-vakten). fields[] och maxRows krymper bara vad agenten ser — de minskar inte hamta-anropet. Räkna först och smalna filter innan search.

Valfritt fields[] och maxRows (standard 75, högst 2000). Standardfält: orgnr, namn, status, geografi, SNI/bransch, storleksklass, Reklam. Reklam strippas aldrig.

Filter: categories[] och variables[] med SCB-namn från listverktygen. Operatorer: Innehaller, ArLikaMed, m.fl. (allowlist). branchLevel = SCB Branschniva, bara på bransch/SNI.
JE-geografi = säte (Säteslän), inte Län. Namn "Bygg" ≠ SNI.
Org.nr: live JE-variabler heter OrgNr (10 siffror) och OrgNr (12 siffror) — inte PeOrgNr. 10-siffrigt organisationsnummer på 12-siffriga fältet → prefix 16. 10-siffriga fältet behåller 10. Operator ArLikaMed.

Svarskuvert: { count, fetched, returned, omittedByMaxRows?, results, filters, warnings?, source }.
count = SCB-population. fetched = rader i hamta-svaret. returned = rader i results. omittedByMaxRows = fetched−returned när maxRows klippte.
Search är två kvotplatser om count inte cacheas (10 anrop / 10 s). Vid SCB_RATE_LIMITED: vänta retryAfterMs, retry_same.
Vid SCB_UNKNOWN_CATEGORY/VARIABLE: nextTools pekar på listverktygen. SCB_AUTH_ERROR går inte att rätta med andra filter.`;

export const COUNT_WORKPLACES_DESCRIPTION = `Räkna arbetsställen (AE) som matchar SCB-filter. Använd för att iterera — search räknar redan internt.

AE-geografi är Län/Kommun där stället ligger. Gävleborg som belägenhet hör hit, inte till JE-säte.
Status är Arbetsställestatus (toppnivå i POST, analogt med JE) — inte Företagsstatus.

SCB max 2000 rader, ingen paginering, ingen historik. count=0 → stanna. count>2000 → smalna.
Tomma filter = hela populationen (warning).`;

export const SEARCH_WORKPLACES_DESCRIPTION = `Hämta arbetsställen (AE). Räknar först (återanvänder nylig count, ~5 s). Om count=0 hoppas hamta över. Om count>2000: QUERY_TOO_BROAD (paginera inte).

SCB-kostnad: search hämtar hela resultatmängden från SCB (efter 2000-vakten). fields[] och maxRows krymper bara agentvyn. Räkna först och smalna filter innan search.

Valfritt fields[] och maxRows (standard 75, högst 2000). Standardfält: CfarNr, orgnr, namn, status, geografi, SNI, storleksklass, Reklam. Reklam strippas aldrig.
Gävleborg är AE Län när frågan gäller belägenhet. Namn "Bygg" ≠ SNI. Operatorer är SCB-enum (Innehaller, ArLikaMed, …).
Storleksklass Anställda ≠ AnstSME. branchLevel = Branschniva, bara på bransch.
CfarNr är 8 siffror, operator ArLikaMed.
Svarskuvert: { count, fetched, returned, omittedByMaxRows?, results, filters, warnings?, source }. count=SCB-population, fetched=hamta-rader, omittedByMaxRows=maxRows-klipp.

Vid SCB_RATE_LIMITED: retryAfterMs + retry_same. Vid UNKNOWN_*: scb_schema_summary / nearestNames. Ingen historik.`;

export const EXPLAIN_QUERY_DESCRIPTION = `Dry-run: serialisera filter till SCB POST-kropp utan HTTP mot SCB.

Input: objectType (company|workplace) + samma filters som count/search.
Svar: layout, endpoints (rakna*/hamta*), serializedBody, operatorvalidering, identitetsnormalisering, varningar (tomma filter, branchLevel på icke-bransch, JE/AE-geografi). Noll kvot.

AE: serialization.aeStatusNote beskriver default toppnivå för Arbetsställestatus. Live /help/exampleAe är inte bekräftat här. Om exampleAe visar Kategorier[]: SCB_AE_STATUS_TOP_LEVEL=false.

Använd före scb_count_*/scb_search_* när du vill se vad som skulle skickas.`;

export const SCHEMA_SUMMARY_DESCRIPTION = `Kompakt katalog för company (JE) eller workplace (AE), byggd från cacheade koptakategorier + koptavariabler.

Returnerar categories (name, kind, serialization top-level vs Kategorier, sampleValues när det är billigt, JE↔AE-motparter), variables (typicalOperators), operators (allowlist), filterHints och korta varningar. Ingen full SNI-dump.

Börja här i stället för includeCodeTables=true. Koder slås upp med scb_lookup_codes.`;

export const LOOKUP_CODES_DESCRIPTION = `Sök i cacheade kodtabeller (lazy-fill via kodtabell-endpoint) utan att dumpa hela tabellen i kontexten.

Input: objectType, query (t.ex. Gävleborg, bygg, verksam, 10-49), valfri category, limit (standard 25).
Svar: { matches: [{ objectType, category, code, label, kind }] }.

Fungerar för län/kommunnamn, statusetiketter, storleksklasser och SNI-text.`;

export const FILTER_HINTS_DESCRIPTION = `Statisk tabell frågeklass → rekommenderade kategorier/variabler/standardstatus. Ingen LLM.

questionClass: companies_in_region | workplaces_in_region | industry_and_place | name_contains | employee_size | organization_number.
Valfri objectType. Namn binds mot cachead katalog när den finns.`;

export const COMPILE_QUERY_DESCRIPTION = `Kompilera StructuredQuery till SCB-filter (dry-run). Ingen företags-/arbetsställe-sökning.

Princip: agenten förstår användaren; SCBmcp förstår SCB. Skicka INTE { text: "..." } eller fritext. Agenten äger objectType (company=JE / workplace=AE) — servern gissar inte.

industry är alltid objekt { query, level? }, aldrig en bar sträng. fields[] är semantiska id:n (name, organizationNumber, municipality, employeeCount) — inte SCB-namn som "OrgNr (10 siffror)".

Svar: { ok, objectType, layout, filters, resolved, coverage, warnings, unresolved }. Kompakt — ingen katalogdump.

coverage[] per villkor: { constraint, requested, applied, relation, exact, message }.
relation: exact | superset | subset | partial | unrepresentable.
Anställda 10–15 mot SCB-klass 10–19 → superset, exact=false. Aldrig tyst "exact" vid bandapproximation.

Kan träffa metadata/kodtabell internt (cache). Använd scb_count_then_fetch för räkna+hämta.`;

export const COUNT_THEN_FETCH_DESCRIPTION = `Kompilera StructuredQuery (om needed), räkna, hämta när 1≤count≤2000. Happy path: 1 verktygsanrop (eller compile + denna = 2).

Två inmatningar:
1) StructuredQuery — objectType (obligatorisk) + industry/geography/employees/status/maxRows/fields. Status default active. Coverage beräknas.
2) Redan kompilerat { objectType, filters, maxRows?, fields? }. Semantiska slotar ignoreras. Coverage för industry/geo/employees saknas då.

Vid count=0, QUERY_TOO_BROAD eller kompileringsfel: strukturerat fel med nextAction, coverage+resolved, inga stora payloads.
Vid träff: results med semantiska nycklar (name, organizationNumber, …) enligt resolved.fields, plus Reklam. coverage och resolved följer ALLTID med.

Ingen NL. Ingen server-LLM. Agenten äger objectType.`;

