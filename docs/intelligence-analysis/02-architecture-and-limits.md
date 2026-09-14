# 02 — Nuvarande arkitektur och begränsningar

Analys av SCBmcp som **dataåtkomstlager** för SCB:s Allmänna företagsregister, med fokus på vad som stoppar en AI-agent från att själv utforska registret, förstå tillgänglig data, bygga korrekta frågor, känna igen obesvarbara frågor och iterera vid fel.

Underlag: `src/index.ts`, `src/mcp/*`, `src/scb/*`, `src/config/*`, `src/domain/*`, tester, skript och README på `main` (efter PR #1 bind/auth och PR #2 svensk README). Inga produktändringar i den här leveransen.

Kärnslutsats: servern är ett tunt, korrekt **RPC-lager mot SCB**. Den saknar de abstraktioner en agent behöver mellan naturlig fråga och SCB-anrop. Fler MCP-verktyg löser inte det. Det som saknas är katalog, planering, minne och vägledda fel — inte ytterligare `scb_*`-endpoints.

---

## 1. Arkitektur som den är byggd

### 1.1 Lager

```
AI-agent (Cursor / Claude / annan MCP-klient)
        │  HTTP SSE  /sse  +  POST /messages?sessionId=
        │  valfri Authorization: Bearer MCP_AUTH_TOKEN
        ▼
MCP HTTP-transport          src/mcp/http.ts, src/mcp/auth.ts
  sessioner = Map<sessionId, SSEServerTransport>
  en ny McpServer per SSE-anslutning
        ▼
MCP-verktyg                 src/mcp/server.ts, src/mcp/tools.ts
  Zod-input → ScbClient → JSON i text + structuredContent
        ▼
SCB-klient                  src/scb/client.ts
  rate limit → mTLS (undici Agent) → endpointkarta → payload
        ▼
SCB Allmänna företagsregister
  https://privateapi.scb.se/nv0101/v1/sokpavar
```

Processstart (`src/index.ts`):

1. `loadEnvFiles()` läser `.env.example` och sedan `.env` in i `process.env`.
2. `loadConfig()` validerar SCB-certifikatmiljö + MCP-bind.
3. En `ScbClient` skapas (certifikat laddas en gång).
4. En HTTP-server lyssnar. Health är oautentiserad. `/sse` och `/messages` kräver token om `MCP_AUTH_TOKEN` är satt.

Det finns **ingen stdio-transport** och ingen Streamable HTTP. Klienten måste peka på `http://127.0.0.1:3000/sse`.

### 1.2 Vad varje lager äger

| Lager | Filer | Ansvar | Vad det *inte* gör |
| --- | --- | --- | --- |
| Config | `src/config/env.ts` | Zod för env, loopback-check, `MCP_AUTH_TOKEN` | Standard dotenv-semantik (override, `.env.example` som mall) |
| MCP-auth | `src/mcp/auth.ts` | Bearer / `X-MCP-Auth`, timing-safe jämförelse | Sessionidentitet, användarroller |
| Transport | `src/mcp/http.ts` | SSE, CORS mot loopback-Origin, 401 | Schema, query, SCB |
| Tools | `src/mcp/server.ts`, `src/mcp/tools.ts` | Sju verktyg, inputvalidering, fel-JSON | Prompts, resources, outputSchema, instruktioner |
| Domain | `src/domain/errors.ts` | Maskinläsbara koder | Lokal filtervalidering mot katalog |
| SCB-klient | `src/scb/client.ts` | HTTP, count-then-search, felmappning | Cache, timeout, fältprojektion |
| Payload | `src/scb/payload.ts` | JE-exempelkropp, gissning av count/search-form | AE-toppfält, operatorenum, normaliserad metadata |
| Auth mot SCB | `src/scb/auth.ts` | `.pfx` + `api-id`-header | API-nyckel (kommande SCB-auth 2026) |
| Rate limit | `src/scb/rate-limit.ts` | 10 anrop / 10 s, *sover* vid tak | Signal till agenten, `Retry-After` |
| Endpoints | `src/scb/endpoints.ts` | JE/AE-sökvägar | Sammanslagna layouter |

### 1.3 MCP-ytan (sju verktyg, inget mer)

Registrering i `createMcpServer`: bara `registerTool`. Inga `instructions` på servern, inga MCP-prompts, inga resources, inga output-scheman.

| Verktyg | SCB | Beteende |
| --- | --- | --- |
| `scb_list_categories` | `koptakategorier` eller `kategoriermedkodtabeller` | Rå payload tillbaka |
| `scb_get_category_values` | POST `kodtabell` `{ Kategori }` | Rå payload |
| `scb_list_variables` | `koptavariabler` eller `variabler` | Rå payload |
| `scb_count_companies` | POST `raknaforetag` | Tal |
| `scb_search_companies` | count + `hamtaforetag` | Vägrar om count > 2 000 |
| `scb_count_workplaces` | POST `raknaarbetsstallen` | Tal |
| `scb_search_workplaces` | count + `hamtaarbetsstallen` | Vägrar om count > 2 000 |

JE och AE är explicita (`objectType: "company" | "workplace"`). Det är avsiktligt och bör behållas.

Filterkontraktet (`src/scb/schemas.ts`) är SCB-nära, inte ett DSL:

```json
{
  "filters": {
    "categories": [{ "category": "Företagsstatus", "values": ["1"], "branchLevel": 2 }],
    "variables": [{ "variable": "Firma", "operator": "Innehaller", "value": "Bygg", "value2": "" }]
  }
}
```

`operator` är `z.string().min(1)`. Tomma `categories`/`variables` är tillåtna. Ingen enum, ingen katalogkoppling.

### 1.4 Payload-översättning (den enda “intelligensen” idag)

`toScbQueryBody` är den enda plats där servern *tolkar* SCB:

- `Företagsstatus` och `Registreringsstatus` lyfts till toppnivå (sträng eller array).
- Övriga kategorier blir `Kategorier[].Kategori` + `Kod` (+ valfri `Branschniva`).
- Variabler blir `variabler[]` med `Variabel` / `Operator` / `Varde1` / `Varde2`.

Det är hårdkodat mot `/help/exampleJe`. AE-statusfält (`Arbetsställestatus` m.fl.) går i `Kategorier[]` om agenten skickar dem som vanliga kategorier.

Svarssidan är medvetet slapp:

- `parseListResponse` är identitet (`return payload`).
- `parseCountResponse` provar tal, sträng, sedan nycklarna `antal|Antal|count|Count|raknatAntal|RaknatAntal`.
- `parseSearchResponse` provar array, sedan `foretag|Foretag|arbetsstallen|...|results|data`.

`jsonResult` gör `structuredContent: payload as Record<string, unknown>` även när payload inte är ett objekt med kända fält. Smoke-skriptet gissar redan `categories.Kategorier.length` — alltså en nästlad SCB-form inuti MCP-omslaget.

### 1.5 Sökväg och kvot

`search*` **räknar alltid först**, även om agenten just körde `count*`. Ett lyckat sök kostar minst **två** SCB-anrop. Misslyckat sök (`QUERY_TOO_BROAD`) kostar ett. Metadata kostar ett per verktyg. Taket är 10 anrop / 10 sekunder per SCB-användare.

Klientens `SlidingWindowRateLimiter.acquire()` **väntar** istället för att kasta `SCB_RATE_LIMITED`. Koden `SCB_RATE_LIMITED` finns bara om SCB själv svarar 429. För agenten ser övertak ut som ett hängt verktygsanrop.

Ingen `fetch`-timeout. Ingen cache. Ingen fältprojektion. En sökning med 2 000 rader serialiseras som en enda JSON-text i MCP-svaret.

### 1.6 Auth och bind (efter PR #1)

Två olika förtroendegränser:

1. **Process → SCB:** mTLS `.pfx` + `api-id` (`src/scb/auth.ts`).
2. **MCP-klient → process:** `MCP_AUTH_TOKEN` på `/sse` och `/messages`.

Bind mot icke-loopback (`0.0.0.0`, `::`, LAN-IP) vägrar start utan token (`MCP_CONFIG_ERROR`). Loopback utan token startar fortfarande. CORS speglar bara loopback-`Origin`. Health exponerar inga hemligheter.

Det skyddar SCB-kvoten från slumpmässig nätåtkomst. Det hjälper inte agenten att *använda* API:et.

### 1.7 Vad README redan lägger på agenten

README:ns exempel (“aktiva byggföretag i Gävleborg med 10–49 anställda”) beskriver ett sexstegsflöde som **agenten**, inte servern, ska hålla i huvudet: lista metadata → hämta kodtabeller → räkna → avbryt vid 0 / begränsa vid > 2 000 / hämta vid ≤ 2 000 → resonera. Den påpekar också att Gävleborg är **län på AE** och **säteslän på JE**.

Det flödet är inte kod. Det är dokumentation. En agent som bara ser verktygsbeskrivningarna får en bråkdel av det.

### 1.8 Tester och verifiering

Enhetstester mockar HTTP. De täcker routing JE/AE, `QUERY_TOO_BROAD` utan `hamta*`, felkoder, rate-limit-sömn, MCP-auth och bind. De **fångar inte**:

- att metadataformen är instabil
- att AE-toppfält serialiseras fel
- att operator-/variabelnamn i README (`Företagsnamn`) skiljer sig från testpayload (`Firma`) och tredjepartsexempel (`Namn`)
- att live-sök mot smala filter fungerar

Live-testet (`tests/live/scb.live.test.ts`) listar bara JE-kategorier. `scripts/verify-live.ts` tar metadata + en count. Ingen automatiserad smal `hamtaforetag`.

---

## 2. Flaskhalsar rangordnade efter effekt på agents framgång

Rangordning: hur ofta en självständig agent misslyckas med en rimlig svensk företagsfråga, inte hur svårt det är att patcha.

### 1. Ingen schemakatalog — agenten måste återupptäcka SCB varje gång

**Symptom.** För att översätta “bygg i Gävleborg, 10–49 anställda” måste agenten veta:

- JE eller AE (län vs säteslän)
- exakta kategorinamn som *kontot* får använda
- kodvärden (Gävleborg ≠ `"Gävleborg"`; storleksklass 10–49 är **två** koder, `4` och `5`, inte en)
- vilka fält som är kategorier vs fritextvariabler
- tillåtna operatorer (`Innehaller` utan ä i API-exempel)

Allt det finns bara bakom SCB-anrop. Svaren är ornormaliserade. Kodtabeller (SNI, kommun, sektor) är stora. `includeCodeTables: true` dumpas rakt in i modellkontexten.

**Varför det sänker framgång.** Varje session bränner kvot på utforskning. Agenten gissar namn (`Företagsnamn` vs `Firma` vs `Namn`), gissar koder, och lär sig inte mellan anrop. Servern har noll processminne för katalog.

**Saknad abstraktion.** Processlokal **schemakatalog** (kategorier, variabler, kodtabeller, operatorer, JE/AE-tillhörighet) med TTL, sökbar utan extra SCB-anrop. Inte ett nytt “smart sök”-verktyg.

### 2. Filterkontraktet är SCB-form utan SCB-regler

**Symptom i kod.**

- Operatorer är fria strängar; README säger “kolla hjälpsidorna” (certifikatkrävande HTML som inte finns i repot).
- `TOP_LEVEL_CATEGORIES` är bara två JE-namn. AE-status hamnar sannolikt fel i kroppen.
- `branchLevel` / `Branschniva` är odokumenterat i verktygsbeskrivningen. SNI 2- vs 5-siffernivå och bransch 1+2+3 är just det fältet — och det är avgörande för “alla byggföretag”.
- Tomma filter är giltig Zod. Count av “alla företag” ger `QUERY_TOO_BROAD` eller ett enormt tal, inte “frågan saknar avgränsning”.
- README-exemplet använder `Företagsnamn` + `Innehaller`; `tests/payload.test.ts` använder `Firma`. SCB:s variabelbeskrivning har **båda**, med olika semantik (juridisk person vs Bolagsverket-firma). En agent som kopierar README träffar fel population.

**Varför det sänker framgång.** Agenten kan producera syntaktiskt giltiga anrop som SCB avvisar (`SCB_INVALID_QUERY` / `SCB_UNKNOWN_*`) eller som räknar fel sak. Felmappningen tittar bara efter delsträngarna `kategori` / `variabel` i HTTP-kroppen (första 500 tecken) och pekar inte ut *vilket* namn som var fel.

**Saknad abstraktion.** En **filterkompilator** mot katalogen: namn → kanoniskt fält, etikett → kod, operator → tillåten mängd, JE/AE-toppfält, varning vid tom population.

### 3. Ingen planeringsyta — README-flödet finns inte i runtime

**Symptom.** Verktygsbeskrivningarna säger “räkna före sök” och nämner 2 000-gränsen. De säger inte:

- när frågan är AE (adress, län, arbetsställe) vs JE (org.nr, säte, juridisk form)
- att historik, delta, ranking (“största i Sverige”), webb, ägare, koncern och berikning **inte finns**
- att “verksam” = `Företagsstatus=1` enligt SCB:s definition (moms och/eller F-skatt och/eller arbetsgivare) — inte Bolagsverkets status
- hur man ska reagera på count = 0 vs count > 2 000 vs `SCB_UNKNOWN_CATEGORY`

MCP-servern skapas med `{ name, version }` och inga `instructions`. Inga prompts. Inga resources med “kan / kan inte”.

**Varför det sänker framgång.** Agenten behandlar de sju verktygen som en generisk CRUD. Den hoppar till `search` med för breda filter, blandar JE/AE, eller försöker svara på obesvarbara frågor genom att anropa SCB tills kvoten tar slut.

**Saknad abstraktion.** Ett **planerings-/förmågelager** (gärna MCP-prompt + server `instructions` + en intern klassificerare, inte sju nya tools): fråga → JE | AE | obesvarbar | behöver koduppslag. Behåll SCB-verktygen som de är.

### 4. `QUERY_TOO_BROAD` är ett återvändsgränd, inte en loop

**Symptom.** `queryTooBroad` returnerar count, `maxResults: 2000` och den generiska strängen *“Narrow the query using additional SCB filters.”* Inga av de filter som redan skickades. Ingen lista över dimensioner som vanligtvis skär (status, län/säte, SNI, storleksklass, namn). Ingen skillnad mellan “2 001 träffar, lägg till kommun” och “1,3 miljoner träffar, du glömde allt”.

Search gör count internt, så agenten som redan räknade betalar kvoten två gånger. Om den sedan smalnar av och söker igen: ytterligare count + fetch.

SCB paginerar inte. Det är ett API-faktum, inte en bugg. Men felet ger ingen *nästa handling*.

**Varför det sänker framgång.** Agenten gissar en extra kategori, ofta fel (t.ex. `Län` på JE), får `SCB_UNKNOWN_CATEGORY` eller fortfarande för bred träff, och slutar eller hallucinerar en lista.

**Saknad abstraktion.** Felobjekt med **åtgärdsförslag från katalogen** + sessionens senaste filter. Eventuellt count-fördelning per dimension senare — det är struktur, inte ett extra `scb_search_narrow`-verktyg.

### 5. Lös svarstypning och kontextexplosion

**Symptom.**

- Metadata är `unknown`.
- Sökresultat är `unknown[]` med SCB:s fältnamn (`PeOrgNr`, `CfarNr`, `Reklam`, …).
- `Reklam` bevaras (rätt, reklamspärr ska inte strypas) men förklaras inte i svaret. En agent kan ignorera `21–23` och föreslå utskick.
- 2 000 rader × tiotals fält i en MCP-textblokk blåser kontextfönstret. Agenten “ser” data men kan inte resonera.
- `source` är inkonsistent: metadata/count använder strängen `SOURCE_LABEL`; search använder `{ provider, registry }`.

**Varför det sänker framgång.** Även när frågan är rätt ställd misslyckas *användningen* av svaret: fel fält, för stor payload, ingen vägledning om reklamspärr.

**Saknad abstraktion.** Stabil MCP-envelope (`objectType`, `items`, `fieldHints`) + **projektion/sampling** (fältlista, `limit`, sammanfattning). Fortfarande samma två sökverktyg.

### 6. Rate limit döljs som hängning; utforskning konkurrerar med svar

**Symptom.** 10 anrop / 10 s är SCB:s tak. En naiv agentloop:

1. list categories JE  
2. list variables JE  
3. kodtabell SNI  
4. kodtabell län  
5. kodtabell storlek  
6. count (för bred)  
7. count (smalare)  
8. search = count + fetch  

…ligger redan på eller över taket. Limiterern sover tyst. MCP-klienten timeoutar eller användaren avbryter. `retryable: true` på `SCB_RATE_LIMITED` / `SCB_UNAVAILABLE` finns, men den vanliga vägen är sömn utan feedback. Ingen `Retry-After`. Ingen kö per session.

**Varför det sänker framgång.** Utforskning och svar delar samma kvot. Utan katalogcache är “förstå data” och “hämta data” nollsummespel.

### 7. Obesvarbara frågor detekteras inte

API-fakta (SCB:s egen sida, september 2026):

- Endast aktuell information, ingen historik.
- Ingen delta/avisering i det avgiftsfria API:et.
- Ingen paginering *nu* (kommer i nytt API).
- “Verksam” ≠ “aktivt aktiebolag hos Bolagsverket”.
- Antal anställda är storleksklass, inte exakt tal (sekretess).
- Sammanslagna layouter (JE+huvud-AE, AE+företag) exponeras inte av den här servern — bara rena JE- och AE-endpoints.
- Servern berikar inte, skrapar inte, kör ingen LLM (README).

Ändå tar count/search emot vilken filterkropp som helst. Frågor som “hur såg Volvo ut 2019?”, “vem äger X?”, “lista Sveriges 50 största” eller “mejl till alla byggföretag i länet” blir antingen `QUERY_TOO_BROAD`, tom mängd, eller en lista som agenten använder fel (reklam, ranking som inte finns).

**Saknad abstraktion.** En **förmågemodell** (“den här frågan kan inte besvaras ur Allmänna företagsregistret, därför att …”) innan SCB anropas. Det är policy, inte fler endpoints.

### 8. Env-laddning kan göra hela servern osynlig för agenten

`loadEnvFiles` i `src/config/env.ts`:

1. Läser `.env.example` som riktig konfiguration.
2. Skriver *alltid* `process.env[key] = value` — även över redan satta variabler.
3. Läser därefter `.env` på samma sätt.

`.env.example` innehåller platshållare (`SCB_API_ID=API-ID`, `SCB_CERT_PATH="Path/to/certificate.pfx"`, `SCB_CERT_PASSWORD=Password`). Konsekvenser:

- Utan `.env` startar processen med ogiltigt certifikat → `SCB_AUTH_ERROR` vid `ScbClient`-konstruktion. Agenten ser inga verktyg.
- Docker/CI-env skrivs över av filerna. Motsatsen till dotenv-standard (`override: false`).
- `MCP_AUTH_TOKEN` i serverns `.env` måste matcha **klientens** env (`examples/mcp.json` använder `${env:MCP_AUTH_TOKEN}`). En agentklient utan header mot en token-skyddad server får 401 och “MCP saknas”.
- Header `SCB_API_ID_HEADER` default `api-id` är gissning; README säger “bekräfta mot SCB help”. Fel header → `SCB_AUTH_ERROR` som ser ut som certifikatfel.

Det här är en **startbarriär**, inte en query-bugg, men den sänker “agenten kommer igång alls” till noll.

### 9. Transport- och sessionsmodell utan agentminne

SSE-sessionen är bara transport (`Map` av `sessionId` → `SSEServerTransport`). Vid `onclose` raderas den. Ny `McpServer` per anslutning, men samma `ScbClient` (bra: gemensam limiter och cert).

Det som *inte* finns per session: senaste filter, senaste count, redan hämtade kodtabeller, JE/AE-beslut, “jag har redan listat kategorier”. Agenten har bara sin LLM-kontext, som rensas mellan chattar och konkurrerar med 2 000-raders JSON.

SSE-only är dessutom skört mot klienter som förväntar sig Streamable HTTP. Det är ett anslutningsproblem, inte ett queryproblem, men det syns som “verktygen finns inte”.

### 10. Felkoder är bra namn med tunn semantik

Katalog av koder i `src/domain/errors.ts` är en styrka. Luckor:

| Kod | När den faktiskt sätts | Vad agenten inte får |
| --- | --- | --- |
| `SCB_UNKNOWN_CATEGORY` / `_VARIABLE` | Heuristik på 400/404-body | Vilket namn, förslag från katalog |
| `SCB_INVALID_QUERY` | Zod-fel eller övrig 400 | SCB-regel som bröts |
| `QUERY_TOO_BROAD` | count > 2 000 | Nästa filterdimension |
| `SCB_RATE_LIMITED` | HTTP 429 | Nästan aldrig, pga lokal sömn |
| `SCB_RESPONSE_VALIDATION_ERROR` | Icke-JSON eller okänd count/search-form | Rå form för felsökning (delvis i `cause`) |
| `SCB_AUTH_ERROR` | Cert, 401/403, *och* ogiltig env | Blandar SCB-mTLS och lokal config |
| `MCP_CONFIG_ERROR` | Icke-loopback utan token | Inte en `ScbError`; bra uppdelning |
| `SCB_UNAVAILABLE` | 503, 5xx, övriga throw | Timeout finns inte som egen kod |

Lokal Zod-reject blir `SCB_INVALID_QUERY` med `issues: flatten()` — användbart men inte kopplat till SCB-katalogen.

### 11. Kommande SCB-API (september 2026) är ett arkitekturrisk, inte en agentbugg

SCB aviserar: certifikat → API-nyckel, paginering, högre hämtningstak, sökförändringar, sammanslagna layouter utgår, variabeländringar. Nuvarande API finns kvar minst sex månader.

Dagens kod speglar **nuvarande** certifikat-API tätt (`endpoints.ts`, `TOP_LEVEL_CATEGORIES`, 2 000-guard). En agentloop som hårdkodar dagens fältnamn i prompten blir dubbelt skör. En intern katalog + filterkompilator är den isolering som gör bytet hanterbart — återigen inte fler MCP-verktyg.

---

## 3. Vad som ska behållas vs ändras

### Behåll

- **Tunt dataåtkomstlager.** Ingen LLM i servern, ingen webskrapning, ingen berikning. Intelligence ska ligga *ovanpå* SCB-klienten, inte inuti den som “magisk sök”.
- **Explicit JE vs AE.** Inte `provider`. Objekttypen måste fortsätta vara synlig.
- **Count-before-fetch och 2 000-spärr.** Skyddar mot oavsiktlig full dump och följer SCB-kontraktet. Ändra *felets innehåll*, inte principen.
- **Maskinläsbara felkoder.** Utöka `details`, byt inte namn i onödan.
- **mTLS isolerat i `src/scb/auth.ts`.** Processen ska inte läcka nyckelbytes i loggar (redan sanitizer för password/pfx/token).
- **MCP-token + bind-säkerhet.** Rätt förtroendemodell: certifikat mot SCB, delad hemlighet mot MCP-klienter.
- **Bevara `Reklam`.** Ta inte bort spärren. Förklara den.
- **Endpointkarta som enda sanning** för sökvägar.
- **Zod på input** som startpunkt — men den måste kopplas till katalog.
- **En `ScbClient` per process** delad mellan SSE-sessioner (limiter och cert).

### Ändra (beteende, inte “fler tools”)

- Env-laddning: sluta behandla `.env.example` som runtime-config; skriv inte över befintlig env.
- Normalisera metadata- och sök-svar till ett stabilt envelope.
- Cache:a kataloganrop.
- Komplettera payload-översättning för AE och dokumentera toppfält från katalog, inte en hårdkodad mängd med två strängar.
- Rate limiter ska synas för agenten (väntetid eller `SCB_RATE_LIMITED` med `retryAfterMs`).
- `QUERY_TOO_BROAD.details` ska bära filter + konkreta nästa steg.
- MCP `instructions` + prompts för flödet som nu bara finns i README.
- Search ska kunna återanvända just genomförd count (samma filter, kort TTL) så kvoten inte dubbleras.
- Tydligare split `SCB_AUTH_ERROR` (mTLS mot SCB) vs lokal config.

### Lägg inte till i första hand

- Ett åttonde sökverktyg som tar naturligt språk.
- Generisk “query builder”-tool som bara är samma filter under nytt namn.
- Server-side LLM.
- Paginering mot nuvarande SCB (finns inte; låtsaspaginering ljuger).
- Dölja JE/AE bakom en unionstyp.

---

## 4. Konkreta förslag

### 4.1 Snabba vinster (liten yta, hög effekt på agentloopar)

1. **Fixa `loadEnvFiles`.** Läs bara `.env`. Sätt nycklar endast om de saknas i `process.env`. Behåll `.env.example` som dokumentation. Detta är en ren bugg mot dotenv-praxis och tar ner hela MCP:n.

2. **MCP-server `instructions` + 2–3 prompts.** Texten som redan finns i README (JE vs AE, räkna först, 2 000, ingen historik, reklam, “verksam”) ska injiceras där agenten faktiskt läser kontraktet. Prompts t.ex. `scb_explore_schema`, `scb_count_then_fetch`, `scb_handle_too_broad`. Inga nya SCB-anrop.

3. **Normalisera metadata-svar.** Oavsett om SCB skickar array eller `{ Kategorier: [...] }`, returnera `{ objectType, items: [{ name, … }], raw? }`. Samma för variabler och kodtabeller. Smoke-skriptet ska sluta gissa nästling. Det är typing, inte ett nytt tool.

4. **Berika `QUERY_TOO_BROAD`.** Inkludera `filters`, `count`, `maxResults`, och en fast lista *kandidatdimensioner* per `objectType` (JE: Företagsstatus, Säteslän/Säteskommun, SNI, storleksklass, namnvariabel; AE: Arbetsställestatus, Län/Kommun, SNI, storlek). Fortfarande utan att anropa SCB extra.

5. **Rate limit synligt.** Antingen returnera `SCB_RATE_LIMITED` med `retryAfterMs` när kön är full, eller logga och returnera `details.waitedMs` efter sömn. Hängda tools är värre än ett retrybart fel.

6. **Skippa dubbel-count.** Om `search*` anropas med samma serialiserade filter som en count inom t.ex. 5 s, återanvänd talet. Sparar 10 %–50 % av kvoten i typiska loopar.

7. **Varning vid tomma filter.** Zod kan fortsätta tillåta `[]`, men svaret bör sätta `warning: "unbounded query"` före SCB, eller kräva minst en kategori. Billig detektion av “lista alla företag”.

8. **Verktygsbeskrivningar: operatorer och namn.** Skriv in att operatorer skickas som SCB:s ASCII-form (`Innehaller`, inte `Innehåller`), att variabelnamn måste komma från `scb_list_variables` (inte README), och att 10–49 anställda är två storleksklasskoder. Det är dokumentation i schema, inte ny funktionalitet.

9. **`outputSchema` på tools** (när SDK-versionen tillåter) så klienter inte behandlar allt som fri text. Envelope: `{ count, returned, results, filters, source, error? }`.

10. **Processcache för `listCategories` / `listVariables` / `kodtabell`.** TTL i storleksordning timmar (SCB uppdaterar nattligen, de flesta variabler veckovis). Nyckel: `(layout, endpoint, category)`. Största kvotvinsten per rad kod.

11. **AE-toppfält.** Utöka eller *ersätt* `TOP_LEVEL_CATEGORIES` med katalogstyrd lista. Minst: spegla JE-mönstret för AE-status om exampleAe kräver det. Verifiera mot live `exampleAe`, inte gissning.

12. **Fel-`details.unknownName`.** När Zod är ok men SCB 400: inkludera skickat kategorinamn/variabel. Heuristiken `body.includes("kategori")` är för svag som enda signal.

### 4.2 Strukturellt (nya abstraktioner, samma sju SCB-verktyg)

Dessa är medvetet **inte** “lägg till tool X”. De är lager mellan agent och `ScbClient`.

```
Agent
  → Förmåga / plan     (obesvarbar | JE | AE | behöver uppslag)
  → Sessionminne       (filter, count, redan hämtad katalog)
  → Schemakatalog      (cache + sök i processminne)
  → Filterkompilator   (etikett→kod, operator, toppfält, Branschniva)
  → Befintliga MCP-tools / ScbClient
  → SCB
```

**A. Schemakatalog (högst ROI).** Vid start eller första anrop: hämta JE+AE kategorier och variabler, indexera på namn (skiftläge, å/ä/ö-varianter). Kodtabeller lazy + cache. Ge agenten *sök i katalogen* via resource eller ett enda `scb_lookup_field("Gävleborg")` **endast om** lookup inte kan göras som resource. Resource är att föredra: ingen extra kvot, ingen frestelse att bygga NL-sök.

**B. Förmågelager.** Statisk lista över vad API:et inte kan: historik, delta, exakt anställningsantal, ranking utan hämtning, koncern/ägare, webb, e-postkampanjer mot `Reklam` 21–23, “alla företag i Sverige”. Körs *före* SCB. Kan vara prompt + en intern funktion som tools anropar, inte ett synligt åttonde sök-API.

**C. Filterkompilator.** Input får fortsätta vara SCB-nära (behåll kontraktet) men kompilatorn:

- avvisar okända namn *lokalt* med förslag (`Firma` vs `Företagsnamn`)
- mappar toppfält per layout
- sätter `Branschniva` när kategorin är SNI
- översätter vanliga etiketter till koder när kodtabellen är cachad (“Gävleborg” → `21`)
- särskiljer storleksklassintervall som union av koder

Det är den saknade bron mellan naturligt språk (som agenten redan gör) och korrekt POST-kropp.

**D. Sessionminne.** Per MCP-session (redan finns `sessionId`): senaste `objectType`, filter, count, katalogträffar. Gör “iterera vid fel” möjligt utan att skicka 2 000 rader tillbaka in i prompten. Processglobalt räcker för en lokal Cursor-användare; nyckla på `sessionId` så två klienter inte blandar filter.

**E. Resultatbudget.** `search*` returnerar som standard t.ex. `results` trunkerade i MCP-lagret med `returned`, `omitted`, och valfri `fields`. SCB-hämtningen kan fortfarande vara upp till 2 000; agenten behöver sällan alla fält. Behåll rådata bakom flagga. Detta är kontextkontroll, inte paginering mot SCB.

**F. Observability för agentloopar.** Logga redan `tool`, `durationMs`, `errorCode`. Lägg till `sessionId`, `scbCallsInWindow`, `cacheHit`, `filterHash`. Utan det går det inte att mäta “framgångsgrad” efter ändringarna ovan.

**G. Transport.** Behåll SSE, lägg Streamable HTTP (och ev. stdio för lokal Cursor) som *samma* tool handlers. Auth/bind-regeln oförändrad. Det ökar “agenten hittar servern”, inte querykvalitet.

**H. Isolera SCB-kontraktet inför API-bytet 2026.** `endpoints.ts` + payload + auth ska kunna byta certifikat mot API-nyckel och 2 000 mot paginering utan att MCP-verktygsnamnen ändras. Katalog + kompilator är fasaden. Hårdkodade `TOP_LEVEL_CATEGORIES` och gissande parsers är det som måste dö först.

### 4.3 Föreslagen ordning (teknisk, inte kalender)

1. Env-laddning + synlig rate limit + QUERY_TOO_BROAD-details + MCP instructions/prompts.  
   Effekt: servern startar, agenten får ett flöde, fel går att iterera på.
2. Metadata-envelope + processcache för katalog.  
   Effekt: utforskning ryms i kvoten; svaren går att läsa.
3. Filterkompilator + AE-toppfält + lokal unknown-name.  
   Effekt: fler *korrekta* frågor, färre 400.
4. Förmågemodell + sessionminne + resultatbudget.  
   Effekt: obesvarbart stoppas; lyckade sök ryms i kontexten.
5. Streamable HTTP / stdio; förbered auth- och pagineringsadapter för SCB 2026.

Steg 1–2 är fortfarande samma sju verktyg. Om något synligt läggs till senare ska det vara **kataloguppslag eller resource**, inte ett parallellt sök-API.

---

## 5. Koppling till agentens fem jobb

| Agentjobb | Hur det fungerar idag | Vad som blockerar | Vad som faktiskt behövs |
| --- | --- | --- | --- |
| Utforska SCB | 3 metadata-tools × 2 objekttyper, varje gång mot nätet | Kvot, rå JSON, ingen cache | Katalog + cache + resource |
| Förstå tillgänglig data | Agenten ska läsa SCB-payload och PDF:er utanför MCP | Ingen förmågemodell, JE/AE-fällor, Firma/Företagsnamn | Envelope + instructions + katalogindex |
| Bygga korrekta frågor | Fri filterform, payload-quirk för två JE-fält | Operatorer, koder, Branschniva, tomma filter | Kompilator mot katalog |
| Upptäcka obesvarbart | Först efter SCB-fel eller 2 000-spärr | Historik/ranking/ägare ser ut som giltiga tools | Förmågelager före HTTP |
| Iterera på fel | Generisk suggestion, häng vid rate limit, ingen session | QUERY_TOO_BROAD, tyst limiter, dubbel count | Actionable errors + minne + synlig kvot |

SCBmcp är en bra SCB-klient med MCP-hölje. Den är inte ännu ett **arbetsminne** för en agent. Nästa steg är abstraktionerna ovan, inte en längre verktygslista.
