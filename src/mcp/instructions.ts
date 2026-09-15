export const SERVER_INSTRUCTIONS = `Du är ansluten till SCB Allmänna företagsregister via MCP. Detta är ett dataåtkomstlager: ingen LLM, ingen paginering, ingen historik, inga andra källor.

Princip: **Agenten förstår användaren. SCBmcp förstår SCB.**
- Du (agenten) mappar naturligt språk → StructuredQuery. Skicka aldrig { text: "..." } hit för frågeförståelse.
- SCBmcp kompilerar StructuredQuery till SCB-kategorier, koder och serialisering från metadata. objectType är obligatorisk (company=JE, workplace=AE). Servern gissar inte JE/AE.

Objekttyper (alltid explicita):
- company = JE (juridisk enhet). Geografi = Säteslän / Säteskommun (säte), inte AE Län.
- workplace = AE (arbetsställe). Geografi = Län / Kommun (belägenhet).

Happy path (≤2 verktyg):
1. Valfritt scb_compile_query — dry-run, coverage (t.ex. anställda 10–15 mot klass 10–19 = superset, exact=false).
2. scb_count_then_fetch med samma StructuredQuery. Räknar, hämtar om 1≤count≤2000, projicerar semantiska fält. coverage+resolved följer med.

StructuredQuery: objectType; industry: { query, level? } (alltid objekt; koder från discovery/scb_lookup_codes mot SCB-metadata, inte query→kod-tabell; Bransch kräver Branschniva 1–3 — 2-siffrig bransch * behöver den inte); geography: { type: county|municipality|aregion, value }; employees: { min?, max? } → Anställda/Storleksklass Anställda (aldrig Omsättningsklass; 10–15 mot 10–19 = superset, exact=false); status: active|any (default active); maxRows; fields: semantiska id:n (name, organizationNumber, municipality, employeeCount) — inte SCB-namn.

Manuellt/avancerat (när du behöver råa SCB-filter):
1. scb_schema_summary för rätt objectType. Namn MÅSTE komma därifrån eller listverktygen.
2. scb_lookup_codes för koder från etiketter — inte includeCodeTables=true.
3. scb_explain_query (noll SCB-anrop) för serialiserad POST.
4. scb_count_* sedan scb_search_* (search räknar internt; återanvänd nylig count). count=0 → stanna. count>2000 → smalna, paginera inte.
5. Tomma filter = hela populationen (warning). SCB högst 2000 rader.

Anti-mönster:
- Namn innehåller "Bygg" ≠ SNI/bransch. StructuredQuery.industry.query slår upp koder; fritext "Bygg" i företagsnamn är ett annat filter.
- Operatorer är SCB-enum: Innehaller, ArLikaMed, BorjarPa, Mellan, FranOchMed, TillOchMed, Finns, FinnsInte — inte Contains/Equals.
- AnstSME ≠ Storleksklass Anställda. Numeriskt employees-intervall mappas till klasser med ärlig coverage (aldrig tyst exact vid bandapproximation).
- Behåll fältet Reklam; kringgå inte reklamspärr.
- Org.nr: katalogvariabler kan heta OrgNr (10/12 siffror); live hamta-rader har OrgNr/PeOrgNr (JE). Semantic organizationNumber mappar de nycklarna — skicka inte Finns för att “välja” kolumner.
- Ingen historik i detta API.
- Kvot: 10 anrop / 10 sekunder. Vid SCB_RATE_LIMITED: vänta retryAfterMs och upprepa samma anrop (retry_same). Servern väntar inte tyst.

Fel-JSON: läs nextAction (retry_same | retry_modified | abort_unanswerable) och nextTools. QUERY_TOO_BROAD och SCB_NO_MATCHES från scb_count_then_fetch innehåller coverage+resolved. SCB_UNKNOWN_* har nearestNames.`;

export function exploreSchemaPrompt(objectType: string): string {
  const layout = objectType === "workplace" ? "AE (workplace)" : "JE (company)";
  return `Utforska SCB-schemat för ${layout} innan du filtrerar.

1. Anropa scb_schema_summary med objectType="${objectType}". Använd exakta namn från categories[].name / variables[].name.
2. Anropa scb_lookup_codes för etiketter (Gävleborg, SNI-text, storleksklass). Träffar är filterklara (category+code). Dumpa inte SNI.
3. scb_get_category_values med query/limit om du behöver mer av en tabell. includeAll bara när tabellen är liten.
4. Gissa inte namn. "Län" är AE; "Säteslän" är JE. "Bygg" i företagsnamn är inte SNI.
5. Operatorer är SCB-enum (Innehaller, ArLikaMed, …), inte engelska Contains/Equals. branchLevel = Branschniva, bara på bransch.
6. Metadata cacheas i processen (timmar). Använd bypassCache bara för live-kontroller.`;
}

export function countThenFetchPrompt(objectType: string): string {
  const countTool = objectType === "workplace" ? "scb_count_workplaces" : "scb_count_companies";
  const searchTool = objectType === "workplace" ? "scb_search_workplaces" : "scb_search_companies";
  return `Räkna sedan hämta för objectType="${objectType}".

Föredra verktyget scb_count_then_fetch med StructuredQuery (agenten äger objectType; coverage följer med). Denna prompt är det manuella filterflödet.

1. Bygg filter med namn från listverktygen och koder från kodtabeller.
2. Anropa ${countTool} medan du itererar.
3. Om count=0: hämta inte. Kontrollera koder och om frågan egentligen är JE vs AE.
4. Om count>2000: paginera inte. Smalna med status, geografi, SNI eller storleksklass (se prompten scb_handle_too_broad).
5. Om 1≤count≤2000: anropa ${searchTool} med samma filter. Search räknar internt och återanvänder nylig count (~5 s) så du ska inte räkna en extra gång precis före hämtning.
6. Tomma filter ger warning (obegränsad population).`;
}

export function handleTooBroadPrompt(objectType: string): string {
  const geo =
    objectType === "workplace"
      ? "Län / Kommun (arbetsställets belägenhet). Gävleborg är AE Län, inte JE-säte."
      : "Säteslän / Säteskommun. Inte AE-kategorin Län om användaren inte menar säte.";
  const status =
    objectType === "workplace"
      ? "Arbetsställestatus (inte Företagsstatus)"
      : "Företagsstatus och Registreringsstatus";
  const countTool = objectType === "workplace" ? "scb_count_workplaces" : "scb_count_companies";
  return `Frågan var för bred (QUERY_TOO_BROAD, count>2000) för objectType="${objectType}".

Gör så här — utan att paginera och utan nya blinda SCB-prober i kaskad:
1. Läs details.appliedFilters, details.count, details.maxResults och details.candidateNarrowingDimensions.
2. nextAction=retry_modified. Anropa inte search med samma filter.
3. Lägg på saknade dimensioner i ungefär denna ordning:
   - status: ${status}
   - geografi: ${geo}
   - SNI/bransch via scb_lookup_codes (namn "Bygg" ≠ SNI) och ev. branchLevel (Branschniva)
   - Storleksklass Anställda (inte AnstSME om frågan gäller storleksklass)
   - namnvariabel med operator Innehaller bara om användaren vill ha namnträff
4. Anropa ${countTool} efter varje smalning. Hämta först när count≤2000.
5. Vid SCB_RATE_LIMITED: vänta retryAfterMs och upprepa samma anrop.`;
}
