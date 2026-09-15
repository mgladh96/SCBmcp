# 03 — Discovery och metadata

Hur en MCP-ansluten AI-agent kan ta reda på *vilken* SCB-data som finns, med minimalt förkunskap. Analysen gäller den nuvarande servern i `SCBmcp` (dataåtkomstlager mot Allmänna företagsregistret) och vad servern — inte den yttre LLM:en — skulle behöva göra för att höja träffsäkerheten.

Dokumentet är analys, inte en implementationsplan. Inga produktändringar föreslås som ska byggas i denna PR.

Relaterade dokument i samma serie: `01` (SCB-API:er och datamodeller), `02` (arkitektur och gränser), `04` (query planning).

---

## 1. Sammanfattning

En agent som ansluter till den här MCP-servern utan SCB-förkunskap möter tre kataloger: kategorier (kodtabeller), variabler (fritext) och två layouter (JE/företag och AE/arbetsställe). Verktygen `scb_list_categories`, `scb_get_category_values` och `scb_list_variables` räcker för att *lista* kontots utbud, men de räcker inte för att *förstå* det.

Servern är ett tunt pass-through-lager. Den normaliserar inte SCB:s JSON, indexerar inte kodtabeller, dokumenterar inte operatorer och berättar inte vilka filter som hör till vilken frågetyp. Det enda dolda schemat som servern *kan* är två specialfall i `src/scb/payload.ts`: `Företagsstatus` och `Registreringsstatus` serialiseras som toppnivåfält, inte som `Kategorier[]`. Agenten ser inte den skillnaden i MCP-kontraktet.

Konsekvens: discovery bränner rate limit (10 anrop / 10 s), fyller kontexten med råa kodtabeller och lämnar operatorer, branschnivåer och geografi (säte vs arbetsställe) till gissning. Det är den största källan till fel *före* `QUERY_TOO_BROAD`. Serverstöd — kompakta schemasammanfattningar, sökbara metadata-index, cacheade kodtabeller och frågetyp→filter-kartor — skulle flytta kunskapen från prompten in i servern och höja andelen frågor som når en korrekt `count` utan att agenten behöver SCB-handböcker.

| Område | Nuläge | Effekt på träffsäkerhet om det lämnas orört |
| --- | --- | --- |
| Katalogverktyg | Finns, men rå SCB-JSON | Medel: agenten hittar namn, inte semantik |
| `includeCodeTables` / `includeValueMetadata` | Opt-in, oindexerat, okomprimerat | Hög: token-explosion eller tomma gissningar |
| JE vs AE | Explicit i verktygsnamn, inte i metadata | Hög: fel layout → fel geografi och status |
| Svenska SCB-namn | Obligatoriska, utan alias | Hög: “län” ≠ `Säteslän` ≠ `Län` |
| Operatorer | Opak sträng, ingen katalog | Hög: fel `Operator` → `SCB_INVALID_QUERY` |
| `branchLevel` / `Branschniva` | Finns i schemat, osynligt i verktygsbeskrivningar | Hög: SNI-sökning på fel nivå |
| Statuskategorier | Specialfall i payload, dolt för agenten | Medel: fungerar om namnen är exakta |
| “Vilka filter för den här frågan?” | README-exempel, ingen serverhjälp | Hög: agenten gissar SNI, storleksklass, geografi |

---

## 2. Vad en agent vet vid sessionstart

MCP-klienten får verktygsnamn, korta engelska `description`-strängar och Zod-inputschema. Den får **inte**:

- Lista över lagliga operatorer
- Skillnaden mellan kategori och variabel utöver en mening i `scb_list_variables`
- Att geografiska fält heter olika på JE och AE
- Att `Företagsstatus` / `Registreringsstatus` inte går via `Kategorier[]` mot SCB
- Vilka kategorier som är branschkategorier och därmed får `branchLevel`
- Kontots faktiska utbud (basutbud vs tilläggsgrupper)
- SCB:s variabelbeskrivning eller postbeskrivning

README:n säger uttryckligen att agenten ska använda **namn som SCB returnerar** och inte hårdkoda ett privat schema. Det är rätt kontrakt — men det förutsätter att metadataverktygen är begripliga. I dag är de det bara för en agent som redan kan SCB, eller som har råd att bränna många anrop och mycket kontext.

Hjälpsidorna som faktiskt förklarar POST-kroppar (`/help`, `/help/exampleJe`, `/help/exampleAe`) kräver klientcertifikat. En LLM i Cursor ser dem inte. Publik variabelbeskrivning och postbeskrivning ligger som PDF på scb.se, utanför MCP.

---

## 3. Discovery-ytan i koden

### 3.1 Verktyg och SCB-endpoints

| MCP-verktyg | Flagga | SCB-endpoint (JE / AE) | Vad som faktiskt returneras |
| --- | --- | --- | --- |
| `scb_list_categories` | `includeCodeTables=false` (default) | `/api/{je\|ae}/koptakategorier` | Rå payload, oförändrad |
| `scb_list_categories` | `includeCodeTables=true` | `/api/{je\|ae}/kategoriermedkodtabeller` | Samma, plus kodtabeller inline |
| `scb_get_category_values` | — | `POST /api/{je\|ae}/kodtabell` med `{ Kategori }` | Rå kodtabell |
| `scb_list_variables` | `includeValueMetadata=false` (default) | `/api/{je\|ae}/koptavariabler` | Rå payload |
| `scb_list_variables` | `includeValueMetadata=true` | `/api/{je\|ae}/variabler` | Rå payload med värdedomän |

