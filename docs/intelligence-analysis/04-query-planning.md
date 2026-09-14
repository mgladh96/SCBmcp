# 04 — Query planning och automatisk query-konstruktion

Analys av hur filter blir giltiga SCB-POST-kroppar idag, var intent→query bryts, och vilka **planeringshjälpare** som är värda att lägga på servern eller MCP-ytan. Ingen produktimplementation i det här dokumentet.

Relaterade analyser i samma serie: datamodell (SCB JE/AE), arkitektur och gränser, discovery/metadata, NL→SCB, fel och självkorrigering.

## 1. Slutsats i korthet

Servern är ett **serialiserings- och vaktlager**, inte en planner. Agenten måste själv:

1. välja JE (`company`) eller AE (`workplace`)
2. slå upp kategori-/variabelnamn mot metadata
3. lösa kodtabellvärden
4. gissa operatorer (passthrough)
5. räkna
6. om `QUERY_TOO_BROAD`: smalna av utan maskinläsbara ledtrådar
7. hämta (vilket räknar **en gång till**)

Det är rätt som dataåtkomstkontrakt. Det är svagt som väg från användarintent till en POST som SCB accepterar och som ryms inom 2 000 rader. Förbättringar ska sitta i **planering, förklaring och validering mot metadata** — inte som fler CRUD-verktyg som gör samma `rakna*` / `hamta*`.

## 2. Hur filter byggs idag

Tre lager, tre kontrakt:

```
MCP-input (Zod, engelska nycklar)
        ↓  scbFiltersSchema
ScbFilters { categories[], variables[] }
        ↓  toScbQueryBody()
SCB POST (svenska nycklar, exampleJe-form)
        ↓  ScbClient.request()
/api/je|ae/rakna*|hamta*
```

### 2.1 MCP-kontraktet (`src/scb/schemas.ts`)

`scbFiltersSchema` är gemensamt för count och search, JE och AE:

| Fält | Krav | Kommentar |
| --- | --- | --- |
| `categories[].category` | sträng ≥ 1 | Inget enum. Måste matcha SCB-namn **exakt**, inklusive versaler och diakriter. |
| `categories[].values` | minst en sträng | Kodvärden, inte etiketter. Ingen kodtabellkoll. |
| `categories[].branchLevel` | valfritt positivt heltal | Mappas till `Branschniva`. Ignoreras för toppnivåkategorier. |
| `variables[].variable` | sträng ≥ 1 | Fritextfilter, inte kodtabell. |
| `variables[].operator` | sträng ≥ 1 | **Valfri sträng.** Ingen katalog. |
| `variables[].value` / `value2` | valfria | Saknade värden blir `""` i POST:en. |

`filters` är obligatoriskt. Tomma listor är tillåtna (`default([])`). En agent kan alltså skicka `{ "filters": {} }` och få en POST `{}` som räknar **hela populationen**.

Count- och search-scheman är identiska. Det finns inget `objectType` på count/search: layouten sitter i **verktygsnamnet** (`scb_count_companies` vs `scb_count_workplaces`).

### 2.2 Serialisering (`src/scb/payload.ts`)

`toScbQueryBody` följer certifikatskyddade exempel på `/help/exampleJe`. Två kategorier lyfts ur `Kategorier[]`:

```ts
const TOP_LEVEL_CATEGORIES = new Set(["Företagsstatus", "Registreringsstatus"]);
```

Övriga kategorier blir `{ Kategori, Kod, Branschniva? }`. Variabler blir `variabler` (gemener) med `Variabel`, `Operator`, `Varde1`, `Varde2`.

Layoutagnostiskt: samma funktion används för JE och AE. `exampleAe` är inte kodad som eget specialfall.

### 2.3 Körning (`src/scb/client.ts` + MCP-verktyg)

| Verktyg | SCB-anrop | Guard |
| --- | --- | --- |
| `scb_count_companies` | `POST /api/je/raknaforetag` | — |
| `scb_search_companies` | `raknaforetag` **sedan** `hamtaforetag` | avvisar om count > 2 000 |
| `scb_count_workplaces` | `POST /api/ae/raknaarbetsstallen` | — |
| `scb_search_workplaces` | `raknaarbetsstallen` **sedan** `hamtaarbetsstallen` | samma |

