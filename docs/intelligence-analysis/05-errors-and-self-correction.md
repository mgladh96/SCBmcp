# 05 — Felhantering, självkorrigering och agentens iterationsloop

**Status:** analys, ingen produktkod.  
**Scope:** vad MCP-verktygen returnerar vid fel, hur `ScbError` / `mapHttpError` / rate limit / `QUERY_TOO_BROAD` / auth beter sig, och vilka signaler som saknas för att en agent ska kunna rätta sig på nästa anrop.  
**Kodbas:** `main` efter #1 (MCP-token) och #2 (svensk README).

---

## 1. Slutsats

Felkontraktet är **maskinläsbart men inte agent-styrande**. Agenten får `code`, `message`, `retryable` och en lös `details`-påse. Det räcker för att *klassificera* ett fel. Det räcker inte för att *välja nästa korrekta verktygsanrop*.

Tre luckor sänker lyckandefrekvensen på retries mer än något annat:

1. **`retryable` är binärt.** `false` betyder “försök inte samma anrop igen”, men agenten behöver tre utfall: *vänta och upprepa*, *ändra argument*, *ge upp mot det här API:et*.
2. **Okända fält namnges inte.** `SCB_UNKNOWN_CATEGORY` / `SCB_UNKNOWN_VARIABLE` säger inte *vilket* namn som avvisades, och pekar inte tillbaka till `scb_list_categories` / `scb_list_variables`.
3. **`QUERY_TOO_BROAD` föreslår inte *hur* frågan ska smalnas.** Förslaget är en engelsk mening. Filtren som just kördes, `objectType` och konkreta nästa dimensioner (status, geografi, SNI, storleksklass) saknas.

Därutöver syns **rate limit nästan aldrig för agenten**: klienten väntar tyst i processen. 429 mappas till `SCB_RATE_LIMITED` utan `Retry-After`. Nollträffar är **framgång**, inte fel, så agenten får ingen ledtråd när frågan inte går att besvara med Allmänna företagsregistret.

Nedan: kartläggning av dagens kontrakt, var loopen fastnar, saknade signaler, och konkreta förbättringar i prioriterad ordning.

---

## 2. Vad agenten faktiskt ser

Fel går tre vägar. Bara den första är ett MCP-verktygssvar.

| Väg | När | Vad agenten / klienten ser | Kan agenten rätta sig? |
| --- | --- | --- | --- |
| Verktygsfel | Handler fångar `ScbError` eller okänt undantag | MCP `CallToolResult` med `isError: true`, `content[0].text` = JSON, samma objekt i `structuredContent` | Ja, om JSON:en är handlingsbar |
| Transport/auth mot MCP | Saknad/fel `MCP_AUTH_TOKEN` på `/sse` eller `/messages` | HTTP **401** `{ error, message }`, `WWW-Authenticate: Bearer` | Nej. Operatör måste rätta klientheader |
| Processen startar inte | Ogiltig SCB-env, saknad `.pfx`, bind utan token | stderr-JSON + `process.exit(1)`. Ingen SSE | Nej. Operatör |

### 2.1 Verktygssvaret (`errorResult`)

`src/mcp/tools.ts` serialiserar alltid samma form:

```json
{
  "code": "QUERY_TOO_BROAD",
  "message": "Query matched 8432 rows; SCB returns at most 2000 rows and does not paginate.",
  "retryable": false,
  "details": { }
}
```

Det är rätt MCP-mönster (`isError` + textinnehåll, inte ett JSON-RPC-protokollfel). Agenten *ser* payloaden. Lyckade anrop sätter inte `isError: false` explicit (`undefined`), vilket klienter behandlar som framgång.

Okända undantag blir `SCB_UNAVAILABLE` / `retryable: true` / tom `details`. Det är för optimistiskt: ett programmeringsfel ska inte retrys:as mot SCB.

### 2.2 Vad som *inte* följer med

- Inget `nextAction` / `nextTools[]`
- Ingen `retryAfterMs`
- Inget `field` / `unknownValue` för det som SCB avvisade
- Inga `appliedFilters` eller `objectType` på sökfel
- Ingen `unanswerableWithThisApi`
- Inget `correlationId` som binder MCP-loggraden till SCB-anropet
- Verktygsbeskrivningarna nämner `QUERY_TOO_BROAD` för sökverktygen, men inga andra koder och ingen retry-strategi

Zod-fel vid ogiltig input *är* relativt handlingsbara: `details.issues` är `ZodError.flatten()` (`formErrors` / `fieldErrors`). Meddelandet är däremot bara `"Invalid input for scb_…"`. Agenten måste läsa `flatten()` själv. Det finns inget exempel på giltig form i felsvaret.

---

## 3. Katalog: `ScbErrorCode`