`parseListResponse` i `src/scb/payload.ts` är identitet: `return payload`. Servern wrapp:ar svaret i `{ objectType, includeCodeTables|includeValueMetadata, categories|variables|values, source }` men **tolkar inte** SCB:s inre form.

Smoke-testet (`scripts/mcp-smoke.ts`) antar `categories.Kategorier[]`. Live-scriptet (`scripts/verify-live.ts`) sammanfattar både `Kategorier` och `Variabler`. Det är den enda ledtråden i repot om SCB:s listform. En agent som inte har läst testerna måste gissa nycklarna.

Prefixet **kopta** i SCB-sökvägarna betyder att svaret är kontospecifikt. Olika certifikat ser olika kategorier och variabler (basutbud vs tilläggsgrupper som omsättning, telefon, sektor). Servern exponerar inte “det här är bas, det här är tillägg”. Agenten kan därför inte veta om en tom eller kort lista beror på frågan eller på kontot.

### 3.2 `scb_list_categories`

**Vad den är bra på.** Ett anrop ger namnen på kategorier som kontot får filtrera på, per `objectType`. Det är den enda legitima källan till exakta SCB-namn (`Företagsstatus`, `SätesKommun`, `Juridisk form`, …).

**Vad den inte gör.**

- Ingen svensk/engelsk synonym, ingen “används för”-etikett, ingen geografi vs bransch vs status-gruppering.
- Default utan kodtabeller tvingar agenten till N extra `scb_get_category_values`.
- `includeCodeTables=true` hämtar *alla* tabeller i ett anrop. SNI/bransch är tusentals rader. MCP-svaret serialiseras som både `content[].text` (`JSON.stringify`) och `structuredContent` — dubbel kopia in i klienten. Risk: kontexten fylls innan agenten hunnit välja filter.
- Verktygsbeskrivningen nämner inte payloadform, storlek eller att SNI-tabellen är olämplig att dumpa.

### 3.3 `scb_get_category_values`

**Vad den är bra på.** Punktvis kodtabell för *en* kategori. Rätt verktyg när agenten redan vet namnet.

**Vad den inte gör.**

- Ingen sökning i tabellen. “Gävleborg”, “bygg”, “10–49 anställda” kräver att agenten skannar hela listan i kontexten.
- Kategorinamnet måste matcha SCB exakt, inklusive diacritics (`SätesKommun` vs `SatesKommun`). Fel namn mappas till `SCB_UNKNOWN_CATEGORY` om SCB:s feltext innehåller “kategori”.
- Ingen cache. Samma län-tabell hämtas om i varje session och ofta flera gånger per session.
- Ingen hierarki. SNI är ett träd (avdelning → tvåsiffrig → femsiffrig). Tabellen är platt.
- `objectType` styr JE- vs AE-kodtabell, men servern säger inte när samma *begrepp* har olika tabellnamn på de två layouterna.

### 3.4 `scb_list_variables`

**Vad den är bra på.** Skiljer fritextfält från kodtabeller. README:s exempel (`Företagsnamn` + `Innehaller`) hör hit. SCB:s egen FAQ: kategorier har fasta koder, variabler är fritext (`Postort=Örebro`).

**Vad den inte gör.**

- `includeValueMetadata` är odokumenterat utöver “value-domain metadata”. Agenten vet inte när flaggan är värd ett extra anrop, eller hur metadata ser ut.
- Ingen operatorlista per variabel. Datumfält (`Startdatum`) och namnfält (`Firma`) tar sannolikt olika operatorer; servern vet inte vilka.
- Ingen ledtråd att `value2` används för intervall (`ArMellan` eller motsvarande). Schemat tillåter `value2`, men verktygsbeskrivningarna nämner det inte.
- `Firma` vs `Företagsnamn` är två olika JE-fält (enskild näringsidkares registrerade företagsnamn vs juridiska personens namn). En agent som bara ser namnsträngar blandar ihop dem.

### 3.5 Flagginnebörd mot SCB

```
includeCodeTables
  false → GET koptakategorier          (namn / köpt utbud)
  true  → GET kategoriermedkodtabeller (namn + hela tabeller)

includeValueMetadata
  false → GET koptavariabler           (namn / köpt utbud)
  true  → GET variabler                (värdedomän)
```

Båda flaggorna är `optional` i Zod och defaultar till `false` i handlern. Det är rätt default mot rate limit, men fel default mot *förståelse*: utan tabeller kan agenten inte mappa “Gävleborg” → länskod `21`. Med tabeller kan den inte *söka*. Det saknas ett tredje läge: “ge mig en kompakt katalog, och låt mig söka i tabeller”.

---

## 4. JE vs AE — split som discovery måste bära

Servern gör rätt sak på transportnivå: `company` → `/api/je/…`, `workplace` → `/api/ae/…`. Det finns inget generiskt `provider`. Verktygen för räkning/sökning är också delade (`scb_count_companies` vs `scb_count_workplaces`).

Discovery är däremot *samma tre verktyg* med en `objectType`-parameter. Agenten måste själv:

1. Välja layout innan den vet vilka fält som finns.
2. Köra metadata två gånger om frågan kan vara antingen företag eller arbetsställe.
3. Förstå att samma vardagliga begrepp har olika SCB-namn.

### 4.1 Geografi: säte vs belägenhet

SCB:s variabelbeskrivning (publik PDF och [html-sida](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/variabelbeskrivning/)):

| Vardagsbegrepp | JE (företag) | AE (arbetsställe) |
| --- | --- | --- |
| Län | Säteslän (folkbokföringslän för fysiker) | Län där arbetsstället ligger |
| Kommun | Säteskommun | Kommun |
| Postadress | Företagets postadress | Arbetsställets postadress *eller* besöksadress |
| Besöksadress | Finns inte på JE | `BesöksAdress`, `BesöksPostOrt`, … |
| A-region | Finns på båda, men avser olika objekt | Samma namn, annan enhet |

README:s exempel (“aktiva byggföretag i Gävleborg”) varnar för precis detta: Gävleborg är **län på arbetsställe**; säteslän är JE-motsvarigheten. En agent utan den meningen filtrerar JE med `Län` (AE-namn) eller AE med `Säteslän`. Första fallet ger `SCB_UNKNOWN_CATEGORY`. Andra fallet ger tyst fel population (företag med säte i Gävleborg vs arbetsställen i Gävleborg — inte samma mängd).

Postadress är en tredje fälla. Många företag har postadress i en kommun och verksamhet i en annan. “Företag i Gävle” är tvetydigt: säte, postort eller arbetsställe?

### 4.2 Status: tre olika “aktiv”

| Namn | Objekt | Koder (variabelbeskrivning) | Serialisering i denna server |
| --- | --- | --- | --- |
| `Företagsstatus` | JE | `0` aldrig, `1` verksam, `9` ej verksam | Toppnivå i POST-kroppen |
| `Registreringsstatus` | JE (API-namn; variabelbeskrivningen kallar närbesläktat fält `Registrerad hos Skatteverket` / JEstat) | `1` / `2` / `9` | Toppnivå |
| `Arbetsställestatus` | AE | `0` / `1` / `9` | `Kategorier[]` — **inte** specialfall |

Live-scriptet räknar med både `Företagsstatus=1` och `Registreringsstatus=1`. Tester för AE använder `Arbetsställestatus`. En agent som kopierar JE-mönstret till AE (`Företagsstatus` på workplace) får `SCB_UNKNOWN_CATEGORY`. En agent som skippar status räknar in historiskt inaktiva objekt och träffar 2 000-taket oftare.

“Verksamt företag” enligt SCB är moms och/eller F-skatt och/eller arbetsgivare — inte Bolagsverkets “normalläge”. `Status hos Bolagsverket` är ett annat fält (tillägg), med tiotals koder.

### 4.3 Bransch på två nivåer

SNI finns på både JE och AE. På JE är koderna *aggregerade från arbetsställen* (anställda som nyckel, max fem koder, `Bransch_1` = huvudnäringsgren). Ett byggföretag med säte i Stockholm och etablering i Gävleborg har SNI på JE som speglar hela företaget, och SNI på AE per plats.

Sökning “bygg i Gävleborg” är därför nästan alltid en **AE-fråga** (verksamhet på plats) eller en JE-fråga med *säteslän* (huvudkontor). Servern säger inte vilket. Postbeskrivningen levererar `Bransch_1`…`Bransch_5` plus `Avdelning_*` i *resultatet*; sökfilter använder kategori + ev. `Branschniva`. Det är två olika kontrakt.

### 4.4 Identiteter

- JE: `PeOrgNr` (12 tecken; juridiska personer inleds med `16`, fysiker med `19`/`20`).
- AE: `CfarNr` (8 tecken) plus `PeOrgNr` för ägarföretaget.

Det finns inget discovery-verktyg som säger “det här fältet är nyckel”. Agenten ser fältnamnen först i sökresultat — efter att den redan valt filter.

---

## 5. Namngivning: svenska SCB-namn som kontrakt

Filterkontraktet är medvetet nära SCB, inte ett DSL:

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

Det är bra för spårbarhet och dåligt för discovery.

**Exakta strängar.** Kategori- och variabelnamn måste matcha SCB. Inget case-fold, ingen ASCII-fold, inga alias (`companyStatus`, `län`, `SNI`). Zod kräver bara `string().min(1)`.

**Inkonsekvent casing i egna tester.** Payload-testet använder `SätesKommun`. Postbeskrivningen skriver `Säteskommun`. Om SCB:s `koptakategorier` returnerar den ena formen och agenten (eller README) den andra, är det ett fel. Servern kan inte säga vilken form som är kanonisk utan att ha listat på riktigt.

**Resultatfält ≠ filterfält.** Sökning returnerar t.ex. `Bransch_1, kod`, `Stkl, kod`, `Reklam`. Filter använder kategorinamn från `koptakategorier`. En agent som återanvänder resultatangivelser som `category` gissar fel.

**Svenska operatorer.** Det enda belagda operatornamnet i repot är `Innehaller` (README + `tests/payload.test.ts`). README: “Operatorer skickas vidare till SCB; kontrollera tillåtna operatorer på SCB:s hjälpsidor.” Hjälpsidorna är certifikatskyddade. För en MCP-agent är operatorer **odokumenterade**.