Metadataverktygen (`scb_list_categories`, `scb_get_category_values`, `scb_list_variables`) tar `objectType` och slår upp JE- eller AE-endpoints. De matar inte in i `toScbQueryBody`. Kopplingen metadata → filter är **agentens** jobb.

### 2.4 Vad som *inte* valideras lokalt

Zod stoppar bara formfel (saknad `objectType`, tom `operator`-sträng, `values: []`). All semantik skjuts till SCB:

- okänt kategorinamn → HTTP 400/404 → `SCB_UNKNOWN_CATEGORY` om body innehåller `"kategori"`
- okänd variabel → `SCB_UNKNOWN_VARIABLE` om body innehåller `"variabel"`
- fel operator, fel kod, fel `Branschniva` → oftast `SCB_INVALID_QUERY` med en 500-teckens snippet
- fel layout (JE-kategori mot AE-endpoint) → samma, efter att ett anrop redan förbrukats

Det finns ingen dry-run, ingen förklaring av den POST som kommer att skickas, och ingen cache av metadata för lokal check.

## 3. Intent → giltig POST: var det tar stopp

README:ns exempelintent: *”Hitta aktiva byggföretag i Gävleborg med 10–49 anställda.”*

Ett lyckat flöde kräver ungefär:

```
intent
  → JE eller AE?
  → metadata (kategorier + variabler + kodtabeller)
  → SCB-namn och koder (inte "Gävleborg" / "bygg" / "aktiva")
  → operatorer för ev. fritext
  → POST-body (toppnivå vs Kategorier vs variabler)
  → count
  → ev. narrowing
  → fetch om ≤ 2 000
```

Varje pil är idag en agentgissning plus ett eller flera SCB-anrop. Rate limit är **10 anrop / 10 sekunder**. Discovery ensamt (list categories, list variables, flera kodtabeller) kan äta upp fönstret innan första count.

Nedan är de konkreta flaskhalsarna.

## 4. Count-then-fetch

`ScbClient.search` räknar alltid först, med samma filter, och hämtar bara om `count <= MAX_RESULTS` (2 000). Det är korrekt mot SCB:s tak och mot att API:et inte paginerar.

Tre problem för planering:

**Dubbel räkning mot README.** Verktygsbeskrivningarna säger *“Always count before scb_search_companies”*. README:n instruerar agenten att anropa `scb_count_*` och därefter `scb_search_*`. Search räknar ändå. Ett lyckat hämtningsflöde kostar **3** SCB-anrop (`rakna` + `rakna` + `hamta`) för samma filter.

**Count 0 hämtar ändå.** Guard:en är bara `count > 2000`. Tom träffmängd går vidare till `hamta*`. Onödigt anrop, extra latency, extra kvot.

**Observabilitet.** Den interna räkningen i search loggas med `tool: "scb_count_companies"` / `scb_count_workplaces`, inte search-verktyget. Planner- och felanalys blir svårare.

**Rekommendation (beteende, inte nytt CRUD):**

- Låt search fortsätta räkna före hämtning (behåll 2 000-vakten).
- Ändra tool descriptions / README: count är för **iterationsplanering**; search ska inte föregås av ett extra count när agenten redan tänker hämta.
- Hoppa över `hamta*` när `count === 0`; returnera `{ count: 0, returned: 0, results: [] }`.
- Överväg att logga intern räkning som del av search-verktyget.

Ett `skipCount`-flagga på search är **inte** värt det: det kringgår den enda säkra 2 000-vakten. Ett count-kvitto/token mellan verktygen är överdesign för den här ytan.

## 5. 2 000-radsvakten och avsaknad av paginering

SCB: högst 2 000 rader per hämtning, ingen paginering, ingen cursor. SCB har aviserat paginering i ett nytt API (september 2026). **Nuvarande kontrakt ska inte låtsas paginera.**

När count > 2 000 kastas:

```json
{
  "code": "QUERY_TOO_BROAD",
  "retryable": false,
  "details": {
    "count": 8432,
    "maxResults": 2000,
    "suggestion": "Narrow the query using additional SCB filters."
  }
}
```

Det är maskinläsbart som *felkod*, men värdelöst som *plan*. Agenten får inte:

- vilka filter som faktiskt skickades (finns i lyckade count-svar, inte i det här felet)
- vilka högvärdesdimensioner som saknas (status, geografi, SNI, storleksklass)
- om populationen kan delas (t.ex. per län) utan att överskrida taket per del
- om intentet troligen sitter på fel layout (JE vs AE)