Källor: `src/domain/errors.ts`, `src/scb/client.ts`, `src/scb/auth.ts`, `src/config/env.ts`, `src/mcp/tools.ts`.

| Kod | `retryable` idag | Uppstår | Vad agenten rimligen borde göra | Vad som saknas för att den ska göra det |
| --- | --- | --- | --- | --- |
| `SCB_AUTH_ERROR` | `false` | Saknad env, saknad `.pfx`, PFX går inte att läsa, TLS-handshake, HTTP 401/403 från SCB | **Ge upp.** Certifikat/API-id är operatörsproblem. | Skilj *startup-konfig* från *SCB avvisade anropet*. Peka inte på att byta filter. |
| `SCB_RATE_LIMITED` | `true` | HTTP 429 från SCB | Vänta, sänk parallellitet, räkna inte om i onödan | `retryAfterMs`; kvot kvar; att klienten redan kan ha väntat tyst |
| `SCB_UNAVAILABLE` | `true` | HTTP 503 / ≥500, nätverksfel, icke-`ScbError` | Vänta och upprepa *samma* anrop ett par gånger | `retryAfterMs`; max försök; 503 vs DNS vs timeout |
| `SCB_INVALID_QUERY` | `false` | Zod-input **eller** SCB 400/404 utan “kategori”/“variabel” **eller** övriga HTTP-statusar | Beror på orsak — två olika fel i samma kod | Orsaksklass (`input` vs `scb_rejected`); vilket fält; giltiga operatorer |
| `SCB_UNKNOWN_CATEGORY` | `false` | 400/404 vars body innehåller `kategori` | Lista kategorier, använd SCB:s namn, hämta kodtabell | **Vilken** sträng som skickades; `nextTools: ["scb_list_categories"]` |
| `SCB_UNKNOWN_VARIABLE` | `false` | 400/404 vars body innehåller `variabel` | Lista variabler; rätta namn/operator | **Vilken** variabel; `nextTools: ["scb_list_variables"]` |
| `QUERY_TOO_BROAD` | `false` | `count > 2000` före `hamta*` | Smalna filter, räkna om, hämta inte | Konkreta nästa filter; `objectType`; hur långt över taket |
| `SCB_RESPONSE_VALIDATION_ERROR` | `false` | Icke-JSON, oparsbar count/search-body | Ge upp eller rapportera till operatör | Inte agent-retrybart; ev. raw `payloadKind` för diagnostik |

`McpConfigError` (`MCP_CONFIG_ERROR`) finns utanför den här unionen. Den når aldrig ett verktygssvar.

`retryable: false` på `QUERY_TOO_BROAD`, `SCB_UNKNOWN_*` och Zod-`SCB_INVALID_QUERY` är **korrekt för identiskt retry**, men många agenter tolkar `retryable: false` som “sluta”. Det är den enskilt största semantiska fällan.

---

## 4. `mapHttpError`

```57:106:src/domain/errors.ts
export function mapHttpError(status: number, bodyText: string): ScbError {
  const snippet = bodyText.slice(0, 500);
  if (status === 401 || status === 403) { /* SCB_AUTH_ERROR */ }
  if (status === 429) { /* SCB_RATE_LIMITED, hårdkodat 10/10s */ }
  if (status === 503) { /* SCB_UNAVAILABLE */ }
  const lower = bodyText.toLowerCase();
  if (status === 400 || status === 404) {
    if (lower.includes("kategori")) { /* SCB_UNKNOWN_CATEGORY */ }
    if (lower.includes("variabel")) { /* SCB_UNKNOWN_VARIABLE */ }
    return /* SCB_INVALID_QUERY */;
  }
  if (status >= 500) { /* SCB_UNAVAILABLE */ }
  return /* SCB_INVALID_QUERY */;
}
```

### 4.1 Vad som fungerar

- 503 skiljs från “dålig fråga” (testat).
- 401 → auth (testat).
- 429 → rate limit (testat).
- “Okänd kategori” → `SCB_UNKNOWN_CATEGORY` (testat).
- Body-snippet (500 tecken) följer med i `details.body` så en människa kan läsa SCB:s text.

### 4.2 Heuristikens felmoder

| Fall | Utfall idag | Effekt på agenten |
| --- | --- | --- |
| Body innehåller både “kategori” och “variabel” | Alltid `SCB_UNKNOWN_CATEGORY` (första träffen) | Agenten listar kategorier när det var variabeln som var fel |
| SCB ekar request-JSON (`Kategori` / `Variabel` i 400-body) | Falsk `SCB_UNKNOWN_*` | Fel retry-gren |
| Engelsk SCB-text (“unknown category”) | `SCB_INVALID_QUERY` | Generisk “query rejected”, ingen metadata-hint |
| 404 för fel sökväg vs okänd kodtabell | Samma gren | Agenten “rättar” filter när URL/layout är fel |
| 403 (cert OK, konto saknar rättighet) | `SCB_AUTH_ERROR` som 401 | Agenten kan inte skilja “fel cert” från “kontot får inte den här resursen” |
| 408 / 502 / 504 | 502/504 = `SCB_UNAVAILABLE`; 408 = `SCB_INVALID_QUERY` (`retryable: false`) | Timeout klassas som ogiltig fråga — **fel retry-semantik** |
| Headers (`Retry-After`, `X-Request-Id`) | Ignoreras. `request()` skickar bara `status` + `text` | Ingen väntetid, ingen korrelation |
| JSON-body parsas inte | Substring på råtext | Inget `field` extraheras ens när SCB skickar det |