**Engelska verktygsbeskrivningar, svenska data.** `title`/`description` i `src/mcp/server.ts` är engelska. Värdena agenten måste skicka är svenska. Det ökar sannolikheten att agenten hittar på `Contains`, `status=active`, `county=Gavleborg`.

---

## 6. Schema-luckor som discovery inte täcker

### 6.1 Operatorer

`variableFilterSchema`:

```ts
{
  variable: z.string().min(1),
  operator: z.string().min(1),
  value: z.string().optional(),
  value2: z.string().optional(),
}
```

Serialisering till SCB:

```ts
{
  Variabel: item.variable,
  Operator: item.operator,
  Varde1: item.value ?? "",
  Varde2: item.value2 ?? "",
}
```

Luckor:

- Ingen enum, ingen katalog, ingen per-variabel tillåten mängd.
- Tom sträng skickas om `value` saknas — agenten kan tro att fältet är valfritt när SCB kräver värde.
- `value2` finns för intervall men nämns inte i MCP-beskrivningar. Datum- och storleksintervall blir gissningar.
- Fel operator ger sannolikt HTTP 400 → `SCB_INVALID_QUERY` med en body-snippet, inte “tillåtna operatorer är …”.
- Det finns inget metadatafält i `koptavariabler`-svaret som servern lyfter fram som operatorlista (om SCB ens skickar en). `includeValueMetadata` *skulle* kunna vara den kanalen, men svaret parsas inte.

Utan en serverkatalog kommer agenten antingen (a) alltid använda `Innehaller` även för koder och datum, eller (b) hallucinera `Equals` / `Contains`. Båda sänker träffsäkerheten mer än fel kategori.

### 6.2 Branschnivåer (`branchLevel` → `Branschniva`)

`categoryFilterSchema` tillåter `branchLevel: z.number().int().positive().optional()`. `toScbQueryBody` sätter `Branschniva` bara när fältet är satt, och **bara** på poster i `Kategorier[]` — inte på toppnivåstatus.

Luckor:

- Fältet syns i Zod som MCP-klienten skickar vidare, men **ingen** `registerTool`-beskrivning nämner det. Agenten som bara läser `description` vet inte att det finns.
- Ingen validering att kategorin är en branschkategori. `branchLevel` på `SätesKommun` skickas tyst till SCB.
- Ingen dokumentation av lagliga nivåer. SCB:s publika räknartjänst talar om SNI på **2- eller 5-siffernivå** och om bransch 1+2+3 (huvudnäringsgren vs alla koder). SNI 2025 är dessutom ett träd: avdelning (bokstav, t.ex. `F` bygg) → tvåsiffrig huvudgrupp → femsiffrig detaljgrupp. API:ets `Branschniva` är inte förklarad i den här kodbasen.
- “Byggföretag” är avdelning `F` (SNI-sök), inte en femsiffrig kod. Utan nivå + sök i kodtabellen måste agenten antingen dumpa hela SNI-tabellen eller gissa `41`/`42`/`43` från träningsdata (som kan vara SNI 2007, inte SNI 2025).
- JE-aggregering: SNI på företag är inte samma population som SNI på arbetsställe. `branchLevel` löser inte den semantikskillnaden.

### 6.3 Statuskategorier specialhanterade i `payload.ts`

```ts
const TOP_LEVEL_CATEGORIES = new Set(["Företagsstatus", "Registreringsstatus"]);
```

För dessa blir POST-kroppen `{ Företagsstatus: "1", Registreringsstatus: "1" }` i stället för `Kategorier: [{ Kategori, Kod }]`. Det följer `/help/exampleJe` och är verifierat live enligt README.

Det är **dold serverkunskap**:

- MCP-filtret ser likadant ut för alla kategorier. Agenten behöver inte veta specialfallet för att *skicka* rätt input — det är bra.
- Agenten kan däremot inte *upptäcka* att dessa två är statusfält med annan JSON-form, annan kardinatitet (ett värde vs array) och att `branchLevel` ignoreras (`continue` innan `Branschniva`).
- `Arbetsställestatus` är **inte** med i mängden. AE-status går via `Kategorier[]`. Asymmetrin finns bara i koden, inte i metadata.
- Flera värden på toppnivåfält blir en array; ett värde blir sträng. Otestat mot skarpt API för array-fallet.
- `Registreringsstatus` som API-namn matchar inte variabelbeskrivningens rubrik “Registrerad hos Skatteverket”. Discovery via PDF och discovery via `koptakategorier` kan ge olika strängar.
- Felkoder `SCB_UNKNOWN_CATEGORY` / `SCB_UNKNOWN_VARIABLE` finns, men discovery-verktygen använder dem inte för att föreslå nära namn.

### 6.4 Storleksklasser — två system

Variabelbeskrivningen har **Storleksklass anställda** (koder `0`–`16`, där `4` = 10–19 och `5` = 20–49) och **AnstSME** (koder `0`–`5` + `9`, där `2` = 10–49). README-exemplet “10–49 anställda” är *en* SME-klass men *två* vanliga storleksklasser. Utan kodtabell + förklaring väljer agenten fel tabell eller en kod som inte finns.

Omsättning finns bara på JE, i storleksklasser, ofta som tillägg. “Företag med mer än 10 MSEK” kräver både rätt kategori och rätt kodintervall.