Utan paginering är den enda lagliga strategin **smalare predikat** eller **partitionering i flera hämtningar**. Att klippa “första 2 000” vore tyst dataförlust och ska förbli förbjudet.

## 6. Operator-passthrough

`variableFilterSchema.operator` är `z.string().min(1)`. README: *“Operatorer skickas vidare till SCB; kontrollera tillåtna operatorer på SCB:s hjälpsidor.”* Hjälpsidorna kräver klientcertifikat och exponeras inte via MCP.

Konsekvenser:

- Agenten kopierar README-exemplet `Innehaller` även när operatorn inte gäller (likhet, intervall, prefix).
- `value2` finns i schemat för intervall (`Varde1`/`Varde2`) men inget säger när det krävs.
- Tom `value` serialiseras till `""`, vilket SCB kan tolka som “matcha tom sträng” eller avvisa — osynligt i Zod.
- Fel operator blir `SCB_INVALID_QUERY` eller `SCB_UNKNOWN_VARIABLE` beroende på SCB:s feltext, inte ett `SCB_UNKNOWN_OPERATOR`.

**Hårdkoda inte en operatorlista i den här analysen.** Den finns i `/help/exampleJe` och `/help/exampleAe`. En planner ska antingen:

1. läsa operatorer ur `scb_list_variables` när `includeValueMetadata` faktiskt innehåller dem, eller
2. dokumentera en katalog *efter* live-avläsning av help, som metadata — inte som gissning.

Tills dess är operatorer den största **lokalt ovaliderade** delen av POST-kroppen.

## 7. Specialfall: Företagsstatus och Registreringsstatus

### 7.1 Vad koden gör

Om `category` är exakt `"Företagsstatus"` eller `"Registreringsstatus"`:

- ett värde → toppnivåsträng, `{ "Företagsstatus": "1" }`
- flera värden → toppnivå**array**
- `branchLevel` slängs
- kategorin hamnar inte i `Kategorier[]`

Allt annat, inklusive `Arbetsställestatus`, går till `Kategorier[]`.

Tester täcker bara exampleJe (en statuskod vardera, plus `SätesKommun` + variabeln `Firma` / `Innehaller`). Array-formen för toppnivå är otestad mot skarp SCB. Live-skriptet räknar med båda statusfälten satta till `"1"`.

### 7.2 Namnkrockar som planner måste känna till

Minst tre namnrymder blandas:

| Källa | Statusfält på företag | “Registrerad” |
| --- | --- | --- |
| POST enligt `exampleJe` / `payload.ts` | `Företagsstatus` | `Registreringsstatus` |
| SCB variabelbeskrivning (publik) | Företagsstatus (0/1/9) | *Registrerad hos Skatteverket* (Jestat), koder 1/2/9 |
| Resultatpost (postbeskrivning JE) | `Företagsstatus, kod` + text | `Registrerad hos SKV, kod` |

På arbetsställe är motsvarande status **Arbetsställestatus** (0/1/9), inte Företagsstatus. Den lyfts **inte** till toppnivå.

Agentfel som servern inte fångar:

- `"företagsstatus"` / `"FöretagsStatus"` → hamnar i `Kategorier[]` → SCB-avvisning eller tyst felmatch.
- Publik etikett `"Registrerad hos Skatteverket"` som kategorinamn → samma.
- `Företagsstatus` på AE-sök: lyfts ändå till toppnivå i JSON:en (layoutagnostisk serialisering) trots att fältet hör till JE.
- Flera koder i `values` för toppnivå → array, medan exampleJe visar skalär.

### 7.3 Varför det spelar roll för narrowing

Utan `Företagsstatus=1` (verksam enligt SCB: moms och/eller F-skatt och/eller arbetsgivare) inkluderar en JE-fråga aldrig-verksamma (0) och ej verksamma (9). Det är den billigaste, mest deterministiska avsmalningen. `scripts/verify-live.ts` gör precis det: båda toppnivåstatusarna = `"1"`.

En planner som inte vet att de två namnen är **toppnivåundantag** kommer att:

1. antingen utelämna dem (QUERY_TOO_BROAD), eller
2. skicka dem som `Kategorier` och få `SCB_INVALID_QUERY`.

## 8. JE vs AE: valfel