Tester täcker 503, 401, 429 och “Okänd kategori”. **Inte** 403, 404, 408, 500, `SCB_UNKNOWN_VARIABLE`, eller kroppar med båda nyckelorden.

---

## 5. Rate limiting — två lager, en synlig yta

SCB: 10 anrop / 10 sekunder / användare. Klienten speglar det med `SlidingWindowRateLimiter` (`src/scb/rate-limit.ts`) **före** `fetch`.

```
Agent → MCP-verktyg → rateLimiter.acquire() → SCB
                         └ väntar tyst om fönstret är fullt
```

### 5.1 Klientlimiter (det vanliga fallet)

- 11:e anropet *sleep:ar* tills äldsta timestamp faller ur 10 s-fönstret (`window − (now − oldest) + 1` ms).
- Agenten får **inget fel**. Verktyget bara hänger.
- Väntetid loggas inte (`durationMs` inkluderar sömnen, men `errorCode` / `waitedMs` saknas).
- `outstanding` finns på limiter-klassen men exponeras inte.

Det här är bra mot SCB (vi bränner inte kvoten) och dåligt för agenten:

- MCP-klienter har ofta timeout (tiotals sekunder). En kö av metadataanrop + `count` + intern `count` i `search` kan lägga sig mot den.
- Timeout → agenten retrys → mer tryck på samma fönster.
- `search_*` tar **två** SCB-anrop (räkna + hämta). Agenten som redan räknat förbrukar tre platser för en sökning.
- Typiskt utforskande varv: `list_categories` + `list_variables` + N× `get_category_values` + `count` + `search` överskrider 10/10s utan att agenten vet om det.

### 5.2 HTTP 429 (`SCB_RATE_LIMITED`)

Nås bara om SCB ändå nekar (annan process med samma cert, klockdrift, limiter ur synk). Då:

- `retryable: true`
- meddelande hårdkodat: `"SCB rate limit exceeded (10 calls per 10 seconds)."`
- **ingen** `retryAfterMs`, ingen parsning av `Retry-After`
- ingen ledtråd att slå ihop anrop eller skippa om-räkning

Agent som följer `retryable: true` utan backoff spammar. Agent som saknar backoff-policy ger upp efter ett 429.

### 5.3 Förbättring som höjer retry-lycka

Ändra policyn från “vänta obegränsat tyst” till “vänta kort, annars lämna tillbaka kontrollen”:

- Om väntan ≤ t.ex. 1–2 s: vänta (behåll SCB-skyddet).
- Om väntan är längre: returnera `SCB_RATE_LIMITED` med `retryAfterMs`, `outstanding`, `limit: 10`, `windowMs: 10000`, `nextAction: "wait_then_retry_same"`.
- Logga `waitedMs` även när vi väntar tyst.
- I sökverktygens beskrivning: “search gör count+fetch; anropa inte count separat om du ändå ska hämta.”

---

## 6. `QUERY_TOO_BROAD`

Guard i `ScbClient.search`: räkna först, kasta om `count > MAX_RESULTS` (2000), **hämta aldrig** (`hamtaforetag` / `hamtaarbetsstallen`). Det är rätt mot SCB (ingen paginering, max 2000 rader).

```44:54:src/domain/errors.ts
export function queryTooBroad(count: number, maxResults: number): ScbError {
  return new ScbError(
    "QUERY_TOO_BROAD",
    `Query matched ${count} rows; SCB returns at most ${maxResults} rows and does not paginate.`,
    false,
    {
      count,
      maxResults,
      suggestion: "Narrow the query using additional SCB filters.",
    },
  );
}
```

### 6.1 Vad som är bra

- Agenten får `count` och `maxResults` — den vet *hur* bred frågan är.
- Inget dyrt/otillåtet hämtanrop.
- MCP-testet verifierar att `hamta*` inte anropas.

### 6.2 Varför agenten ändå misslyckas på retry

`retryable: false` + vagt `suggestion` ger tre typiska dåliga loopar:

1. **Ger upp** och svarar användaren “för många träffar” utan att smalna.
2. **Samma filter igen** (ignorerar `retryable`, eller tolkar suggestion som “försök search en gång till”).
3. **Gissar filter** (svenska länsnamn i stället för kod, fel `objectType`, `Företagsnamn` contains “AB”) som antingen ger `SCB_UNKNOWN_*`, nollträffar, eller fortfarande > 2000.

Saknas i `details`:

| Fält | Varför det spelar roll |
| --- | --- |
| `objectType` (`company` / `workplace`) | Gävleborg är län på AE; säteslän på JE. Fel layout går inte att smalna “lite till”. |
| `filters` som just skickades | Agenten ser inte vad som redan är pålagt. |
| `overBy` (`count - maxResults`) | 2001 vs 180 000 kräver olika strategi. |
| `suggestedDimensions[]` | Status, registrering, geografi, SNI + `branchLevel`, storleksklass — i den ordningen. |
| `nextTools` | `scb_get_category_values` för de dimensionerna, sedan `scb_count_*` (inte `search_*`). |
| `doNotPaginate: true` | Stoppar “offset/page”-fantasier. |

`count_*` returnerar stora tal som **framgång**. README säger att agenten ska smalna när count > 2000, men count-verktygen upprepar inte `QUERY_TOO_BROAD`. En agent som bara räknar får ingen `code` att hänga en policy på — bara ett heltal. Det är OK om beskrivningen är tydlig; idag nämner count-verktygen taket men returnerar ingen strukturerad “för bred”-signal.

---

## 7. Auth-fel — tre olika problem, en kod

### 7.1 SCB mot den här processen (mTLS + API-id)

| Källa | Kod | Når agenten? |
| --- | --- | --- |
| `loadConfig` saknar `SCB_API_ID` / cert-path / lösenord | `SCB_AUTH_ERROR` | Nej (exit 1) |
| `.pfx` saknas eller går inte att läsa | `SCB_AUTH_ERROR` (`details.field`) | Nej om det sker i konstruktorn vid start |
| TLS-handshake (strängmatch på `certificate` / `pfx` / `cert` / `alert` / `handshake`) | `SCB_AUTH_ERROR` | Ja, som verktygsfel om anropet kommer så långt |
| HTTP 401/403 | `SCB_AUTH_ERROR` | Ja |

`toScbError` matchar `"cert"` i **vilket** felmeddelande som helst. Ett nätverksfel som råkar innehålla “certificate” (t.ex. CA-bundle) blir auth. För bred heuristik.

`retryable: false` är rätt: agenten kan inte laga certifikatet. Meddelandet (“rejected the client certificate or API id”) blandar två operatörsåtgärder. `SCB_API_ID_HEADER` (standard `api-id`) nämns i README men inte i felsvaret — fel headernamn ser ut som certifikatfel.

### 7.2 MCP-klient mot den här processen (delad hemlighet)

HTTP 401 på `/sse` och `/messages` är **inte** `SCB_AUTH_ERROR`. Body:

```json
{ "error": "Unauthorized", "message": "Missing or invalid MCP auth token." }
```

I Cursor/Claude ser det ut som “MCP-servern kräver auth”, inte som ett SCB-fel. Bra att koderna inte blandas. Dåligt: ingen `code`-nyckel, ingen hint om `Authorization: Bearer` vs `X-MCP-Auth`, ingen koppling till `examples/mcp.json`. Det är operatörs-UX, inte agent-retry.

### 7.3 Bind-säkerhet

`MCP_HOST=0.0.0.0` utan token → `MCP_CONFIG_ERROR`, exit 1. Syns inte i README:s fel-lista.

**Agent-implikation:** auth-fel ska *aldrig* trigga filterbyte. Dagens JSON saknar `nextAction: "abort_operator"` så en naiv agent kan ändå börja “felsöka frågan”.

---

## 8. Loggning — operatörssignal, inte agentsignal

JSON-rader till **stderr** (`src/log.ts`). Agenten ser dem inte.

| Händelse | Nivå | Fält | Lucka |
| --- | --- | --- | --- |
| SCB OK | `info` | `tool`, `endpoint`, `durationMs`, `status` | Ingen `waitedMs`; body/filter loggas inte (bra, PII) |
| SCB fail | `error` | samma + `errorCode` | Ingen `message`, ingen `retryable`, `status` kan vara `0` före HTTP |
| MCP-verktyg OK | `info` | `tool`, `durationMs`, `status: 200` (hårdkodat), `count` / `objectType` | `status: 200` är inte SCB:s status |
| MCP-verktyg fail | `error` | `tool`, `durationMs`, `errorCode` | Dubbelloggas med SCB-klienten för HTTP-fel. `QUERY_TOO_BROAD` loggas som error trots att det är en affärsregel |
| SSE | `info`/`error` | `sessionId`, `endpoint` | HTTP-handler-fel loggar `error.name`, inte `ScbError.code` |
| Startup | `info` | `auth: required\|disabled` | Token loggas inte (bra) |
| `debug` | — | — | Används inte i klienten |