### 6.5 Resultatschema vs filterschema

Discovery täcker filterinput. Det täcker inte vilka fält som kommer tillbaka. Postbeskrivningen (PDF) är den publika källan för utdata. Servern pars:ar sökresultat som “array, eller första träffen bland `foretag` / `Foretag` / `arbetsstallen` / …”. Fältnamn, `Reklam`-koder och tilläggsgrupper med `*` för obeställda fält förklaras inte. Agenten kan inte veta att ett `*`-värde betyder “tillägg ej köpt” snarare än “saknas på företaget”.

---

## 7. Flaskhalsar i ett typiskt discovery-flöde

README:s rekommenderade flöde för “aktiva byggföretag i Gävleborg med 10–49 anställda”:

1. `scb_list_categories` + `scb_list_variables` för `company` (och `workplace` om det är AE)
2. `scb_get_category_values` för SNI, län, företagsstatus, storleksklass, …
3. `scb_count_companies`
4. Eventuellt `scb_search_companies`

### 7.1 Rate limit mot discovery

SCB: 10 anrop / 10 s. Servern har en sliding window som *väntar*, inte felar, men agenten upplever latens.

Ett naivt flöde utan cache:

| Steg | Anrop |
| --- | --- |
| Kategorier JE | 1 |
| Variabler JE | 1 |
| Kategorier AE (osäker layout) | 1 |
| Variabler AE | 1 |
| Kodtabell status | 1 |
| Kodtabell län | 1 |
| Kodtabell SNI | 1 |
| Kodtabell storleksklass | 1 |
| Count | 1 |
| Search (om ≤ 2 000) | 1 count + 1 fetch |

Det är 10+ HTTP-anrop mot SCB innan första användbara svaret. `includeCodeTables=true` minskar antalet anrop men spränger kontext. Cache på servern skulle kapa nästan alla metadata-anrop efter första sessionen (kodtabeller är nattligt uppdaterade, inte sekundvis).

### 7.2 Kontext och tokenbudget

- Full SNI-tabell + alla län/kommuner + juridisk form + sektor i ett `kategoriermedkodtabeller`-svar är för stort för att agenten ska *resonera* över det.
- Svaren är ostrukturerade ur agentens perspektiv: ingen `summary`, ingen `matchCount`, ingen “top 20 för query=bygg”.
- Dubbel serialisering (`text` + `structuredContent`) förstärker kostnaden i klienter som injicerar båda.

### 7.3 Gissning i stället för lookup

När tabellen är för stor eller anropen för dyra backar agenten till parametrisk kunskap:

- Gävleborg = `21` (ofta rätt)
- Bygg = SNI 2007 `41–43` (kan vara fel mot SNI 2025 avdelning `F`)
- Aktiv = `status=1` med engelskt fältnamn (fel)
- 10–49 = en kod `4` (fel i vanliga storleksklassen)

Parametrisk kunskap är *nästan* rätt, vilket är värre än uppenbart fel: count blir noll eller en tyst fel population.

### 7.4 Ingen “nästa steg”-signal

Efter `scb_list_categories` får agenten en JSON-klump. Den får inte:

- “för geografiska frågor på företag, använd Sätes*”
- “för ‘aktiva’, lägg `Företagsstatus=1` (JE) eller `Arbetsställestatus=1` (AE)”
- “SNI: sök i kodtabellen, sätt `branchLevel` om du har 2-siffrig kod”
- “operatorer: hämta katalog X”

README bär den kunskapen. README är inte MCP-verktyg.

### 7.5 Felvägar utan discovery-återkoppling

| Fel | Vad agenten ser | Vad som saknas |
| --- | --- | --- |
| Fel kategorinamn | `SCB_UNKNOWN_CATEGORY` + snippet | Förslag på nära namn från katalogen |
| Fel variabelnamn | `SCB_UNKNOWN_VARIABLE` | Samma |
| Fel operator | `SCB_INVALID_QUERY` | Operatorlista |
| Fel layout | Tomt eller fel population | Explicit JE/AE-geografikarta |
| För bred fråga | `QUERY_TOO_BROAD` + “Narrow the query using additional SCB filters.” | *Vilka* filter som faktiskt smalnar av (län, SNI, status, storlek) |
| Count 0 | `{ count: 0 }` | Diagnos: fel kod, fel layout, för sträng operator |

`QUERY_TOO_BROAD.details.suggestion` är en generisk engelsk mening. Den pekar inte tillbaka till metadata.

### 7.6 Kontospecifikt utbud

Tilläggsgrupper (omsättning, telefon, e-post, sektor, SME, …) syns i postbeskrivningen men kanske inte i `koptakategorier` för certifikatet. Agenten kan planera filter som kontot inte får använda. Servern vet det först när SCB svarar 400. En schemasammanfattning per konto, cachead vid uppstart, skulle göra utbudet till fakta i stället för hopp.

---

## 8. Förslag: vad *servern* kan göra

Målet är att flytta SCB-schemaförståelse från den yttre LLM:en (och från README) in i MCP-lagret, utan att servern blir en sök-LLM. Fortsatt: inga andra källor, ingen berikning, SCB-namn bevaras.

### 8.1 Kompakt schemasammanfattning (högst prioritet)