`layoutFor("company") → "je"`, `layoutFor("workplace") → "ae"`. Verktygen är explicita. Det är bra. Felet är **vilket verktyg intentet ska använda**, inte att servern blandar layouter.

SCB:s egen FAQ: företag = juridisk enhet (org-/personnummer); arbetsställe = geografisk plats (CFAR). Alla företag har minst ett arbetsställe. “Företag i Gävleborg” är tvetydigt:

| Intent | Rätt layout | Rätt geografi |
| --- | --- | --- |
| Juridisk enhet med **säte** i Gävleborg | JE | säteslän / säteskommun (README-exemplet: `SätesKommun`) |
| Verksamhet som **bedrivs** i Gävleborg | AE | `Län` / `Kommun` på arbetsstället |
| “Byggföretag i Gävleborg med anställda” | ofta AE, ibland båda | SNI + storleksklass + status på rätt objekt |

README varnar redan: Gävleborg är län på arbetsställe; säteslän är JE-motsvarigheten. Agenten måste ta namnen från metadata. Ändå pekar exempelsteget på `scb_count_companies` för en fråga som geografiskt ofta är AE.

Följdfel:

- JE-sök med kategorin `Län` (AE) → `SCB_UNKNOWN_CATEGORY`.
- AE-sök med `Företagsstatus` → fel serialisering (se §7).
- Variabeln `Firma` (enskild näringsidkare, JE-tillägg) vs `Företagsnamn` (JE) vs `Benämning` (AE, populärnamn). README använder `Företagsnamn`; payload-testet använder `Firma`.
- Storleksklass anställda finns på båda men med olika kodtabeller/SME-indelning.

Det ska **inte** lösas med ett generiskt `scb_search`. Det ska lösas med en planeringssignal: “den här intent-dimensionen hör till JE/AE/båda”, plus explain som visar vilken endpoint POST:en träffar.

## 9. Narrowing när `QUERY_TOO_BROAD`

Idag: en engelskspråkig mening. Inga kandidater. Inga extra count-prober (vilket är bra — blinda prober bränner 10/10s).

En vettig **heuristisk ordning**, utan nya SCB-anrop, utifrån vad filtret *saknar*:

1. **Status** — JE: `Företagsstatus=1` och `Registreringsstatus=1` om namnen finns i metadata. AE: `Arbetsställestatus=1`.
2. **Geografi, grov → fin** — län (21 koder) före kommun (~290). På JE: säte, inte arbetsställeskommun.
3. **SNI / `Branschniva`** — avdelning är bred; femsiffrig bransch är smal. `branchLevel` bara på branschkategori i `Kategorier[]`.
4. **Storleksklass anställda** — t.ex. klassen för 10–49; inte fritext “10-49”.
5. **Fritextnamn** — `Innehaller` på rätt namnvariabel. Smalnar ofta för mycket (false negatives) och ska inte vara första steget för en populationsfråga.
6. **Partitionering** — om hela Sverige + SNI fortfarande är > 2 000: räkna per län, hämta de delar som är ≤ 2 000. Det är flera count+fetch, inte paginering. 21 län × (count + ev. fetch) slår rate limit; planner ska **lista** delarna, inte köra dem i en kaskad.

Vad som **inte** är narrowing:

- Hämta 2 000 och tiga om resten.
- Auto-retry i servern med slumpade extrafilter.
- Byta JE→AE tyst för att count blev lägre (annat objekt, annat svar).

`QUERY_TOO_BROAD.details` bör bära: `count`, `maxResults`, `objectType`, `filters` (som skickades), `serializedBody` (valfritt), `missingDimensions[]`, `suggestedFilters[]` (förslag, inte exekverade). `suggestion`-strängen kan vara svensk men ska inte vara enda signalen.

## 10. Förslag: server och tool-yta (utan redundant CRUD)

Målet är att korta vägen intent → **giltig, tillräckligt smal POST**, med minsta möjliga extra SCB-anrop.

### 10.1 Först: stärk befintliga verktyg

Ingen ny endpoint. Hög effekt, låg yta.

