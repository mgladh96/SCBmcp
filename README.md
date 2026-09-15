# SCB Allmänna företagsregister MCP-server

MCP-server som ger AI-agenter åtkomst till **SCB:s Allmänna företagsregister**.

Den är bara ett dataåtkomstlager för det API:et. Den söker inte i andra källor, berikar inte poster, skrapar inte webbplatser och kör ingen LLM.

## Vad servern gör

En agent kan:

1. Hämta en kompakt schemasammanfattning för JE eller AE (`scb_schema_summary`)
2. Kompilera StructuredQuery till SCB-filter (`scb_compile_query`) eller räkna+hämta (`scb_count_then_fetch`)
3. Söka i cacheade kodtabeller (`scb_lookup_codes`) — t.ex. Gävleborg → Län/`21`
4. Dry-run:a ett rått filter (`scb_explain_query`) och se serialiserad SCB POST **utan** HTTP mot SCB
5. Inspektera kategorier och variabler som det konfigurerade SCB-kontot får använda
6. Hämta kodtabeller för en kategori (sökbar, trunkerad; full dump bara vid explicit begäran)
7. Räkna företag (JE, juridisk enhet)
8. Hämta företag när antalet träffar är ≤ 2 000 (MCP projicerar fält och `maxRows`, standard 75)
9. Räkna arbetsställen (AE, arbetsställe)
10. Hämta arbetsställen

JE och AE anges alltid explicit. De döljs inte bakom generiska ”provider”-typer.

## Arkitektur

```
AI-agent
   ↓
MCP-server (HTTP + SSE)
http://127.0.0.1:3000/sse
   ↓
SCB-klient (mTLS, rate limit, skydd mot mer än 2 000 rader)
   ↓
SCB Allmänna företagsregister API
https://privateapi.scb.se/nv0101/v1/sokpavar/
```

MCP-lagret validerar verktygsinmatning och returnerar JSON. SCB-klienten ansvarar för HTTP, klientcertifikatet, sökvägar till endpoints och serialisering av POST-kroppar.

## Förutsättningar

- Node.js 22+
- pnpm
- Ett SCB-klientcertifikat (`.pfx`) och lösenord utfärdat av SCB
- API-id från certifikatnamnet (`AXXXXX`)

Ansök om åtkomst via [SCB:s information om API:et](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/avgiftsfria-uppgifter-i-foretagsregistret/) (`scbforetag@scb.se`).

## Konfiguration av SCB-certifikat

SCB autentiserar med klientcertifikat, inte med inloggningsformulär.

1. Lägg `.pfx`-filen där MCP-processen kan läsa den. Lägg den inte i git.
2. Förvara lösenordet i miljön, aldrig i källkoden.
3. Använd `SCB_API_ID` från certifikatnamnet (`AXXXXX`).

Certifikathantering ligger i `src/scb/auth.ts`. Resten av servern ser aldrig den privata nyckelns bytes annat än via TLS-dispatcher.

Hjälpsidor (certifikat krävs):

- https://privateapi.scb.se/nv0101/v1/sokpavar/help
- https://privateapi.scb.se/nv0101/v1/sokpavar/help/exampleJe
- https://privateapi.scb.se/nv0101/v1/sokpavar/help/exampleAe

## Miljövariabler