Nytt läge eller nytt verktyg, t.ex. `scb_schema_summary(objectType)` som returnerar en *kort* katalog servern själv byggt från `koptakategorier` + `koptavariabler` (cachead):

```json
{
  "objectType": "company",
  "layout": "je",
  "categories": [
    {
      "name": "Företagsstatus",
      "kind": "status",
      "serialization": "top-level",
      "valueCount": 3,
      "sampleValues": [{"code": "1", "label": "verksam"}],
      "notes": "Använd 1 för aktiva företag"
    },
    {
      "name": "Säteslän",
      "kind": "geography",
      "serialization": "Kategorier",
      "valueCount": 21,
      "counterpartOnWorkplace": "Län"
    }
  ],
  "variables": [
    {
      "name": "Företagsnamn",
      "kind": "name",
      "typicalOperators": ["Innehaller", "ArLikaMed"]
    }
  ],
  "operators": ["Innehaller", "ArLikaMed"],
  "warnings": [
    "Geografi på JE är säte, inte arbetsställets belägenhet"
  ]
}
```

Krav:

- Fast övre storlek (några KB, inte hela SNI).
- `kind` är serverklassificering utifrån namn + ev. känd lista, inte en ny SCB-källa.
- `serialization: top-level` gör `payload.ts`-specialfallet synligt.
- `counterpartOnWorkplace` / `counterpartOnCompany` gör geografisplitten explicit.
- Operatorlistan hämtas från SCB-hjälp eller från `includeValueMetadata` *en gång*, sedan cache.

Detta ersätter inte kodtabeller; det gör att agenten vet *vilken* tabell den ska slå i.

### 8.2 Sökbart metadata-index

Nytt verktyg, t.ex. `scb_search_metadata`:

```json
{
  "objectType": "workplace",
  "query": "Gävleborg",
  "limit": 10
}
```

Svar:

```json
{
  "matches": [
    {
      "objectType": "workplace",
      "category": "Län",
      "code": "21",
      "label": "Gävleborgs län",
      "kind": "geography"
    }
  ]
}
```

Samma för “bygg”, “aktiebolag”, “10-49”. Indexet byggs från cacheade kodtabeller (och ev. variabelnamn). SNI-trädet indexeras på både kod och text, så “byggverksamhet” träffar avdelning `F` och relevanta femsiffriga koder.

Detta är den enskilt största förbättringen mot “dumpa `includeCodeTables`”. Agenten slutar skanna tusentals rader i kontexten.

Implementationsskisser (analys, inte krav): in-memory prefix/trigram eller enkel normaliserad substring mot cache. Ingen extern sökmotor behövs. Kodtabeller ryms i processminnet.

### 8.3 Cacheade kodtabeller

TTL i storleksordning timmar–dygn (API:et uppdateras nattligen, de flesta variabler mer sällan). Cache-nyckel: `(layout, category)` och `(layout, includeCodeTables|includeValueMetadata)`.

Effekter:

- Discovery slutar äta rate limit.
- `scb_get_category_values` blir lokalt efter första träffen.
- Indexet i 8.2 kan byggas vid uppstart eller lazy.
- Live-tester och smoke kan förbli mot SCB; cache ska gå att stänga av.

Invalidation: TTL + manuell flush räcker. Ingen aviseringstjänst i det avgiftsfria API:et.

### 8.4 “Vilka filter hör till den här frågetypen?”

Inte naturligt språk-tolkning av hela frågan (det hör till NL→SCB-analysen), men en **serverkarta** från *frågeklass* till filter:

| Frågeklass | Layout | Kategorier att slå upp | Variabler | Standardstatus |
| --- | --- | --- | --- | --- |
| Företag i ett län/kommun | `company` | `Säteslän` / `Säteskommun`, `Företagsstatus` | — | `Företagsstatus=1` |
| Arbetsställen i ett län/kommun | `workplace` | `Län` / `Kommun`, `Arbetsställestatus` | ev. `BesöksPostOrt` | `Arbetsställestatus=1` |
| Bransch + plats | nästan alltid `workplace` | SNI/bransch + AE-geografi | — | aktiv AE |
| Namncontains | `company` | status | `Företagsnamn` eller `Firma` + `Innehaller` | aktiv JE |
| Storlek anställda | båda, olika tabeller | `Storleksklass anställda` eller `AnstSME` | — | — |
| Organisationsnummer | båda | — | `PeOrgNr` / orgnr-variabel, exakt operator | — |

Exponeras som `scb_filter_hints(questionClass)` eller som fält i schemasammanfattningen. Agenten (eller en senare query planner) väljer klass; servern ljuger inte ihop koder — den pekar på vilka *namn* som ska resolvas via indexet.

Detta är medvetet smalare än en LLM-planner: en tabell, inte en modell. Den tar bort de vanligaste layout- och geografifelen.

### 8.5 Explicit JE/AE-geografikarta

Antingen i 8.1 eller som eget litet verktyg/resurs:

```json
{
  "geography": {
    "company": {
      "county": "Säteslän",
      "municipality": "Säteskommun",
      "meaning": "Säte (folkbokföring för fysiker)"
    },
    "workplace": {
      "county": "Län",
      "municipality": "Kommun",
      "visit": ["BesöksAdress", "BesöksPostOrt"],
      "meaning": "Fysisk belägenhet"
    },
    "doNotConfuse": [
      "PostOrt är postadress, inte säte och inte nödvändigtvis driftställe"
    ]
  }
}
```