Sanering (`password|passphrase|pfx|cert|token|secret|authorization`) är rimlig. Bieffekt: ett fält som heter `errorCode` är säkert; ett hypotetiskt `certificateFingerprint` skulle tyst droppas.

För agent-självkorrigering hjälper loggarna **inte**. De hjälper operatören att se *att* något failade, sällan *varför* (ingen SCB-body, ingen filter-sammanfattning).

Rekommenderad loggform vid fel (fortfarande inte till agenten): `errorCode`, `retryable`, `status`, `tool`, `objectType`, `waitedMs`, `durationMs`, ev. hash/längd på filter — inte råa företagsnamn.

---

## 9. Agentens iterationsloop — var den fastnar

README:s tänkta loop:

1. Lista kategorier/variabler  
2. Kodtabeller  
3. `count`  
4. 0 → stanna; \>2000 → smalna; ≤2000 → `search`  
5. Resonera på SCB-JSON  

Verktygen **tvingar inte** den loopen. De validerar form, inte strategi.

### 9.1 Loop som *kan* lyckas med dagens kontrakt

- Zod-fel med `fieldErrors.objectType` → agenten byter `"provider"` mot `"company"` / `"workplace"`. Testat.
- `QUERY_TOO_BROAD` med `count: 2100` och en agent som redan kan SCB-kategorier → lägg på `Företagsstatus` och räkna om.
- 503 med `retryable: true` → vänta och upprepa.

### 9.2 Loopar som bränner försök utan att närma sig svaret

| Stimulus | Agentens felsteg | Rot i kontraktet |
| --- | --- | --- |
| Okänt kategorinamn (“Bransch”, “Län”, “Gävleborg”) | Gissar engelska/synonymer i stället för `scb_list_categories` | `SCB_UNKNOWN_CATEGORY` utan `field` och `nextTools` |
| Kod vs etikett (`"Gävleborg"` i stället för `"21"`) | SCB kan acceptera och ge 0, eller avvisa | 0 är success; ingen “värdet matchade inte kodtabellen”-signal |
| JE-verktyg för AE-fråga (länsfilter) | Smalnar JE-filter i evighet | Ingen `objectTypeHint`; README varnar i prosa, inte i JSON |
| `count = 0` | README: “stanna”. Ofta var det fel kod/layout | Ingen `emptyResultGuidance` |
| `count = 0` efter många byten | Fortsätter mutera filter | Ingen `unanswerableWithThisApi` (historik, e-post, koncern, UC …) |
| `QUERY_TOO_BROAD` | Anropar `search` igen eller lägger på fritext | `retryable: false` + vagt suggestion; count-verktyget ger ingen kod |
| Operator `"contains"` / `"="` | `SCB_INVALID_QUERY` med SCB-snippet | Operatorer är fria strängar; ingen enum, ingen `SCB_UNKNOWN_OPERATOR` |
| Burst av kodtabeller | Timeout eller plötsligt 429 | Tyst wait; ingen kvot i svaret |
| `search` efter egen `count` | Dubbel count, kvot | Inte dokumenterat i felsvar |
| Auth/TLS | Byter filter | `SCB_AUTH_ERROR` saknar `abort` |

### 9.3 “Stanna vid count 0” är för aggressivt

README steg 4 säger att agenten ska stanna vid 0. Det skär av den *riktiga* självkorrigeringen (fel kodtabell, fel JE/AE). Nollträff ska vara **“verifiera metadata, byt inte slumpfilter, ge upp efter N metadata-checkar”**, inte tyst stopp.

---

## 10. Saknade signaler (prioriterad lista)

Det användaren (och agenten) behöver, mot vad som finns:

| Signal | Finns idag? | Var den ska sitta |
| --- | --- | --- |
| Föreslagna alternativa filter / dimensioner | Bara en engelsk mening på `QUERY_TOO_BROAD` | `details.suggestedDimensions`, `details.suggestion` (svenska + maskinlista) |
| Vilket fält som var okänt | Nej (ev. gömt i `details.body`) | `details.field`, `details.submittedValue` |
| `Retry-After` / `retryAfterMs` | Nej | `details.retryAfterMs` på `SCB_RATE_LIMITED` och `SCB_UNAVAILABLE` |
| “Frågan går inte att besvara med det här API:et” | Nej | Ny kod eller `details.unanswerableWithThisApi` + `reason` |
| `nextAction`: `retry_same` / `retry_modified` / `abort_operator` / `abort_unanswerable` | Nej (`retryable` bool) | Toppnivå i fel-JSON, *vid sidan av* `retryable` (behåll bakåtkomp) |
| `nextTools[]` | Nej (lite i tool descriptions) | Fel-JSON + kort hint i tool description |
| `objectType` + `appliedFilters` på sök-/räknefel | Nej | `QUERY_TOO_BROAD` och `SCB_INVALID_QUERY` från SCB |
| Tomt resultat som *vägledning* | `count: 0` som success | Antingen `warnings[]` i success eller separat `SCB_NO_MATCHES` med hints (inte `isError` om det stör klienter) |
| Ogiltig operator | Passthrough → SCB 400 | `SCB_UNKNOWN_OPERATOR` eller Zod-enum när operatorlistan är känd |
| Paginering / historik / andra källor | Bara README-prosa | `unanswerableWithThisApi` när agenten *frågar verktyget* om det; annars tool description |
| Kvot / `waitedMs` | Nej | Logg alltid; agent vid 429 eller lång kö |