| Variabel | Obligatorisk | Beskrivning |
| --- | --- | --- |
| `SCB_BASE_URL` | nej | Standard `https://privateapi.scb.se/nv0101/v1/sokpavar` |
| `SCB_API_ID` | ja | API-id från certifikatnamnet |
| `SCB_CERT_PATH` | ja | Sökväg till `.pfx`-filen |
| `SCB_CERT_PASSWORD` | ja | Certifikatlösenord |
| `SCB_API_ID_HEADER` | nej | Headernamn för API-id. Standard `api-id`. Kontrollera mot SCB:s hjälpsidor om anrop avvisas. |
| `SCB_LOG_LEVEL` | nej | `debug`, `info` eller `error`. Loggar går till stderr. MCP-autentiseringstoken loggas aldrig. |
| `MCP_HOST` | nej | Bindadress. Standard `127.0.0.1`. Bindning mot annat än loopback (t.ex. `0.0.0.0`) kräver `MCP_AUTH_TOKEN`. |
| `MCP_PORT` | nej | HTTP-port. Standard `3000`. |
| `MCP_AUTH_TOKEN` | rekommenderas | Delad hemlighet för MCP HTTP/SSE (`/sse`, `/messages`). Obligatorisk när `MCP_HOST` inte är loopback. |
| `SCB_LIVE_TESTS` | nej | Sätt till `true` endast när du kör live-tester mot SCB |
| `SCB_METADATA_CACHE_BYPASS` | nej | `true` hoppar över processcachen för kategorier, variabler och kodtabeller |
| `SCB_AE_STATUS_TOP_LEVEL` | nej | **Default `true` (toppnivå) tills live `/help/exampleAe` bekräftas — ändras inte utan evidens.** `false` / `kategorier` skickar `Arbetsställestatus` i `Kategorier[]`. |

Kopiera `.env.example`. Lägg inte hemligheter i git.

Generera en token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Installation

```bash
pnpm install
```

## Köra lokalt

```bash
pnpm dev
```

Eller bygg:

```bash
pnpm build
pnpm start
```

Processen är en HTTP-server. MCP använder **SSE**:

- Health / URL-info: `http://127.0.0.1:3000/health` (ingen MCP-autentisering; exponerar inga hemligheter)
- SSE (klienter ansluter här): `http://127.0.0.1:3000/sse`
- Message POST: `http://127.0.0.1:3000/messages?sessionId=...`

När `MCP_AUTH_TOKEN` är satt krävs den för `/sse` och `/messages`. Skicka antingen:

- `Authorization: Bearer <token>`
- `X-MCP-Auth: <token>`

Oautentiserade MCP-anrop får **401**. Vid uppstart loggas `auth: "required"` eller `auth: "disabled"` — aldrig tokenvärdet.

Loggar går till stderr.

## Ansluta från Cursor / Claude / annan MCP-klient

Starta servern först, peka sedan klienten mot SSE-URL:en och skicka samma token som `MCP_AUTH_TOKEN`. Exempel på Cursor-konfiguration finns i `examples/mcp.json`:

```json
{
  "mcpServers": {
    "scb-foretagsregister": {
      "url": "http://127.0.0.1:3000/sse",
      "headers": {
        "Authorization": "Bearer ${env:MCP_AUTH_TOKEN}"
      }
    }
  }
}
```

Cursor hämtar `${env:MCP_AUTH_TOKEN}` från **klientens** miljö. Värdet måste matcha serverns `MCP_AUTH_TOKEN`.

SCB-certifikatinställningar ligger i serverns processmiljö (`.env`), inte i MCP-klientens konfiguration.

## MCP HTTP-autentisering och säker bindning

SCB-klientcertifikatet autentiserar den här processen **mot SCB**. En separat delad hemlighet autentiserar **MCP-klienter mot den här servern**, så att vem som helst som når porten inte kan förbruka SCB-kvoten.

- Sätt `MCP_AUTH_TOKEN` även på localhost. Loopback utan token startar fortfarande (för lokala kontroller), men `/sse` och `/messages` är då oautentiserade.
- Bindning mot en adress som inte är loopback (`0.0.0.0`, `::`, en LAN-IP) **vägrar att starta** om inte `MCP_AUTH_TOKEN` är satt.
- CORS är inte `Access-Control-Allow-Origin: *`. Loopback-`Origin`-värden kan speglas; `Authorization` och `X-MCP-Auth` är tillåtna headers.

## Tillgängliga MCP-verktyg

