# SCB Allmänna företagsregister MCP-server

MCP-server som ger AI-agenter åtkomst till **SCB:s Allmänna företagsregister**.

Den är bara ett dataåtkomstlager för det API:et. Den söker inte i andra källor, berikar inte poster, skrapar inte webbplatser och kör ingen LLM.

## Vad servern gör

En agent kan:

1. Inspektera kategorier och variabler som det konfigurerade SCB-kontot får använda
2. Hämta kodtabeller för en kategori
3. Räkna företag (JE, juridisk enhet)
4. Hämta företag när antalet träffar är ≤ 2 000
5. Räkna arbetsställen (AE, arbetsställe)
6. Hämta arbetsställen

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
| `scb_list_categories` | Kategorier för `company` (JE) eller `workplace` (AE). Valfri `includeCodeTables`. Svar: `{ items, raw }` (även `categories` = raw). |
| `scb_get_category_values` | Kodtabell för en SCB-kategori. Svar: `{ items, raw }`. |
| `scb_list_variables` | Variabler för kontot. Valfri `includeValueMetadata`. Svar: `{ items, raw }`. |
| `scb_count_companies` | Räkna JE-träffar |
| `scb_search_companies` | Hämta JE-träffar (räknar först; avvisar > 2 000; hoppar `hamta` vid count 0) |
| `scb_count_workplaces` | Räkna AE-träffar |
| `scb_search_workplaces` | Hämta AE-träffar (samma count-regler som JE) |

MCP-prompts (ingen extra SCB-trafik): `scb_explore_schema`, `scb_count_then_fetch`, `scb_handle_too_broad`. Server-`instructions` upprepar arbetsflödet vid initialize.

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

Använd **kategori- och variabelnamn som SCB returnerar dem** från metadataverktygen (`items[].name`). Hårdkoda inte ett eget schema. Operatorer skickas vidare till SCB som **SCB-strängar** (t.ex. `Innehaller`, inte `Contains`).

Anti-mönster:

- Namn som innehåller `"Bygg"` är inte SNI — slå upp branschkategorin i kodtabellen.
- Gävleborg som belägenhet är AE-kategorin `Län`, inte JE-säte (`Säteslän`) om användaren inte menar säte.
- `AnstSME` är inte samma sak som kategorin **Storleksklass Anställda**.
- Tomma `categories` och `variables` är giltiga men ger `warning` (obegränsad population).

Sökverktygen returnerar SCB-fältnamn som de tas emot, inklusive `Reklam` när SCB inkluderar det. Servern tar inte bort reklamspärrar och är inte ett sätt att kringgå dem.

## Exempel på agentflöde

Användare: ”Hitta aktiva byggföretag i Gävleborg med 10–49 anställda.”

**Agenten** (inte den här servern) bör:

1. `scb_list_categories` / `scb_list_variables` för `objectType: "company"` (och arbetsställen om frågan egentligen gäller AE)
2. `scb_get_category_values` för SNI/bransch, län, företagsstatus, storleksklass för anställda och andra nödvändiga kategorier
3. `scb_count_companies` med de koderna
4. Om count är 0, stanna (search hoppar över `hamta*`). Om count > 2000, begränsa filtren — paginera inte. Om count ≤ 2000, fortsätt
5. `scb_search_companies` med samma filter. Search räknar internt och **återanvänder** en nylig count (ca 5 s), så extra count precis före search behövs inte.
6. Resonera utifrån JSON:en som SCB returnerar

Gävleborg är ett **län** på arbetsställe i SCB:s variabelbeskrivning; säteslän är motsvarigheten på företagsnivå. Agenten måste hämta det från SCB-metadata, inte från den här README:n.

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

`candidateNarrowingDimensions` är en statisk lista per JE/AE (status, geografi, SNI, storleksklass, namnvariabel) — inga extra SCB-anrop.

Lokalt rate limit (10 / 10 s) **väntar inte tyst**. Agenten får `SCB_RATE_LIMITED` med `nextAction: "retry_same"` och `details.retryAfterMs`. HTTP 429 från SCB mappar samma kod. Loggar kan innehålla `waitedMs` (0 när anropet avvisas lokalt).

Kategorier, variabler och kodtabeller cacheas i processen i flera timmar (SCB uppdaterar över natten). `bypassCache` på metadataverktygen eller `SCB_METADATA_CACHE_BYPASS=true` tvingar live-anrop.

## Köra tester

```bash
pnpm typecheck
pnpm lint
pnpm test
```

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
- `SCB_INVALID_QUERY` — `retry_modified` (kolla listverktygen / operatorer)
- `SCB_UNKNOWN_CATEGORY` — `retry_modified`, `scb_list_categories`
- `SCB_UNKNOWN_VARIABLE` — `retry_modified`, `scb_list_variables`
- `QUERY_TOO_BROAD` — `retry_modified`, smalna filter, paginera inte
- `SCB_RESPONSE_VALIDATION_ERROR` — `abort_unanswerable`

## Live-verifiering mot SCB

Certifikatautentisering, JE/AE-metadata, kodtabell och `raknaforetag` har verifierats mot SCB:s skarpa API med ett riktigt `.pfx`. POST-kroppar följer `/help/exampleJe`. Sökning av resultatmängder större än 2 000 avvisas (`QUERY_TOO_BROAD`); den vägen bör kontrolleras med ett smalt filter.
