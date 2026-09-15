# SCB API:er och datamodeller

**Status:** analys only — ingen produktimplementation.  
**Datum:** 2026-09-14  
**Omfattning:** vad SCB Allmänna företagsregister (och närliggande API:er som samma cert/konto *kan* nå) faktiskt erbjuder, jämfört med vad SCBmcp redan wrapppar.

## 1. Sammanfattning

SCBmcp är en tunn dataåtkomst till **ett** SCB-produkt: REST-API:et *Sök på var* (`sokpavar`) för Allmänna företagsregistret, bas-URL `https://privateapi.scb.se/nv0101/v1/sokpavar`. Den wrapppar JE- och AE-metadata, kodtabell, räkning och hämtning. Den wrapppar **inte** SCB:s help-sidor, XML-varianter, sammanslagna layouter, `/api/Common/*` (om de finns på kontot), eller något annat SCB-produkt (PxWeb, geodata, avisering, NÄRA, motpartsklassificering, Hydra, myndighetsregistret).

För AI-agenter är det här ett **filter-API med kontobegränsad metadata**, inte en sökbar kunskapsbas. Agenter kan lista de kategorier och variabler kontot får använda, och räkna/hämta rader — men de kan inte upptäcka giltiga operatorer, skillnaden JE/AE-geografi, tilläggsgrupper (TG*), reklamspärrens innebörd, eller SCB:s help-exempel via servern. Metadata returneras opakt. Sökfilter för `Arbetsställestatus` serialiseras troligen fel (toppnivåfält i help-exempel, `Kategorier[]` i den här koden).

**Maximal täckning av SCB för detta certifikat** betyder: maximal täckning av *sokpavar nv0101* (JE/AE + help + eventuella Common-endpoints + de tillägg kontot har köpt). Det betyder **inte** Statistikdatabasen, historik eller andra SCB-register.

---

## 2. Metod och källor

