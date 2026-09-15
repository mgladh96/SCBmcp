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

Föredra scb_query på happy path. När du utforskar råa SCB-namn: detta i stället för includeCodeTables=true. Koder: scb_lookup_codes (inte på varje fråga).`;

export const LOOKUP_CODES_DESCRIPTION = `Utforskningsverktyg — inte happy path. Föredra scb_query först. Använd vid status: "impossible" (andra vardagstermer) eller när du bläddrar koder; inte på varje fråga.

Sök i den lokala kodkatalogen (bundlad snapshot / in-memory index) utan att dumpa hela tabellen. Live-SCB anropas inte för discovery när katalogen är laddad. Alias: scb_discover (samma motor). Hitta inte på SNI-koder.

Input: objectType, query, valfri kind (industry|geography|size|status), category, parentCode, limit (standard 25).
Tom query + parentCode listar SNI-barn. Tom query + kind/category listar kodtabellvärden.

Svar: { matches: [{ objectType, kind, category, code, label, level?, parentCode?, hasChildren?, score }] }.
Varje träff är filterklar: kopiera category + code rakt in i count/search, eller skicka industry.codes till scb_query.
På kategorin Bransch: branchLevel = min(3, level) (bokstav→1, 2 siffror→2, 3+→3).

Discovery är metadata-driven (lexikal BM25-lik ranking mot katalogetiketter). Inga query→SNI-kod-mappningar. Språkalias expanderar bara söktérmer (städ→städning/städtjänster, bygg→byggverksamhet/byggnad), aldrig koder F/41/42/43.`;

export const DISCOVER_CODES_DESCRIPTION = LOOKUP_CODES_DESCRIPTION;

export const FILTER_HINTS_DESCRIPTION = `Statisk tabell frågeklass → rekommenderade kategorier/variabler/standardstatus. Ingen LLM.

questionClass: companies_in_region | workplaces_in_region | industry_and_place | name_contains | employee_size | organization_number.
Valfri objectType. Namn binds mot cachead katalog när den finns.`;

export const COMPILE_QUERY_DESCRIPTION = `Valfri dry-run — inte ett steg på happy path. Föredra scb_query för räkna+hämta.

Kompilerar StructuredQuery till SCB-filter. Ingen företags-/arbetsställe-sökning. Skicka INTE { text: "..." }. Agenten äger objectType (company=JE / workplace=AE).

industry: { query, level? } eller { codes, category?, branchLevel? } (aldrig bar sträng). codes från scb_query choose — query krävs då inte. Samma discoverCodes som scb_discover. Tvetydigt → choose+candidates (hitta inte på filter/SNI). Tomt → impossible.

Svar: { ok, status, objectType, layout, filters, resolved, coverage, warnings, unresolved }. Semantiska fields, inte SCB-namn.
coverage relation: exact | superset | subset | partial | unrepresentable. Anställda 10–15 mot 10–19 → superset, exact=false. Aldrig Omsättningsklass.`;

export const QUERY_DESCRIPTION = `Primär happy path — föredra detta först. StructuredQuery (inte { text: "..." }): objectType, industry, geography, employees, maxRows, fields.

Utfall:
- status: "ok" — använd count + rader; respektera coverage (superset/subset är inte exact).
- status: "choose" — välj bland max 5 filterklara candidates; anropa scb_query igen med industry.codes (query behövs inte). Ingen extra scb_discover.
- status: "impossible" — läs reason. Prova scb_discover med andra vardagstermer ELLER bredda villkor. Hitta inte på SNI-koder.

scb_discover / scb_lookup_codes bara vid utforskning, inte på varje fråga. scb_compile_query är valfri dry-run.

industry: { query, level? } eller { codes, category?, branchLevel? }. Status default active. Semantiska fields (name, organizationNumber, municipality, employeeCount). Katalogresolution är lokal; live-SCB bara för rakna/hamta.

Redan kompilerat { objectType, filters, maxRows?, fields? } fungerar (semantiska slotar ignoreras då). Alias: scb_count_then_fetch.`;

export const COUNT_THEN_FETCH_DESCRIPTION = `Alias för scb_query (samma motor). Föredra namnet scb_query.

${QUERY_DESCRIPTION}`;