`Reklam` returneras men förklaras inte vid fel. En agent som jagar telefon/e-post efter en lyckad sökning får ingen “det här fältet är reklamspärr, API:et ger inte kontaktuppgifter”-signal. Det är ett *unanswerable*-fall efter success.

---

## 11. Föreslaget felkontrakt (bakåtkompatibelt)

Behåll `code`, `message`, `retryable`, `details`. Lägg till fält som agenter kan switch:a på. Exempel:

### 11.1 För bred fråga

```json
{
  "code": "QUERY_TOO_BROAD",
  "message": "Frågan matchade 8432 rader. SCB lämnar ut högst 2000 och paginerar inte.",
  "retryable": false,
  "nextAction": "retry_modified",
  "nextTools": ["scb_get_category_values", "scb_count_companies"],
  "details": {
    "count": 8432,
    "maxResults": 2000,
    "overBy": 6432,
    "objectType": "company",
    "appliedFilters": {
      "categories": [{ "category": "Företagsstatus", "values": ["1"] }],
      "variables": []
    },
    "suggestedDimensions": [
      { "category": "Registreringsstatus", "why": "Oftast första billiga smalningen på JE." },
      { "categoryHint": "SätesLän eller SätesKommun", "why": "Geografi på företag är säte, inte arbetsställets län. Bekräfta namn via scb_list_categories." },
      { "categoryHint": "SNI / bransch", "useBranchLevel": true, "why": "Hög kardinalitet; sätt Branschniva." }
    ],
    "doNotPaginate": true,
    "suggestion": "Lägg på fler SCB-kategorier (inte fritext) och anropa scb_count_companies innan search."
  }
}
```

`suggestedDimensions` ska **inte** hårdkoda privata kodtabellnamn som kan skilja sig per konto. Använd `categoryHint` + “slå upp via list_categories”, och bara fasta namn när de redan är top-level i payloaden (`Företagsstatus`, `Registreringsstatus` — se `TOP_LEVEL_CATEGORIES`).

### 11.2 Okänd kategori

```json
{
  "code": "SCB_UNKNOWN_CATEGORY",
  "message": "SCB känner inte kategorin \"Bransch\" för objectType=company.",
  "retryable": false,
  "nextAction": "retry_modified",
  "nextTools": ["scb_list_categories", "scb_get_category_values"],
  "details": {
    "field": "category",
    "submittedValue": "Bransch",
    "objectType": "company",
    "status": 400,
    "suggestion": "Anropa scb_list_categories och använd exakt Kategori-namn. Koder till värden kommer från scb_get_category_values, inte från svenska etiketter."
  }
}
```

Samma mönster för variabel, med `scb_list_variables` och ev. `details.operator`.

### 11.3 Rate limit

```json
{
  "code": "SCB_RATE_LIMITED",
  "message": "SCB tillåter 10 anrop per 10 sekunder. Vänta och upprepa samma anrop.",
  "retryable": true,
  "nextAction": "retry_same",
  "details": {
    "retryAfterMs": 3500,
    "limit": 10,
    "windowMs": 10000,
    "outstanding": 10,
    "status": 429
  }
}
```

### 11.4 Obesvarbar fråga

Ny kod hellre än att överlasta `SCB_INVALID_QUERY`:

```json
{
  "code": "SCB_UNANSWERABLE",
  "message": "Allmänna företagsregistret kan inte besvara den här frågan.",
  "retryable": false,
  "nextAction": "abort_unanswerable",
  "details": {
    "unanswerableWithThisApi": true,
    "reason": "historical_snapshot",
    "suggestion": "API:et har bara aktuell bild, ingen historik, ingen paginering, inga andra källor."
  }
}
```

`reason`-enum (förslag): `historical_snapshot` · `no_pagination` · `not_this_registry` · `contact_restricted` · `requires_other_object_type` (den sista kan i stället vara `retry_modified` med `nextTools` mot JE↔AE).