Namnen ska fyllas i från live-metadata (kanonisk stavning), inte hårdkodas mot PDF:en. Kartan är serverns *tolkning* av kända par.

### 8.6 Operator- och branschnivåkatalog

Efter att SCB-hjälp / `variabler`-metadata verifierats live: statisk, versionsmärkt lista i servern.

- Operatorer: namn, arity (`value` vs `value`+`value2`), typiska fält (namn, datum, kod).
- `Branschniva`: tillåtna heltal, vad de betyder (2-siffrig vs 5-siffrig vs avdelning), att fältet bara är meningsfullt på branschkategori.
- Validering i Zod eller i handler: okänd operator → `SCB_INVALID_QUERY` med `details.allowedOperators`. `branchLevel` på icke-bransch → varning i svaret eller avvisning.

Det gör `payload.ts` till dokumenterad kunskap i stället för tyst rewrite.

### 8.7 Kodtabell-svar med sök och truncering

Även utan nytt indexverktyg kan `scb_get_category_values` ta `query` + `limit` och returnera `{ total, returned, values }`. Default `limit` ~50. Full dump bara vid `limit=0` eller explicit flagga.

SNI-svar bör inkludera `parentCode` / `level` om det går att härleda (kodlängd, avdelningsbokstav). Då kan agenten välja `branchLevel` utan att förstå SNI-standarden.

### 8.8 MCP-resurser (resources) för kataloger

I dag registreras bara tools. MCP resources (t.ex. `scb://schema/je`, `scb://codetable/je/Företagsstatus`) skulle låta klienten läsa cacheade kataloger utan att bränna ett “tool call” i agentens budget. Komplement till 8.1–8.3, inte ersättning.

### 8.9 Rikare fel som pekar tillbaka till metadata

| Dagens kod | Förslag på `details` |
| --- | --- |
| `SCB_UNKNOWN_CATEGORY` | `nearestNames[]` från katalogen, `objectType`, ev. “menade du AE-namnet Län?” |
| `SCB_UNKNOWN_VARIABLE` | samma |
| `SCB_INVALID_QUERY` vid operator | `allowedOperators` |
| `QUERY_TOO_BROAD` | `suggestedNarrowing`: status, län, SNI-avdelning, storleksklass — med *kategorinamn* för aktuell layout |
| count = 0 | `possibleCauses`: fel layout, fel kod, för sträng operator, inaktiv status |

Ingen ny SCB-semantik: bara att servern *har* katalogen och använder den i felsvar.

### 8.10 Normaliserad listoutput

I stället för rå SCB-JSON:

```json
{
  "objectType": "company",
  "categories": [
    { "name": "Företagsstatus", "hasCodeTable": true }
  ]
}
```

Behåll `raw` bakom en flagga om någon behöver SCB:s original. Smoke-testets `categories.Kategorier` blir då ett medvetet bakåtkompatibelt fält, inte det enda kontraktet.

### 8.11 Vad servern *inte* ska göra här

- Inte gissa SNI från fritt branschnamn utan indexträff (det är NL-lager).
- Inte slå ihop JE och AE till “företag i Gävle” bakom ryggen på agenten.
- Inte strip:a `Reklam` eller hitta på engelska fältnamn i SCB-svar.
- Inte läsa PDF:er runtime som sanning om kontots utbud — PDF är publik dokumentation, `kopt*` är kontot.

---

## 9. Effekt på träffsäkerhet

Med “träffsäkerhet” menas andel användarfrågor som leder till (a) rätt layout, (b) rätt filterfält och koder, (c) en `count` som matchar avsikten, innan 2 000-gränsen ens kommer in. Siffrorna nedan är **kvalitativa bedömningar** utifrån kontraktet i koden plus SCB:s publika variabelbeskrivning — inte uppmätta evals. En eval-svit hör till NL→SCB-dokumentet.

### 9.1 Nuläge (endast befintliga tre verktyg)

| Frågetyp | Sannolikhet att en agent utan SCB-prompt lyckas | Dominerande fel |
| --- | --- | --- |
| “Hur många aktiva aktiebolag finns i Sverige?” | Medel | Missar `Juridisk form=49` och/eller status; `QUERY_TOO_BROAD` vid search |
| “Byggföretag i Gävleborg, 10–49 anställda” | Låg | Fel layout, fel län-fält, fel SNI-nivå, fel storleksklass |
| “Hitta företag som heter …Bygg…” | Medel | `Contains` vs `Innehaller`; `Firma` vs `Företagsnamn` |
| “Arbetsställen på den här adressen” | Låg–medel | JE-verktyg, postadress vs besöksadress |
| “SNI 62.01” / exakt kod | Medel–hög | Punkt vs ingen punkt; `branchLevel` |
| Discovery “vad kan jag filtrera på?” | Medel | Får namn, förstår inte geografi/status/SNI |

Rate limit och token-dump gör dessutom att *samma* agent lyckas sämre i långa sessioner (timeout, avhuggen tabell, upprepade kodtabell-anrop).

### 9.2 Förväntad effekt per serverförslag