| Verktyg | Syfte |
| --- | --- |
| `scb_schema_summary` | Kompakt katalog för `company` (JE) eller `workplace` (AE): kind, serialisering, motparter, operatorer, filtertips. Ingen SNI-dump. |
| `scb_lookup_codes` | Sök i cacheade kodtabeller. `{ matches: [{ objectType, category, code, label, kind }] }`. |
| `scb_filter_hints` | Frågeklass → rekommenderade kategorier/variabler/standardstatus (statisk tabell). |
| `scb_list_categories` | Kategorier för `company` (JE) eller `workplace` (AE). Valfri `includeCodeTables`. Svar: `{ items, raw }` (även `categories` = raw). |
| `scb_get_category_values` | Kodtabell för en SCB-kategori. Valfri `query` + `limit` (standard ~50). Svar: `{ total, returned, items }`. Full dump bara med `includeAll` eller `limit=0`. |
| `scb_list_variables` | Variabler för kontot. Valfri `includeValueMetadata`. Svar: `{ items, raw }`. |
| `scb_count_companies` | Räkna JE-träffar |
| `scb_search_companies` | Hämta JE-träffar (räknar först; avvisar > 2 000; hoppar `hamta` vid count 0). Valfritt `fields[]` + `maxRows` (standard 75). |
| `scb_count_workplaces` | Räkna AE-träffar |
| `scb_search_workplaces` | Hämta AE-träffar (samma count-regler och projektion som JE) |
| `scb_explain_query` | Dry-run: layout, endpoints, serialiserad POST, varningar. **Noll** SCB-anrop. |
| `scb_compile_query` | StructuredQuery → SCB-filter + coverage (dry-run). Ingen JE/AE-sökning. |
| `scb_count_then_fetch` | Kompilera (om needed), räkna, hämta. Semantiska fält + coverage i svaret. |

MCP-prompts (ingen extra SCB-trafik): `scb_explore_schema`, `scb_count_then_fetch` (manuellt filterflöde; verktyget med samma namn är happy path), `scb_handle_too_broad`. MCP-resurs: `scb://operators`. Server-`instructions` upprepar arbetsflödet vid initialize.

### Princip: agenten = användaren, SCBmcp = SCB

LLM-agenten förstår användaren. **SCBmcp förstår SCB.** Agenten mappar naturligt språk till `StructuredQuery`. Servern kompilerar det till riktiga SCB-kategorier, koder och serialisering från metadata (plus en liten versionsmärkt synonymtabell). Servern tar **inte** emot `{ text: "..." }` för frågeförståelse och gissar **inte** `objectType`.

`objectType` är obligatorisk: `company` = JE, `workplace` = AE. Semantiska `fields` är id:n som `name`, `organizationNumber`, `municipality`, `employeeCount` — inte SCB-namn som `"OrgNr (10 siffror)"` eller `"SätesKommun"`. Mappingen ligger i `resolved.fields`.

Happy path: **högst två** MCP-anrop — valfritt `scb_compile_query`, sedan `scb_count_then_fetch`. Metadatauppslag sker internt.

### StructuredQuery

```json
{
  "objectType": "company",
  "industry": { "query": "bygg", "level": 1 },
  "geography": { "type": "county", "value": "Jämtland" },
  "employees": { "min": 10, "max": 15 },
  "status": "active",
  "maxRows": 50,
  "fields": ["name", "organizationNumber", "municipality", "employeeCount"]
}
```

- `industry` är **alltid** objekt `{ query, level? }`, aldrig en bar sträng.
- `status` default `active` (verksam, kod från kodtabellen). `any` utelämnar statusfilter.
- `scb_count_then_fetch` tar antingen StructuredQuery **eller** redan kompilerat `{ objectType, filters, maxRows?, fields? }`. Om `filters` finns används de som de är (semantiska slotar ignoreras; coverage för industry/geo/employees saknas då).

### Coverage

Varje approximerat villkor:

```json
{ "constraint": "employees", "requested": { "min": 10, "max": 15 }, "applied": {}, "relation": "superset", "exact": false, "message": "…" }
```

`relation`: `exact` | `superset` | `subset` | `partial` | `unrepresentable`.