| Källa | Vad den ger | Begränsning |
| --- | --- | --- |
| Repo: `README.md`, `src/scb/*`, `src/mcp/*`, `scripts/verify-live.ts`, tester | Exakt vad som wrappas, hur POST-kroppar byggs, vad som verifierats live | Help-HTML är gitignorerad (`scripts/.exampleJe.html`, `.exampleAe.html`) och finns inte i checkout |
| [Avgiftsfria uppgifter i företagsregistret](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/avgiftsfria-uppgifter-i-foretagsregistret/) | Officiella gränser, JE vs AE, kategorier vs variabler, kommande API sep 2026 | Tekniska sökvägar och operatorer saknas |
| Postbeskrivningar (PDF, 2025-06-26): [Företag](https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/postbeskrivning-foretag.pdf), [Arbetsställe](https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/postbeskrivning-arbetsstalle.pdf), [JE+huvudAE](https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/postbeskrivning-foretag-med-uppgifter-om-huvudarbetsstalle.pdf), [AE+JE](https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/postbeskrivning-arbetsstalle-med-uppgifter-om-foretaget.pdf) | Fält i basutbud och tilläggsgrupper TG* | Filter-namn ≠ returfält-namn |
| [Variabelbeskrivning (webb)](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/variabelbeskrivning/) och [API-PDF SNI 2025](https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/variabelbeskrivning-api-sni-2025.pdf) | Semantik, kodvärden, uppdateringsfrekvens | Inte API-kontraktet |
| Certifikat-låsta help-sidor | `/help`, `/help/exampleJe`, `/help/exampleAe` | Kräver mTLS. Utan cert returnerade `/help` HTTP 500 i den här miljön |
| Tredjepartsklienter (sekundärt, *overifierat mot detta cert*): [Proffera transport](https://github.com/ibboabdoli-ai/Proffera) (help-HTML 2026-08-19), [scb-smart-search](https://github.com/PhilipE125/scb-smart-search) | Operatorer, extra sökvägar, variabelnamn | Inte SCB-officiellt. `offset`/`limit` strider mot SCB:s “ingen paginering” |

Live-certifikat fanns **inte** i den här miljön. README uppger att cert-auth, JE/AE-metadata, kodtabell och `raknaforetag` redan verifierats mot live-API.

---

## 3. Vad detta MCP är (och inte är)

```
AI-agent
  → MCP (HTTP+SSE)  scb-foretagsregister 0.1.0
  → ScbClient (mTLS .pfx, api-id-header, 10/10s, 2000-radersvakt)
  → SCB Allmänna företagsregister
     https://privateapi.scb.se/nv0101/v1/sokpavar
```

README: *“It is only a data access layer for that API. It does not search other sources, enrich records, scrape websites, or run an LLM.”*

Autentisering är **klientcertifikat + API-id** (`AXXXXX` i certifikatnamnet), inte inloggningsformulär. Kontot avgör vilka **layouter** och **tilläggsgrupper** som levereras. I postbeskrivningarna: obeställda tillägg returneras som `*` (längd 1) — fälten finns alltid, värdena gör det inte.

Sju MCP-verktyg, alla JSON in/ut:

| MCP-verktyg | SCB-anrop |
| --- | --- |
| `scb_list_categories` | GET `koptakategorier` eller GET `kategoriermedkodtabeller` |
| `scb_get_category_values` | POST `kodtabell` `{ Kategori }` |
| `scb_list_variables` | GET `koptavariabler` eller GET `variabler` |
| `scb_count_companies` | POST `je/raknaforetag` |
| `scb_search_companies` | count först, sedan POST `je/hamtaforetag` om ≤ 2000 |
| `scb_count_workplaces` | POST `ae/raknaarbetsstallen` |
| `scb_search_workplaces` | count först, sedan POST `ae/hamtaarbetsstallen` om ≤ 2000 |

Inga MCP resources, inga prompts, ingen help-proxy. `parseListResponse` är identity — kategorier/variabler/kodtabeller skickas vidare som `unknown`.

---

## 4. JE vs AE — datamodeller

Officiell SCB-FAQ och variabelbeskrivning:

- **JE (juridisk enhet / företag)** identifieras med person- eller organisationsnummer. `PeOrgNr` är 12 tecken (fysiker `19`/`20` + personnummer; juridiska personer `16` + 10-ställigt orgnr). `OrgNr` är 10 tecken. Ett företag är *verksamt* om det är registrerat för moms och/eller som arbetsgivare och/eller F-skatt.
- **AE (arbetsställe)** är en geografiskt avgränsad plats där verksamheten bedrivs stadigvarande med personal. Alla företag har minst ett AE. Identitet: `CfarNr` (8 siffror, SCB-tilldelat). Ytterligare AE kräver verksamhet, plats, varaktighet och anställda.

SCB-exempel: “Svensk Bil AB” (JE) med huvudkontor i Stockholm och verkstäder i Örebro, Skellefteå, Malmö (AE).

På SCB:s startsida (hämtad 2026-09-14): registret innehåller **1 804 297 företag** och **1 436 285 arbetsställen**. Den publika antalsräknaren visade **1 820 740 rader** i databastabellen (uppdaterad 2026-09-06) — samma storleksordning, annan vy.

### 4.1 Nycklar och relation

```
JE  PeOrgNr (12) / OrgNr (10)
 │
 └── 1..n AE  CfarNr (8) + PeOrgNr
              Arbetsställetyp 1 = representerar JE (ofta “huvudkontor”)
              Arbetsställetyp 3 = fiktivt AE (rörlig kommunpersonal)
              Huvudarbetsställe enligt EU = AE med flest anställda
```

Den här servern har **inget join-verktyg**. En agent som vill ha “företag i Gävleborg med 10–49 anställda” måste själv välja JE (säteslän) eller AE (län på arbetsstället) — README nämner det, verktygsbeskrivningarna gör det inte.

### 4.2 Geografi (vanlig agentfälla)

| Begrepp | Objekt | Källa |
| --- | --- | --- |
| Säteskommun / Säteslän | JE | säte; för fysiker folkbokföringsort |
| Kommun / Län | AE | belägenhet |
| A-region | båda | A-regionkarta 2006 |
| PostOrt / PostNr | båda | postadress, inte nödvändigtvis belägenhet |
| BesöksAdress / BesöksPostOrt | AE | fysisk plats |

“Byggföretag i Gävleborg” är **olika populationer** beroende på JE vs AE.

### 4.3 Kärnstatuskoder

**Företagsstatus** (JE, veckovis): `0` aldrig verksam, `1` verksam, `9` ej verksam.

**Registrerad hos SKV / Jestat** (JE): `1` i populationen och i SKV orgnr-register, `2` i populationen på annat sätt (fysiker, vissa dödsbon, värdepappersfonder), `9` inte längre i populationen (kvar i registret 6 månader men *inte tillgänglig i API:et*).

**Arbetsställestatus** (AE): `0` aldrig verksam, `1` verksam, `9` ej längre verksam.

---

## 5. Kategorier, variabler, tillägg

SCB FAQ: *kategorier* har fasta kodtabeller; *variabler* är fritext (t.ex. `Postort=Örebro`).

I API-anropet (help `exampleJe`, speglat i `src/scb/payload.ts` och `tests/payload.test.ts`):

```json
{
  "Företagsstatus": "1",
  "Registreringsstatus": "1",
  "Kategorier": [{ "Kategori": "SätesKommun", "Kod": ["0180"], "Branschniva": 1 }],
  "variabler": [{
    "Variabel": "Firma",
    "Operator": "Innehaller",
    "Varde1": "ask",
    "Varde2": ""
  }]
}
```

`Företagsstatus` och `Registreringsstatus` är **toppnivåfält**, inte `Kategorier[]`. Proffera (help-HTML 2026-08-19) visar motsvarande för AE: toppnivå `Arbetsställestatus`. Den här kodbasen lyfter bara de två JE-statusfälten (`TOP_LEVEL_CATEGORIES` i `payload.ts`).

`koptakategorier` / `koptavariabler` = vad **detta konto** får använda. `variabler` / `kategoriermedkodtabeller` = fullare metadata (värdedomän / inbäddade kodtabeller). MCP exponerar skillnaden som `includeCodeTables` / `includeValueMetadata` utan att förklara kostnad (SNI-kodtabellen är stor) eller kontofilter.

### 5.1 Filter-namn vs returfält

Agenter blandar ihop tre namnrymder:

| Roll | Exempel | Var det lever |
| --- | --- | --- |
| Filterkategori | `SätesKommun`, `Bransch`, `Juridisk form` | `koptakategorier` |
| Filtervariabel | `Firma`, `Namn`, `OrgNr (10 siffror)` | `koptavariabler` |
| Returfält (postbeskrivning) | `Företagsnamn`, `Säteskommun, kod`, `Bransch_1, kod` | `hamtaforetag` JSON |

Tredjepartsdokumentation (overifierad här) varnar: sök på företagsnamn i JE med variabeln `Namn`, inte `Företagsnamn`. Repo-testerna använder `Firma` från `exampleJe`. En agent som gissar `Företagsnamn` som filter kan få `SCB_UNKNOWN_VARIABLE`.

`Branschniva` finns i schemat men nämns inte i MCP-tool-text. SNI har max 5 koder per objekt (`Bransch_1`…`Bransch_5`); nivå 2 vs 5 siffror styr hur bred en branschfilterträff blir. Publik antalsräknare: sök förskolor med Bransch 1+2+3, inte bara huvudbransch.

### 5.2 Operatorer

Repo: operatorer är fria strängar, “confirm legal operators on the SCB help pages.” Help är inte ett MCP-verktyg.

Sekundärt (scb-smart-search types, *inte officiellt SCB*):

| Operator | Trolig betydelse |
| --- | --- |
| `ArLikaMed` | exakt lika |
| `BorjarPa` | börjar på |
| `Innehaller` | innehåller |
| `Mellan` | intervall (`Varde1`+`Varde2`) |
| `FranOchMed` / `TillOchMed` | datum/numeriskt spann |
| `Finns` / `FinnsInte` | värde finns / saknas |

Proffera (help 2026-08-19): orgnr-uppslag med `Operator: "ArLikaMed"` och `Variabel: "OrgNr (10 siffror)"` (JE) respektive `"OrgNr (12 siffror)"` (AE). Den här servern har inget `lookup_by_orgnr`-verktyg — agenten måste uppfinna samma filter.

### 5.3 Basutbud vs tilläggsgrupper (TG*)

Alla fält i postbeskrivningen **finns i JSON**. Obeställda tillägg = `*`.

**JE-basutbud (urval):** identiteter; namn/adress; säte; A-region; antal AE; storleksklass anställda; företagsstatus; SKV-registrering; juridisk form; Reklam; Utskick; start/slut/registreringsdatum; Bransch_1–5 + Avdelning; Export/Importmarkering.

**JE-tillägg:** TG07Oms (omsättning i klasser, 4 gånger/år, sekretess), TG08AgKat, TG22Tel_JE, TG09Epost_JE, TG11PrivPubl, TG15Stat_ArbGiv/Moms/Fskatt/Bol, TG17Firma, TG18Sektor, TG21AnstSmeJE, TG16Andel, TG14Utl, TG06EI (export/import landgrupper, årsvis, historiskt värdeår).

**AE-basutbud (urval):** CfarNr; PeOrgNr; företagsnamn; Benämning; post- och besöksadress; kommun/län; A-region; arbetsställestatus; storleksklass; intern beteckning; hjälpverksamhet; huvudarbetsställe enl. EU; Reklam; Utskick; start/slut; Bransch_1–5.

**AE-tillägg:** TG02BPostNr, TG22Tel_AE, TG09Epost_AE, TG19AETyp, TG20AnstSmeAE, TG04GeoKoord_Rutor / _Adress (RT90 + SWEREF99), TG04GeoKoord_TatSmaTyp (ortstyp/tätort).

En agent som ser `"Telefon": "*"` kan tolka det som saknad data istället för **konto utan TG22**. Inget verktyg förklarar TG-grupper eller mappar `*` → “tillägg ej tillgängligt på detta konto”.

### 5.4 Reklam

Kod `21`/`22`/`23` = har frånsagt sig reklam (ev. telefonspärr). README och sökverktyg bevarar fältet och förbjuder stripping. Tool-texten säger *att* bevara `Reklam`, inte *vad koderna betyder* eller att vidarebefordrad direktmarknadsföring mot `21–23` strider mot god sed enligt SCB.

---

## 6. Kända SCB-gränser (officiella)

Från SCB:s avgiftsfria-API-sida, inbakade i `src/scb/types.ts` och README:

| Gräns | Värde | MCP-beteende |
| --- | --- | --- |
| Max rader per hämtning | **2 000** | `QUERY_TOO_BROAD` efter count; `hamta*` anropas inte |
| Paginering | **Ingen** | Inget offset/limit i vår klient. Tredjepart skickar `offset` — strider mot SCB; behandla som overifierat |
| Rate limit | **10 anrop / 10 s / användare** | Klient-side sliding window. HTTP 429 → `SCB_RATE_LIMITED` |
| Avbrott | HTTP **503** | `SCB_UNAVAILABLE`, retryable |
| Tid | **Aktuellt register**, ingen historik | Inget datumfilter mot registerversion |
| Delta | **Nej** i API:et | Förändringsfiler = avgiftsbelagd avisering |
| Uppdatering | Nattligen utom lördag–söndag; variabler vecka/månad/år | Ingen “senast uppdaterad”-resurs |
| Format | JSON eller XML | Bara JSON (`Accept: application/json`) |
| Fälttyp | Alla värden som **text**; numeriska fält med ledande nollor | Ingen typning i MCP |

Nytt API **september 2026**: API-nyckel istället för cert; paginering och större uttag; sammanslagna layouter utgår; variabeländringar (gulfärgade fält i PDF). Nuvarande API kvar minst sex månader. Bygg inte agentlogik mot sammanslagna layouter.

Anställda och omsättning är **storleksklasser**, inte exakta tal (sekretess). Exakta anställda finns inte i detta API.

---

## 7. Endpoint-karta: mappat vs luckor

### 7.1 Wrappat i `src/scb/endpoints.ts`

```
/api/je/koptakategorier
/api/je/kategoriermedkodtabeller
/api/je/kodtabell
/api/je/koptavariabler
/api/je/variabler
/api/je/raknaforetag
/api/je/hamtaforetag

/api/ae/koptakategorier
/api/ae/kategoriermedkodtabeller
/api/ae/kodtabell
/api/ae/koptavariabler
/api/ae/variabler
/api/ae/raknaarbetsstallen
/api/ae/hamtaarbetsstallen
```

Det är den kompletta JE/AE-kärnan som SCB dokumenterar som metadata + räkna + hämta. För *ren JE/AE-layout* är sökvägsytan i stort sett täckt.

### 7.2 Refererade men inte wrappade (help)

README och `payload.ts`:

```
GET /help
GET /help/exampleJe
GET /help/exampleAe
```

Certifikatkrav. Utan cert: HTTP 500 mot `/help` i den här miljön. Agenter kan inte läsa exempel, operatorer eller header-namn (`api-id` vs `APIId` — README ber om att bekräfta mot help; default i `env.ts` är `api-id`, minst en tredjepartsklient använder `APIId`).

### 7.3 SCB-layouter som certet *kan* nå, men MCP inte modellerar

Fyra postbeskrivningar, begärs vid cert-ansökan:

| Layout | MCP | SCB:s framtid |
| --- | --- | --- |
| Företag (JE) | Ja (`objectType: company`) | Kvar |
| Arbetsställe (AE) | Ja (`objectType: workplace`) | Kvar |
| Företag med uppgifter om huvudarbetsstället | Nej | **Utgår** i nya API:et |
| Arbetsställe med uppgifter om företaget | Nej | **Utgår** i nya API:et |

Sammanslagna layouter ger HAE_*-fält på JE-raden resp. Ftg-*-fält på AE-raden. Idag måste en agent göra två sökningar och joina på `PeOrgNr`. Det är rätt arkitektur mot 2026-API:et. Investera inte i de sammanslagna sökvägarna utan att veta att kontot har dem **och** att de överlever.

### 7.4 Påstådda extra sökvägar (overifierade mot detta cert)

scb-smart-search anropar bland annat:

- `GET /api/Common/TGGrupper`
- `GET /api/Common/KontrollTyper`
- `POST /api/Je/HamtaForetagXML`

Dessa finns **inte** i den här repon. De kan vara riktiga Common-resurser på samma `sokpavar`-host, eller död kod. Live-verify mot cert krävs innan de räknas som luckor i *vår* yta.

### 7.5 Live-täckning i repon

`scripts/verify-live.ts` och `tests/live/scb.live.test.ts` täcker: JE-kategorier, AE-kategorier, kodtabell `Företagsstatus`, `raknaforetag` för aktiva+registrerade. **Inte** täckt live: `hamtaforetag`/`hamtaarbetsstallen` (README: testa med smalt filter), `koptavariabler`/`variabler`, `kategoriermedkodtabeller`, AE-räkning, help, XML, Common.

---

## 8. Vad “maximal täckning av SCB” betyder här

**Inne i certifikatets API-familj (`nv0101` / `sokpavar`):**

1. Alla JE- och AE-metadataendpoints kontot får (`kopt*` vs full lista).
2. Kodtabeller per kategori, inklusive SNI med `Branschniva`.
3. Räkna + hämta för JE och AE, med korrekt toppnivåstatus (inkl. `Arbetsställestatus`).
4. Help som läsbar resurs (operatorer, exempel, header-namn).
5. Tilläggsgrupper som kontot faktiskt har — och explicit markering när värdet är `*`.
6. Ev. Common-endpoints om live-verify bekräftar dem.
7. Ev. XML-hämtning: ointressant för MCP som redan är JSON.

**Inte** “hela SCB”. Samma `.pfx` når inte PxWeb, geodata eller Hydra. Andra företagsregistertjänster är andra kontrakt, ofta avgift.

Se avsnitt 12 för explicit OUT OF SCOPE.

---

## 9. Data agenter behöver men inte kan upptäcka via servern

| Behov | Finns hos SCB | Synligt via MCP idag |
| --- | --- | --- |
| Giltiga operatorer | Help, troligen `variabler` med `includeValueMetadata` | Nej — fria strängar, ingen katalog |
| Vilka fält som är toppnivå vs `Kategorier[]` | `exampleJe` / `exampleAe` | Delvis hårdkodat för två JE-fält; AE-status saknas |
| Filtervariabel för namn/orgnr | `koptavariabler` (om agenten listar och gissar rätt) | Ingen semantik (`Namn` vs `Firma` vs `Företagsnamn`) |
| Kodvärden för status, SNI, kommun | `kodtabell` / `kategoriermedkodtabeller` | Ja, men opakt JSON och SNI kan vara för stort för en tool-response |
| JE vs AE geografi | Variabelbeskrivning på scb.se | Bara README-prosa, inte tool/resource |
| Tillägg vs `*` | Postbeskrivning TG* | Nej |
| Reklamkoder 11–23 | Variabelbeskrivning | Fältet returneras, koderna förklaras inte |
| Storleksklass-tabeller (anställda, omsättning, SME) | Variabelbeskrivning / kodtabell | Bara om agenten hämtar rätt kategori |
| Lookup ett orgnr / CfarNr | Filter `ArLikaMed` på rätt variabel | Inget identitetsverktyg |
| Alla AE för ett JE | AE-sök på `PeOrgNr`/`OrgNr (12 siffror)` | Agenten måste konstruera det |
| Aggregering (antal per kommun/SNI) | Inte i detta API (räkna ger en siffra) | Nej — och ska inte låtsas |
| Historik / förändringar | Inte i detta API | Nej |
| Vilken API-id-header som gäller | Help | Default `api-id`, osäkert |
| Kontoets layouter | SCB-ansökan / hjälp | Ingen `scb_describe_account` |
| Kommande API-brytning sep 2026 | scb.se | Ingen resurs |

`scb_list_categories` / `scb_list_variables` **kan** ge råmaterialet, men agenten får ingen ontologi: vad som är sökbart, vad som är returfält, vad som är tillägg, vad som är JE-only.

---

## 10. Konkreta capability gaps (med evidens)

### G1 — Help och operatorer osynliga

**Evidens:** README länkar `/help`, `/help/exampleJe`, `/help/exampleAe`; `payload.ts` säger att POST följer exampleJe; operator är `z.string()` i `schemas.ts`; inget MCP-verktyg eller resource hämtar help. Utan cert: HTTP 500.

**Effekt:** Agenten gissar `Contains` istället för `Innehaller`, eller `Företagsnamn` istället för `Namn`/`Firma`.

### G2 — `Arbetsställestatus` serialiseras troligen fel

**Evidens:** `TOP_LEVEL_CATEGORIES = { Företagsstatus, Registreringsstatus }` (`payload.ts`). Tester skickar AE-filter `Arbetsställestatus` som kategori (`tests/mcp-tools.test.ts`) → `Kategorier[]`. Proffera help 2026-08-19: AE-kropp med toppnivå `"Arbetsställestatus": "1"`.

**Effekt:** AE-sök på “verksamma arbetsställen” kan avvisas eller ge fel population. JE-exemplet är testat; AE-exemplet är inte.

### G3 — Opaque metadata, ingen fältontologi

**Evidens:** `parseListResponse` returnerar payload oförändrad; MCP lägger bara `objectType` + `source`. Inga Zod-scheman för kategori-/variabelrader. Tredjepart visar fält som `Id_Kategori_AE`, `VardeLista`, `TillaggsGrupp` — overifierat här, men visar att SCB-metadata *har* struktur som slängs bort.

**Effekt:** Agenten kan inte systematiskt skilja kodtabellkategori, fritextvariabel, tillägg och returfält.

### G4 — 2000-taket utan navigerbar narrowing

**Evidens:** `queryTooBroad` föreslår bara *“Narrow the query using additional SCB filters.”* Inga kandidatdimensioner (län, SNI 2-siffror, storleksklass). Ingen paginering (SCB-officiellt). `scb_search_*` gör alltid count+fetch = **två** av tio anrop per 10 s.

**Effekt:** “Alla aktiva aktiebolag i Sverige” (~800 000) är omöjligt att lista. Agenten vet inte *hur* den ska dela upp (t.ex. per länkod 01–25) utan att själv ha kodtabellen.

### G5 — Identitetsuppslag saknas som first-class

**Evidens:** Inget verktyg tar `orgNr`/`cfarNr`. Proffera/help: `ArLikaMed` på `OrgNr (10 siffror)` / `OrgNr (12 siffror)`.

**Effekt:** “Vad är SCB-uppgifter för 556xxx?” kräver att agenten upptäcker variabelnamnet. Hög felrisk.

### G6 — JE↔AE-join och geografi odokumenterad i tools

**Evidens:** README-exemplet Gävleborg; tool-descriptions nämner bara JE/AE och 2000-gränsen. Inget `scb_workplaces_for_company`.

**Effekt:** Agenten räknar JE med län-filter (AE-begrepp) eller missar att ett företag i Stockholms säte kan ha AE i Gävleborg.

### G7 — Kontoets tillägg och `*`

**Evidens:** Postbeskrivning: obeställda TG* = `*`. MCP lämnar råfält. Inget `TGGrupper`-anrop.

**Effekt:** Telefon/e-post/omsättning ser “tomma” ut. Agenten hallucinerar bortfall.

### G8 — Header-namn och kontoytan odokumenterade runtime

**Evidens:** `SCB_API_ID_HEADER` default `api-id`; README “Confirm against SCB help”. Ingen tool returnerar vilket konto, vilka layouter, vilka kopt-listor som *inte* ingår.

### G9 — Live-luckor i vår egen verifikation

**Evidens:** `verify-live.ts` stoppar före `hamta*`. Sök > 2000 är enhets-mockad, inte live.

### G10 — SNI/kodtabell-volym vs MCP-context

**Evidens:** `includeCodeTables` hämtar `kategoriermedkodtabeller` i ett anrop. SNI 2025 har hundratals koder (tredjepart: ~822). En enda tool-response kan mätta agent-context.

**Effekt:** Agenter antingen skippar kodtabeller och gissar SNI, eller drunknar i dem.

---

## 11. Flaskhalsar för agentautonomi

1. **Upptäckt är tvåstegs och namn-känslig.** Måste `list_*` → gissa exakt SCB-sträng → `count` → ev. `search`. Inget alias (`Gävleborg` → länkod `21`).
2. **Operator- och toppnivåkontraktet sitter i cert-låst HTML**, inte i MCP.
3. **Rate limit 10/10s** + search = 2 anrop + metadata gör “utforska SNI-trädet” långsamt. Klienten väntar (bra) men agenten ser bara latens.
4. **Ingen paginering** gör stora populationer till count-only. Autonomi kräver *strategi för avgränsning*, inte fler hamta-anrop.
5. **JE och AE är olika objekt.** Utan ontologi väljer agenter fel layout för “företag i kommunen”.
6. **Tillägg är kontobundna.** Samma verktyg, olika fältmängd, tyst `*`.
7. **Sekretessklasser** (anställda, omsättning) ser ut som “antal” i användarfrågor. API:et kan inte svara “exakt 37 anställda”.
8. **Aktuellt snapshot.** “Företag som startade 2019 och sedan lades ner” kräver historik som inte finns.
9. **Kommande API (sep 2026)** bryter auth, paginering och layouter. Agentkontrakt som hårdkodar cert+sokpavar-sökvägar får kort livslängd.
10. **Reklam- och PII-fält** (telefon, e-post, personnummer i `PeOrgNr` för enskilda näringsidkare) returneras rått. Autonomi utan policy är en compliance-risk, inte bara en datalucka.

---

## 12. Rankade förslag (analys, inte implementation)

Prioritet: **påverkan på agentträffsäkerhet** × **håller sig inom sokpavar** × **överlever 2026-API:et**.

### P0 — måste för att agenter ska träffa rätt kontrakt

1. **MCP resource eller read-only tool för help** (`/help`, `exampleJe`, `exampleAe`) plus en kort operatorlista som cacheas från help, inte från gissning. Utan detta förblir filterkonstruktion lottery.
2. **Toppnivåstatus per layout.** Lyft `Arbetsställestatus` (AE) analogt med JE-status. Verifiera mot `exampleAe` med cert. Justera tester som idag stoppar AE-status i `Kategorier[]`.
3. **Identitetsuppslag** som tunt socker runt redan tillåtna filter: `orgNr` / `cfarNr` → rätt variabelnamn från `koptavariabler` (inte hårdkodat om namnen skiljer sig per konto) → count+search. Det är inte ett nytt SCB-API; det är discoverability.

### P1 — ontologi utan att lämna sokpavar

4. **Normalisera metadata** från `koptakategorier`/`koptavariabler`/`variabler` till en agent-tabell: namn, layout, toppnivå vs kategori vs variabel, tilläggsgrupp, tillåtna operatorer om `includeValueMetadata` ger dem, länk till kodtabell.
5. **Kontobeskrivning:** vilka kopt-kategorier/variabler som finns, vilka returfält som är `*` vs ifyllda (stickprov), header som faktiskt används. Minskar G7/G8.
6. **Narrowing-hints vid `QUERY_TOO_BROAD`:** föreslå nästa kategori från redan listad metadata (t.ex. `Säteslän` / `Län` / `Bransch` med `Branschniva`). Inte paginering — SCB har ingen.
7. **Statiska SCB-resources** (variabelbeskrivning-sammandrag, JE vs AE geografi, Reklam-koder, storleksklasser) som MCP resources, så agenter inte behöver scb.se. Håll dem som *dokumentation*, inte som ersättning för live kodtabeller (kommuner/SNI ändras).

### P2 — täckning inuti familjen, medvetet smal

8. **Live-verify** av `hamtaforetag`/`hamtaarbetsstallen` med smalt orgnr-filter; AE-räkning; `variabler`; help-parse. Utöka `verify-live.ts`.
9. **Probe Common** (`TGGrupper`, `KontrollTyper`) och XML-POST mot *detta* cert. Om 404: dokumentera som frånvarande. Om 200: överväg read-only tools. Anta inte tredjepart.
10. **SNI-strategi:** default `scb_get_category_values` för `Bransch` med varning/storlek; ev. prefix-sökning i kodtabell så hela SNI inte dumpas i context. `Branschniva` i tool-description.
11. **JE→AE via PeOrgNr** som dokumenterat recept eller tunt tool (`scb_search_workplaces` med låst variabel). Ersätter sammanslagna layouter utan att bero på dem.

### P3 — medvetet senare / undvik

12. **Sammanslagna layouter:** bara om kontot har dem *och* det finns ett tidsbegränsat behov före sep 2026. SCB tar bort dem.
13. **`offset`/`limit`:** implementera inte mot SCB:s skriftliga “ingen paginering” bara för att tredjepart skickar fälten.
14. **Aggregering, historik, delta, PxWeb-join:** kan inte lösas i denna API-familj. Se OUT OF SCOPE.
15. **Fältprojektion / XML:** låg agentnytta; JSON-poster är redan stora men hanterbara under 2000 rader.

---

## 13. OUT OF SCOPE för detta MCP

Följande är **andra SCB-produkter eller andra kontrakt**. De ska inte bakas in i SCBmcp under nuvarande cert/sokpavar-uppdrag. En “smartare SCB-data layer” kan senare *peka på* dem, men de kräver egen auth, egna gränser och egen semantik.

| Produkt | Vad det är | Varför inte detta MCP |
| --- | --- | --- |
| **PxWebApi v1/v2** (Statistikdatabasen) | Officiell statistik, tabeller, GET i v2, 150 000 celler, 30 anrop/10 s per IP, CC0 | Annan host, ingen mTLS, aggregerad statistik — inte mikrodata om företag |
| **Öppna geodata** (WMS/WFS, DeSO/RegSO, tätorter, rutor) | Geodataportalen / Lantmäteriet | Annan infrastruktur; AE-koordinater i TG04 är mikrodata, inte Inspire-lager |
| **Branschnyckeltal** | 46 nyckeltal × ~800 branscher, aktiebolag, via Statistikdatabasen/Excel | Aggregerad jämförelsestatistik, inte registerrader |
| **Myndighetsregistret** | Statliga myndigheters kontaktuppgifter (SFS 2007:755), webb | Inte sokpavar; SCB har sagt att det inte finns ett motsvarande öppet API |
| **Aviseringar** | Betald förändringsfil (vecka/månad/kvartal) efter totaluttag | SCB FAQ: finns inte i det avgiftsfria API:et |
| **NÄRA** (Näringslivet regionalt) | Betald regionvy, rapporter, nyaktiverade/flyttade AE | Egen tjänst, prislista |
| **Motpartsklassificering** | Separat API, komprimerad textfil, sektor/ägarkategori för kundregister | Annat svarskontrakt; cert kan vara samma *familj* men inte wrappat här och ska inte antas |
| **CfarNrSok** (`cfarnrsok.scb.se`) | Publik AE-lista per orgnr | Webb-UI, inte privateapi |
| **Antalsräknaren** (`foretagsregistret.scb.se`) | Publik räkning, räknings-id för manuell beställning | Inte REST `raknaforetag` |
| **Skräddarsydda uttag / tabeller / Lantbruksregistret / export-import-beställning** | Mejl till scbforetag@scb.se, avgift, ev. 50 års årsversioner | Batch, inte API |
| **Hydra / inlämningstjänst** (`helpm2m.scb.se`) | Inlämning av statistikuppgifter, annat cert-program | Write-path, inte företagsregister |
| **Kolada** | Kommunala nyckeltal | Inte SCB |

Även **inom** företagsregistret är följande OUT OF SCOPE för MCP som data layer (kan inte uppfyllas av sokpavar):

- Historiska registerversioner och tidsserier på mikrodata.
- Exakt antal anställda eller exakt omsättning.
- Paginering utöver 2000 rader (före nya API:et).
- Bulkdump av hela registret (~1,8M JE) via API.
- Att kringgå reklamspärr eller använda personnummer i `PeOrgNr` för andra syften än registerträff.

---

## 14. Rekommenderad läsning för nästa analyssteg

- Live mot cert: spara (utan att commita) `exampleJe`/`exampleAe` och diff mot `payload.ts`.
- Live: `koptakategorier` vs `koptavariabler` för både JE och AE — faktisk namnlista för *detta* konto.
- Probe `GET /api/Common/TGGrupper` och `KontrollTyper`.
- Följ SCB:s september 2026-API: auth, paginering, utgående layouter.

Den här filen ska inte uppdateras med implementationsdetaljer förrän någon av P0-punkterna faktiskt landar i kod.