| Åtgärd | Relativ lyft | Varför |
| --- | --- | --- |
| Cacheade kodtabeller | Indirekt, hög | Fler metadata-steg hinns med inom 10/10 s; mindre slump |
| Sökbart index (`Gävleborg` → `Län/21`) | **Hög** | Tar bort den vanligaste kodgissningen |
| Schemasammanfattning + JE/AE-geografikarta | **Hög** | Tar bort layout- och sätesfel |
| Filterhints per frågeklass | **Hög** på standardfrågor | Kodar README-exemplet som data |
| Operator- + `Branschniva`-katalog med validering | **Hög** på variabel- och SNI-frågor | I dag opaquesträngar |
| Truncerade / sökbara `get_category_values` | Medel–hög | Gör `includeCodeTables` onödigt |
| Rikare fel med `nearestNames` | Medel | Räddar nära-missar i stället för att agenten byter strategi |
| Normaliserad listoutput | Medel | Mindre parsingfel (`Kategorier` vs array) |
| MCP resources | Låg–medel | Samma data, billigare att läsa |

Sammantaget: **metadata-sök + schemasammanfattning + cache** är den minsta uppsättning som gör “minimal prior knowledge” realistiskt. Utan dem måste kunskapen ligga i systemprompten, och den ruttnar mot SNI 2025, kontospecifika tillägg och stavning i `koptakategorier`.

### 9.3 Vad som *inte* löses av discovery

- 2 000-raders taket och avsaknad av paginering (`02`-dokumentet).
- Att “företag i Gävle” är semantiskt tvetydigt även med rätt fält — användaren måste välja säte vs arbetsställe. Servern kan bara *visa* valet.
- Tillägg som kontot inte har köpt.
- Kommande API (september 2026): nycklar, paginering, utgående sammanslagna layouter. Discovery-lagret bör isoleras så att katalogformatet kan bytas.

### 9.4 Mätförslag (för senare eval, inte denna PR)

Guldfrågor med känt SCB-utfall, körda mot MCP med tre agentprofiler:

1. Ingen systemprompt utöver verktygsbeskrivningar.
2. Nuvarande README-flöde inklistrad.
3. README + hypotetiska serververktyg (mockade svar).

Mät: andel korrekt layout, andel korrekta kategorinamn, antal SCB-anrop före första giltiga count, tokenvolym metadata, andel `SCB_UNKNOWN_*` / fel operator. Det ger en siffra på 9.2 i stället för en bedömning.

---

## 10. Rekommenderad ordning (när implementation väl sker)

1. **Cache** av `koptakategorier`, `koptavariabler` och kodtabeller per layout — noll semantisk risk, omedelbar effekt på rate limit.
2. **Normaliserad katalog + schemasammanfattning** med `kind`, `serialization`, JE/AE-motparter.
3. **`scb_search_metadata`** (eller `query` på `get_category_values`) mot cachen.
4. **Operator- och `Branschniva`-katalog** efter live-avläsning av SCB-hjälp / `variabler`.
5. **Filterhints** och rikare fel som *konsumenter* av 2–4.
6. MCP resources när tool-ytan stabiliserats.

Steg 1–3 kräver inget nytt SCB-kontrakt. Steg 4 kräver ett certifikat och en avläsning av endpoints som den här kodbasen i dag bara skickar vidare.

---

## 11. Källor i den här kodbasen

| Fil | Roll i discovery |
| --- | --- |
| `src/mcp/server.ts` | Verktygsbeskrivningar (det enda agenten ser vid `listTools`) |
| `src/mcp/tools.ts` | Wrapping av rå SCB-JSON |
| `src/scb/client.ts` | Flagga → endpoint (`kopt*` vs full) |
| `src/scb/endpoints.ts` | JE/AE-sökvägar |
| `src/scb/schemas.ts` | `objectType`, `includeCodeTables`, `includeValueMetadata`, `branchLevel`, opak `operator` |
| `src/scb/payload.ts` | `TOP_LEVEL_CATEGORIES`, `Branschniva`, identitets-`parseListResponse` |
| `README.md` | Agentflöde, filterkontrakt, Gävleborg-varning, operator-hänvisning till certifikatskyddad hjälp |
| `scripts/mcp-smoke.ts` | Antar `categories.Kategorier` |
| `scripts/verify-live.ts` | Live JE/AE-listning + kodtabell `Företagsstatus` |
| `tests/payload.test.ts` | ExempelJe-form, `Innehaller`, `SätesKommun` |

Publika SCB-källor använda för semantik (inte runtime):

- [Avgiftsfria uppgifter i företagsregistret](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/avgiftsfria-uppgifter-i-foretagsregistret/) — JE vs AE, kategori vs variabel, 2 000 / 10-per-10s, kommande API 2026
- [Variabelbeskrivning](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/variabelbeskrivning/) och PDF *Variabelbeskrivning API SNI 2025* — statuskoder, säte vs län/kommun, storleksklasser, SNI-aggregering
- [Postbeskrivning företag](https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/postbeskrivning-foretag.pdf) — utdatafält vs filterfält, tilläggsgrupper
- [SNI-sök](https://snisok.scb.se/) — avdelning `F` = byggverksamhet (SNI 2025)

Certifikatskyddade sidor som **inte** kunnat läsas i den här analysen: `/help`, `/help/exampleJe`, `/help/exampleAe`. Operatorlistan och den exakta betydelsen av `Branschniva` bör bekräftas där innan steg 4 i avsnitt 10.