SCB har storleksklasser, inte exakt headcount. Begärt 10–15 mot klass 10–19 är **superset**, `exact: false`, med tydligt meddelande — aldrig tyst exact. Coverage finns på både `scb_compile_query` och `scb_count_then_fetch` (även vid `QUERY_TOO_BROAD` / `SCB_NO_MATCHES`).

JE-geografi: county → Säteslän (live `Id_Kategori_JE`, inte AE `Län`). AE: county → `Län`. Benchmark: `pnpm golden-path` (mockad live-formad metadata).


Filterkontrakt (nära SCB, inte ett DSL för naturligt språk):

```json
{
  "filters": {
    "categories": [{ "category": "Företagsstatus", "values": ["1"] }],
    "variables": [
      {
        "variable": "Företagsnamn",
        "operator": "Innehaller",
        "value": "Bygg",
        "value2": ""
      }
    ]
  }
}
```

Använd **kategori- och variabelnamn som SCB returnerar dem** från `scb_schema_summary` eller listverktygen (`items[].name`). Hårdkoda inte ett eget schema.

Live `koptakategorier` (bekräftat mot privateapi.scb.se med mTLS) har **inga** fält `Kategori`/`Namn` på raderna. Namnet ligger i `Id_Kategori_JE` (JE) eller `Id_Kategori_AE` (AE); en AE-lista kan innehålla båda. Variabellistor använder `Id_Variabel_JE` / `Id_Variabel_AE` / `Id_Variabel` (t.ex. `{ "Id_Variabel_JE": "OrgNr (12 siffror)", "TillaggsGrupp": "BasUtbud" }`). Live JE-orgnr heter exakt `OrgNr (10 siffror)` och `OrgNr (12 siffror)` — **inte** `PeOrgNr` (SCB 400). Kodtabellrader är `{ "Varde": "21", "Text": "Gävleborg" }` — koden är `Varde`, etiketten är `Text`. `scb_lookup_codes` matchar etiketten och returnerar koden (`21`), inte etiketten som kod. Äldre nycklar (`Kategori`, `Variabel`, `Kod`, …) stöds fortfarande.

### Operatorer (allowlist)

Variabelfilter accepterar bara dessa SCB-operatorer (svenska namn, inte `Contains`/`Equals`):

| Operator | Arity | Kommentar |
| --- | --- | --- |
| `Innehaller` | 1 | Delsträng. Belagd i repo/exampleJe. |
| `ArLikaMed` | 1 | Exakt lika. |
| `BorjarPa` | 1 | Prefix. |
| `Mellan` | 2 | Intervall (`value` + `value2`). |
| `FranOchMed` | 1 | Nedre gräns. |
| `TillOchMed` | 1 | Övre gräns. |
| `Finns` | 0 | Värde finns. |
| `FinnsInte` | 0 | Värde saknas. |