Servern kan inte NLP-tolka användarens originalfråga. Signalen blir värdefull när *verktygsanropet* uttrycker det omöjliga (t.ex. framtida `asOf`-fält, `page`/`offset`, eller success-warning när agenten bara bad om poster med `Reklam` som spärrar kontakt). Tills vidare: stark tool description + ev. `warnings` på search-success.

### 11.5 Nollträffar (success med varning)

Inte `isError` — det *är* ett giltigt SCB-svar.

```json
{
  "count": 0,
  "objectType": "company",
  "filters": { },
  "source": "SCB Allmänna företagsregister",
  "warnings": [
    {
      "code": "SCB_NO_MATCHES",
      "nextAction": "retry_modified",
      "nextTools": ["scb_get_category_values", "scb_list_categories", "scb_count_workplaces"],
      "suggestion": "Noll träffar. Kontrollera att values är koder från kodtabellen, inte etiketter. Överväg workplace (AE) om frågan gäller län/kommun för arbetsställe. Stanna inte efter första nollan."
    }
  ]
}
```

---

## 12. Konkreta förbättringar, ordnade efter effekt på retry-lycka

Endast förslag — **inte** implementerat i den här PR:n.

### P0 — agenten väljer fel gren idag

1. **Inför `nextAction` + `nextTools` på alla `ScbError.toJSON()`.** Mapping:
   - `retry_same`: `SCB_RATE_LIMITED`, `SCB_UNAVAILABLE`
   - `retry_modified`: `QUERY_TOO_BROAD`, `SCB_UNKNOWN_CATEGORY`, `SCB_UNKNOWN_VARIABLE`, Zod-`SCB_INVALID_QUERY`
   - `abort_operator`: `SCB_AUTH_ERROR`, `MCP_CONFIG_ERROR`, `SCB_RESPONSE_VALIDATION_ERROR`
2. **Namnge det okända fältet.** Skicka in `category` / `variable` från klienten till `mapHttpError` (eller sätt `details.field` i `getCategoryValues` / query-builder *före* HTTP). Sluta förlita dig enbart på substring `kategori`/`variabel`.
3. **Gör `QUERY_TOO_BROAD.details` handlingsbart** enligt 11.1 (`objectType`, `appliedFilters`, `suggestedDimensions`, `doNotPaginate`, `overBy`). Sätt `nextAction: retry_modified` även om `retryable` förblir `false`.
4. **Dela `SCB_INVALID_QUERY`.** `details.origin: "mcp_input" | "scb_http"`. Zod-meddelanden ska nämna saknat fält och giltiga `objectType`. 408/timeout får inte landa här.

### P1 — timing och kvot

5. **`retryAfterMs`:** läs `Retry-After`; fallback 1000–10000 ms utifrån sliding window. Returnera 429-JSON till agenten om väntan överstiger en kort tröskel i stället för att blockera MCP-anropet.
6. **Logga `waitedMs`.** Räkna search som 2 kvotplatser i tool description.
7. **Count > 2000:** lägg `warnings[]` med samma `QUERY_TOO_BROAD`-kod på `scb_count_*`-success så agenten som bara räknar får samma policy.

### P2 — obesvarbart och nollträff

8. **`warnings` vid `count === 0`** (11.5). Ändra README steg 4 från “stanna” till “verifiera kodtabell och JE/AE, sedan stanna”.
9. **Tool descriptions:** en kort “On error”-paragraf per verktyg (vilken kod, vilket nästa verktyg). Sök: intern count, ingen paginering, 10/10s.
10. **`SCB_UNANSWERABLE` / `unanswerableWithThisApi`** när input uttrycker omöjliga parametrar; `warnings` när `Reklam` betyder att kontaktuppgifter inte får användas.

### P3 — robusthet i mappning och tester

11. **Parsa JSON-body** i `mapHttpError`; plocka SCB:s meddelandefält. Heuristik som fallback, med ordning variabel-före-kategori om båda nämns *och* requesten hade en variabel.
12. **Smalna TLS-heuristiken** (`certificate`/`pfx`/`handshake`, inte bare `cert`).
13. **Tester som saknas:** `SCB_UNKNOWN_VARIABLE`; 400 med båda nyckelorden; 408 → unavailable/retryable; 403 vs 401 `details.reason`; `errorResult`-JSON har `nextAction`; QUERY_TOO_BROAD inkluderar filter; limiter > tröskel ger `SCB_RATE_LIMITED` till MCP; nollträff-`warnings`; MCP 401 är inte `ScbError`.
14. **Korrelations-id** i logg + `details` (uuid per MCP-anrop) så operatör och agent-debug kan matchas.

### Medvetet *inte* i P0

- Att införa en LLM i servern som “förstår frågan”.
- Att gissa läns-/SNI-koder åt agenten (fel koder → tysta nollträffar).
- Att paginera mot SCB.
- Att översätta alla `message`-strängar utan att låsa `code` (koder förblir engelska).

---

## 13. Ändringar i tool descriptions (minimalt, hög effekt)