| Ändring | Var | Varför |
| --- | --- | --- |
| Tool descriptions: search räknar redan; count är för att iterera, inte ett krav före varje fetch | `src/mcp/server.ts`, README | Stoppa trippel-anropet |
| Hoppa `hamta*` vid count 0 | `ScbClient.search` | Sparar kvot |
| `QUERY_TOO_BROAD.details` enligt §9 | `queryTooBroad()` + search-handlers | Ger planner något att göra |
| Echo av serialiserad POST i lyckade count-svar | count-verktygen | Synliggör toppnivålyft och `variabler` |
| Beskriv toppnivåundantagen i search/count-descriptions | MCP `description` | Agenten ska inte behöva läsa `payload.ts` |
| JE-vs-AE-hint i descriptions (säte vs arbetsställesgeografi) | samma | Minskar fel layout |

Det här är **inte** nya CRUD-verktyg. Det är samma `rakna*` / `hamta*` med bättre planeringssignal.

### 10.2 Ett planeringsverktyg: `scb_explain_query` (dry-run)

Ett enda hjälpverktyg, samma `filters` + `objectType` (här behövs `objectType` eftersom explain inte är uppdelat på fyra count/search-namn).

**Gör:**

- Välj layout och rena sökvägar (`raknaforetag` vs `raknaarbetsstallen`, motsvarande `hamta*`).
- Kör `toScbQueryBody` och returnera JSON:en som *skulle* POSTas.
- Lista varningar lokalt, utan SCB-anrop:
  - tomma filter (hela populationen → nästan säkert TOO_BROAD)
  - saknad statusdimension för vald layout
  - kategori i `TOP_LEVEL_CATEGORIES` vs inte (lyft / icke-lyft)
  - flera värden på toppnivåfält (array vs skalär)
  - `Företagsstatus` / `Registreringsstatus` tillsammans med `workplace`
  - `branchLevel` på icke-bransch eller på toppnivå (ignoreras)
  - operator okänd lokalt (om ingen katalog finns: varna att den inte validerats)
- Returnera inte SCB-data. `dryRun: true` är inbyggt.

**Gör inte:** generisk sökning, “smart” JE/AE-omval, naturligt språk.

Alternativ till nytt verktygsnamn: `dryRun: true` på de fyra count/search-verktygen. Nackdel: fyra identiska grenar och risk att agenter sätter dry-run av misstag när de ville hämta. Ett separat explain är tydligare och duplicerar inte `hamta*`.

### 10.3 `validate-against-metadata` som *läge*, inte femte CRUD

Utöka explain (eller count) med `againstMetadata: true`:

1. Använd cachead `koptakategorier` / `koptavariabler` för vald layout (TTL, t.ex. processliv eller några timmar — metadata ändras inte per fråga).
2. Flagga kategorinamn och variabelnamn som inte finns.
3. Valfritt: kodtabell för de kategorier som används i filtret (`scb_get_category_values` per unik kategori, men **återanvänd** cache).
4. Returnera `{ ok, unknownCategories, unknownVariables, unknownCodes, warnings }`.

Det här är samma tre metadataverktyg som redan finns, orkestrerade. Lägg **inte** till `scb_validate_category` / `scb_validate_variable` / `scb_validate_code` som egna MCP-verktyg.

Första anropet i en session kan kosta 2–N SCB-anrop. Därefter ska planner-loopen vara lokal. Det är den enda hållbara relationen till 10/10s.

### 10.4 `suggest-narrowing` som struktur, inte auto-exekvering

Antingen fält på `QUERY_TOO_BROAD` eller ett anrop `scb_explain_query` med count inläst.

Utdata: prioriterad lista *kandidatfilter* (status, län, SNI-nivå, storleksklass) plus en **partitionsplan** (t.ex. “räkna per säteslän”) som agenten kan köra stegvis.

Servern ska inte själv spela 21 count mot SCB. Det vore en dold kvotbomb och ett nytt felbeteende (`SCB_RATE_LIMITED` mitt i “hjälpen”).

### 10.5 Flerstegs-planner: vad som räcker

En intern (inte nödvändigtvis MCP-exponerad) pipeline:

```
1. Välj layout (JE/AE) från intent-dimensioner — se NL-analysen
2. explain (lokal serialisering + varningar)
3. validate mot cachead metadata
4. count
5. om TOO_BROAD → suggest-narrowing → tillbaka till 2
6. om 0 → stopp (ingen hamta)
7. search (en intern count + hamta)
```