`Innehaller` är verifierad mot exempel i den här kodbasen. Övriga namn är en **konservativ allowlist** utifrån SCB-hjälpexempel / kända sokpavar-klienter. **Verifiera mot** [`/help/exampleJe`](https://privateapi.scb.se/nv0101/v1/sokpavar/help/exampleJe) och [`/help/exampleAe`](https://privateapi.scb.se/nv0101/v1/sokpavar/help/exampleAe) (kräver klientcertifikat) innan listan behandlas som uttömmande. Okänd operator → `SCB_INVALID_QUERY` med `details.allowedOperators`.

`branchLevel` på en kategorifilterpost mappas till SCB `Branschniva`. Det är bara meningsfullt på bransch/SNI-kategorier; servern varnar om det sätts på status, geografi eller storlek. Toppnivåstatus ignorerar fältet.

Anti-mönster:

- Namn som innehåller `"Bygg"` är inte SNI — slå upp med `scb_lookup_codes`.
- Gävleborg som belägenhet är AE-kategorin `Län`, inte JE-säte (`Säteslän`) om användaren inte menar säte.
- `AnstSME` är inte samma sak som kategorin **Storleksklass Anställda**.
- Tomma `categories` och `variables` är giltiga men ger `warning` (obegränsad population).
- `includeCodeTables=true` dumpa inte SNI i agentkontexten.

Sökverktygen returnerar SCB-fältnamn som de tas emot, inklusive `Reklam` när SCB inkluderar det. Servern tar inte bort reklamspärrar och är inte ett sätt att kringgå dem.

### Fältprojektion och resultattak (`fields[]`, `maxRows`)

`scb_search_*` **hämtar hela SCB-resultatet** efter count-vakten (högst 2 000 rader, ett `hamta*`-anrop). `fields[]` och `maxRows` krymper **bara vad agenten ser** — de minskar inte SCB-kvoten och är inte paginering. Använd count-first och smala filter innan search.

| Parameter | Standard | Max |
| --- | --- | --- |
| `maxRows` | 75 | 2 000 |
| `fields[]` | identitet, namn, status, geografi, SNI/bransch, storleksklass, **Reklam** | — |

`Reklam` följer alltid med, även om `fields[]` utelämnar det.

Svarskuvert:

```json
{
  "count": 500,
  "fetched": 500,
  "returned": 75,
  "omittedByMaxRows": 425,
  "results": [],
  "filters": {},
  "warnings": ["MCP-svaret trunkerades till maxRows=75 …"],
  "source": { "provider": "SCB", "registry": "Allmänna företagsregistret" }
}
```

- `count` — SCB-populationen (rakna)
- `fetched` — rader i SCB:s hamta-svar
- `returned` — rader i `results` efter `maxRows`
- `omittedByMaxRows` — `fetched − returned` när MCP klippte; **inte** `count − returned`

### Identitet (`OrgNr (10 siffror)` / `OrgNr (12 siffror)` / CfarNr)

Inget eget lookup-verktyg. Använd `variables[]` med operator **`ArLikaMed`**. Live JE-variabler (koptavariabler, `Id_Variabel_JE`) heter exakt **`OrgNr (10 siffror)`** och **`OrgNr (12 siffror)`**. `PeOrgNr` saknas live (SCB 400: "Variabeln PeOrgNr kan inte hittas.") men känns fortfarande igen som alias i identitetssockret.

| Live variabel | Regel |
| --- | --- |
| `OrgNr (10 siffror)` | Behåller 10 siffror. 12-siffrigt med prefix 16/19/20 kapas. Luhn-kontroll. |
| `OrgNr (12 siffror)` | 10-siffrigt organisationsnummer (månadsdelen position 3–4 ≥ 20) → prefix `16`. 12-siffrigt `16` + orgnr (juridisk person) eller `19`/`20` + personnummer behålls. |
| CfarNr | 8 siffror, SCB-tilldelat arbetsställenummer. |
| PeOrgNr (alias) | Samma 12-siffriga normalisering som `OrgNr (12 siffror)`. Skicka inte till SCB live på JE. |

Bindestreck och blanksteg strippas. 10-siffriga värden med månad 01–12 avvisas som personnummer-lika (ange 12 siffror med sekel). Månad 13–19 är skräp (organisationsnummer har månad ≥ 20). Skräp (bokstäver, fel längd, dålig kontrollsiffra) ger `SCB_INVALID_QUERY` utan SCB-anrop.

Personnummer-lika identitetsvärden loggas inte i klartext.

### `scb_explain_query` (dry-run)

Samma `objectType` + `filters` som count/search. Returnerar `layout`, `endpoints` (rakna/hamta-sökvägar), **`serializedBody`** (det som skulle POSTas), operatorvalidering, identitetsnormalisering och varningar (tomma filter, `branchLevel` på icke-bransch, JE/AE-geografi). `dryRun: true`. Inga SCB-anrop — använd före kvotbränning.

### AE-status i POST-kroppen

JE: `Företagsstatus` och `Registreringsstatus` är toppnivåfält (belagt mot `/help/exampleJe`).

AE: `Arbetsställestatus` serialiseras som **toppnivåfält** (samma mönster som JE). **Det är inte live-bekräftat mot `/help/exampleAe` i den här miljön** (certifikat krävs). Defaulten (`SCB_AE_STATUS_TOP_LEVEL` på / toppnivå) **ändras inte utan evidens**.

Bekräfta så här:

1. `GET https://privateapi.scb.se/nv0101/v1/sokpavar/help/exampleAe` med klientcertifikat.
2. Om `Arbetsställestatus` är toppnivå: behåll default.
3. Om den ligger i `Kategorier[]`: sätt `SCB_AE_STATUS_TOP_LEVEL=false` och starta om.

`scb_explain_query` (workplace) returnerar `serialization.aeStatusNote`, `aeStatusEnvVar` och `liveConfirm`. `scb_schema_summary` sätter `serialization: "top-level"` när flaggan är på.

`Företagsstatus` på AE-layout lyfts **inte** till toppnivå (hamnar i `Kategorier[]`).

## Exempel på agentflöde

Användare: ”Hitta aktiva byggföretag i Jämtland med 10–15 anställda.”

**Happy path (≤2 verktyg):** agenten sätter `objectType: "company"` (säte) och anropar `scb_count_then_fetch` med StructuredQuery (`industry.query: "bygg"`, `geography: { type: "county", value: "Jämtland" }`, `employees: { min: 10, max: 15 }`). Valfritt `scb_compile_query` först för att läsa coverage (anställda blir SCB-klass 10–19, `superset`). Inte `schema_summary` + `lookup_codes` i det här flödet.

**Manuellt filterflöde** (när du behöver råa SCB-namn):

1. `scb_schema_summary` för `objectType: "workplace"` (belägenhet) eller `"company"` (säte) — inte `includeCodeTables: true`
2. `scb_lookup_codes` med `query: "Gävleborg"`, `"bygg"`, `"10-49"`, `"verksam"`
3. Valfritt `scb_explain_query` — noll kvot — för att se POST-kropp och varningar
4. `scb_count_workplaces` / `scb_count_companies` med de koderna
5. Om count är 0, stanna (search hoppar över `hamta*`). Om count > 2000, begränsa filtren — paginera inte. Om count ≤ 2000, fortsätt
6. `scb_search_*` med samma filter. Search räknar internt och **återanvänder** en nylig count (ca 5 s). SCB hämtar hela mängden; `maxRows` (standard 75) och `fields[]` krymper bara agentvyn. `Reklam` följer med.
7. Resonera utifrån JSON:en som SCB returnerar

Gävleborg är ett **län** på arbetsställe i SCB:s variabelbeskrivning; säteslän är motsvarigheten på företagsnivå. Agenten måste hämta det från SCB-metadata, inte från den här README:n. `scb_compile_query` gör den uppslagningen när du skickar StructuredQuery.

## SCB-gränser

- Högst **2 000** rader per hämtningsanrop
- **Ingen paginering**
- **10** anrop per **10 sekunder** per användare
- HTTP **503** vid driftstörningar
- Endast aktuell information (ingen historik i det här API:et)

Om count > 2 000 returnerar verktygen:

```json
{
  "code": "QUERY_TOO_BROAD",
  "message": "...",
  "retryable": false,
  "nextAction": "retry_modified",
  "nextTools": ["scb_count_companies", "scb_list_categories", "scb_get_category_values"],
  "details": {
    "count": 8432,
    "maxResults": 2000,
    "objectType": "company",
    "layout": "je",
    "appliedFilters": { "categories": [], "variables": [] },
    "candidateNarrowingDimensions": [],
    "doNotPaginate": true,
    "suggestion": "Smalna frågan med fler SCB-kategorier (status, geografi, SNI, storleksklass). Paginera inte."
  }
}
```

`candidateNarrowingDimensions` är per JE/AE (status, geografi, SNI, storleksklass, namnvariabel). När katalogen är cachead används **faktiska kategorinamn** från `koptakategorier`, inte bara statiska engelska strängar.

Lokalt rate limit (10 / 10 s) **väntar inte tyst**. Agenten får `SCB_RATE_LIMITED` med `nextAction: "retry_same"` och `details.retryAfterMs`. HTTP 429 från SCB mappar samma kod. Loggar kan innehålla `waitedMs` (0 när anropet avvisas lokalt).

Kategorier, variabler och kodtabeller cacheas i processen i flera timmar (SCB uppdaterar över natten). `bypassCache` på metadataverktygen eller `SCB_METADATA_CACHE_BYPASS=true` tvingar live-anrop. `scb_schema_summary` och `scb_lookup_codes` återanvänder samma cache.

## Köra tester

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm golden-path
```

### Offline eval-svit

`tests/eval/fixtures.json` innehåller 32 svenska frågor med förväntad `objectType`, kategorinamn, JE vs AE-noter och om frågan är besvarbar ur AFR. Runners (`tests/eval/eval.test.ts`, ingår i `pnpm test`) är **deterministiska**: `filterHintsFor`, `layoutHint`, koduppslag mot mockad katalog, identitetsnormalisering. Ingen LLM-domare.

Lägg till en fixture:

1. Ny rad i `tests/eval/fixtures.json` med unikt `id`, `question`, `expectedObjectType` (`company` \| `workplace` \| `both` \| `none`), `expectedCategories`, `answerable`, `notes`.
2. Valfritt `questionClass` (samma enum som `scb_filter_hints`), `expectedVariables`, `lookup` `{ query, objectType, expectedCategory, expectedCode }`, `identity` `{ input, kind: peOrgNr|cfarNr, expected?, invalid? }`, `layoutTrap`.
3. Kör `pnpm test`.

Live-tester mot SCB ingår **inte** i `pnpm test`. De kräver ett riktigt certifikat och:

```bash
# PowerShell
$env:SCB_LIVE_TESTS="true"
pnpm test:live
```

## Fel

Maskinläsbar JSON. `code`-strängarna är oförändrade. Dessutom: `nextAction` (`retry_same` | `retry_modified` | `abort_unanswerable`) och ofta `nextTools`, plus `details.unknownName` / `details.field` när det går.

- `SCB_AUTH_ERROR` — `abort_unanswerable` (operatör/certifikat)
- `SCB_RATE_LIMITED` — `retry_same`, `details.retryAfterMs`
- `SCB_UNAVAILABLE` — `retry_same`
- `SCB_INVALID_QUERY` — `retry_modified` (kolla listverktygen / operatorer). Ogiltig operator ger `details.allowedOperators`
- `SCB_UNKNOWN_CATEGORY` — `retry_modified`, `nearestNames[]` + ev. `layoutHint` när katalogen är cachead
- `SCB_UNKNOWN_VARIABLE` — `retry_modified`, `nearestNames[]` när katalogen är cachead
- `QUERY_TOO_BROAD` — `retry_modified`, smalna filter, paginera inte. `candidateNarrowingDimensions` använder katalognamn när de finns
- `SCB_RESPONSE_VALIDATION_ERROR` — `abort_unanswerable`
- `SCB_NO_MATCHES` — `retry_modified` från `scb_count_then_fetch` när count=0 (coverage+resolved i `details`, ingen hamta)

## Live-verifiering mot SCB

Certifikatautentisering, JE/AE-metadata, kodtabell och `raknaforetag` har verifierats mot SCB:s skarpa API med ett riktigt `.pfx`. POST-kroppar följer `/help/exampleJe`. AE `Arbetsställestatus` som toppnivå **är inte live-bekräftat mot `/help/exampleAe`**. Default `SCB_AE_STATUS_TOP_LEVEL` är på; om exampleAe visar `Kategorier[]` sätt `false`. Defaulten ändras inte utan evidens. Sökning av resultatmängder större än 2 000 avvisas (`QUERY_TOO_BROAD`); den vägen bör kontrolleras med ett smalt filter.