Nu:

> Retrieve juridiska enheter (JE) matching SCB filters. Counts first. If count > 2000, returns QUERY_TOO_BROAD.

Förslag (utkast):

> Hämta JE. Anropar count först (2 SCB-anrop, kvot 10/10s). Om count > 2000: felkod QUERY_TOO_BROAD, `nextAction=retry_modified` — smalna med kategorier från scb_list_categories, räkna om, paginera inte. Använd exakta SCB-namn och koder från kodtabell. Vid SCB_UNKNOWN_CATEGORY: scb_list_categories. Vid SCB_RATE_LIMITED: vänta retryAfterMs och upprepa samma anrop. SCB_AUTH_ERROR går inte att rätta med andra filter. API:et har bara aktuell bild, inga andra källor.

Samma struktur för AE. Count-verktyg: nämn att stora tal betyder “smalna innan search”.

---

## 14. Påverkan på logging vs agent

Håll isär två kanaler:

| Kanal | Syfte | Får innehålla | Får inte |
| --- | --- | --- | --- |
| MCP `isError` JSON | Styra nästa tool-call | `code`, `nextAction`, `nextTools`, `retryAfterMs`, fältnamn, filter som agenten själv skickade | Cert-lösen, token, råa personuppgifter utöver det agenten skickade |
| stderr | Operatör, SLA, kvot | `errorCode`, `status`, `waitedMs`, `sessionId`, duration | Token, PFX, lösenord (redan sanerat) |

`QUERY_TOO_BROAD` bör loggas som `info` eller `warn`, inte `error` — det är förväntad affärsregel. Annars ser monitorering ut som SCB-haveri varje gång agenten söker “alla aktiva AB”.

---

## 15. Acceptanskriterier för en framtida implementations-PR

En agent utan extra systemprompt ska, enbart från verktygssvaret, kunna:

1. Vid okänd kategori: anropa `scb_list_categories` med samma `objectType` och återanvända **exakt** namn (inte gissa “Bransch”).
2. Vid `QUERY_TOO_BROAD`: *inte* anropa `search` igen med samma filter; anropa count efter en ny kategori; inte hitta på `page`.
3. Vid 429 / `SCB_RATE_LIMITED`: vänta ~`retryAfterMs` och upprepa **samma** argument.
4. Vid `SCB_AUTH_ERROR`: sluta mutera filter och rapportera operatörsfel.
5. Vid `count: 0`: göra minst en metadata-koll (kodtabell eller JE↔AE) innan den svarar användaren “finns inte”.
6. Vid historik/kontakt/andra register: kunna säga att **det här API:et** inte räcker, utan att hitta på anrop.

Mätning (förslag, senare): golden-trace av tool-calls mot fixturer. Lyckandefrekvens = andel traces som når `search_*` med `count ≤ 2000` eller ett explicit `abort_unanswerable` / `abort_operator` — inte tysta retry-loopar.

---

## 16. Referens — filer

| Fil | Roll |
| --- | --- |
| `src/domain/errors.ts` | `ScbError`, koder, `mapHttpError`, `queryTooBroad` |
| `src/mcp/tools.ts` | `errorResult` / `jsonResult`, Zod → `SCB_INVALID_QUERY` |
| `src/mcp/server.ts` | Tool descriptions (enda “on error”-hinten idag) |
| `src/mcp/http.ts` | MCP 401, 400 session, 500 |
| `src/mcp/auth.ts` | Bearer / `X-MCP-Auth` |
| `src/scb/client.ts` | Rate limit acquire, HTTP, TLS-heuristik, 2000-radersguard |
| `src/scb/rate-limit.ts` | Tyst wait |
| `src/scb/auth.ts` | Cert-config → `SCB_AUTH_ERROR` |
| `src/scb/schemas.ts` | Zod; operatorer ovaliderade |
| `src/log.ts` | stderr JSON |
| `src/index.ts` | Startup-fel till stderr |
| `tests/config-errors.test.ts` | 503, QUERY_TOO_BROAD-shape, MCP bind |
| `tests/scb-client.test.ts` | 401/429/kategori/2000/limiter |
| `tests/mcp-tools.test.ts` | Zod, QUERY_TOO_BROAD, 503-passthrough |

---

## 17. Kort verdict

Servern **failar säkert mot SCB** (ingen hämtning över 2000, klient-kvot, mTLS utanför agenten). Den **failar tyst mot agenten**: binär `retryable`, heuristisk HTTP-mappning, generiska suggestions, nollträff som framgång utan vägledning, rate limit som hängande anrop.

Den billigaste höjningen av retry-lycka är inte fler verktyg. Det är att varje `isError`-JSON svarar på tre frågor: **ska jag upprepa, ändra eller ge upp?** **vilket fält?** **vilket verktyg härnäst?**