Steg 1 hör till NL→SCB. Steg 2–7 hör hit. MCP behöver inte ett `scb_plan_and_execute` som gömmer stegen: agenter ska kunna visa count och filter. Däremot kan serverkod dela en `planQuery(filters, objectType)`-funktion som explain, validate och error-details återanvänder — så att `toScbQueryBody` slutar vara den enda “planeringsdokumentationen”.

### 10.6 Vad som inte ska läggas till

| Inte | Varför |
| --- | --- |
| Generiskt `scb_search` / `scb_query` | Döljer JE vs AE; README förbjuder “provider”-abstraktion |
| `scb_get_company` / get-by-orgnr | Samma search med variabel `PeOrgNr` / `OrgNr`; nytt CRUD utan ny SCB-resurs |
| `scb_narrow_query` som kör prober | Rate limit; sidoeffekter |
| Offset/limit mot SCB | Finns inte; 2 000-vakten skulle ljuga |
| NL-verktyg på den här ytan | Eget spår (analys 05) |
| Auto-lyft av godtyckliga kategorier till toppnivå | Bara de namn exampleJe/exampleAe faktiskt kräver; AE-status ska bekräftas mot help innan kod |
| Hårdkodad svensk operator-enum utan help-dump | Falsk trygghet |

## 11. Prioriterad backlog (implementation senare)

1. **P0 — dokumentation och felkontrakt:** search räknar redan; `QUERY_TOO_BROAD.details` med filter, saknade dimensioner, narrowing-kandidater; hoppa fetch vid 0. Ingen ny tool.
2. **P1 — `scb_explain_query`:** layout, endpoint, serialiserad body, varningar inkl. toppnivåstatus och JE/AE-geografi. Noll SCB-anrop.
3. **P2 — metadata-cache + `againstMetadata`:** återanvänd befintliga list/kodtabell-anrop. Inga extra CRUD-namn.
4. **P3 — AE-toppnivå:** verifiera `/help/exampleAe` live. Om `Arbetsställestatus` är toppnivå, utöka `TOP_LEVEL_CATEGORIES` **per layout**, inte globalt.
5. **P4 — operatorer:** dumpa help eller `includeValueMetadata`; först därefter ev. enum/varning `unknown operator`.
6. **P5 — partitionsplan i explain** när count är känd och > 2 000 (lista, kör inte).
7. **Senare (nytt SCB-API):** när paginering finns, ersätt TOO_BROAD-antagandet. Inte förr.

## 12. Testluckor som planner-arbetet behöver

Befintliga tester låser exampleJe och 2 000-vakten. De låser inte planering:

- flera värden på `Företagsstatus` → array
- `Företagsstatus` på workplace-filter (fel layout)
- `Arbetsställestatus` serialisering
- tomma filter → `{}`
- search vid count 0 (går till `hamta*` idag)
- agentflödet count-sedan-search (två `rakna*`)
- felstavade toppnivånamn hamnar i `Kategorier`
- `branchLevel` på toppnivåkategori ignoreras tyst

Varje lucka är ett agentfel som idag bara syns som SCB 400 eller oväntat bred count.

## 13. Avgränsning mot övriga analyser

- **Discovery/metadata:** hur kategorilistor och kodtabeller ska cacheas och presenteras. Den här texten antar att namn kommer därifrån och föreslår bara att planner *konsumerar* dem.
- **NL→SCB:** mapping av fraser (“i Gävleborg”, “aktiva”, “bygg”) till dimensioner. Query planning tar vid när dimensionerna är valda.
- **Fel/självkorrigering:** hur agenten ska reagera på `SCB_UNKNOWN_*`. Här: vilka fel som är planeringsfel vs transportfel, och att TOO_BROAD ska bära nästa drag.

---

Källor i repot: `src/scb/schemas.ts`, `src/scb/payload.ts`, `src/scb/client.ts`, `src/scb/endpoints.ts`, `src/scb/types.ts`, `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/domain/errors.ts`, `tests/payload.test.ts`, `scripts/verify-live.ts`, README (agentflöde och gränser).

Publika SCB-källor (inte help, som är certifikatskyddad): [Avgiftsfria uppgifter i företagsregistret](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/avgiftsfria-uppgifter-i-foretagsregistret/) (2 000 rader, ingen paginering i nuvarande API, paginering aviserad 2026), variabelbeskrivning (Företagsstatus, Arbetsställestatus, säte vs län/kommun, Registrerad hos Skatteverket).
