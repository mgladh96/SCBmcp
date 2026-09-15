# 06 — Naturligt språk → SCB och täckning

Analys. Ingen produktimplementation.

**Fråga:** hur ska en yttre AI-agent kunna besvara affärsfrågor om svenska företag och arbetsställen via SCBmcp **utan att memorera SCB:s struktur** — och vad är maximal *praktisk* täckning inom Allmänna företagsregistret (AFR)?

**Svar i korthet:** README:ns ideala flöde är korrekt som *kontrakt* (agenten planerar, servern är dataåtkomst) men fallerar i praktiken eftersom verktygen kräver SCB-namn, koder och operatorer som agenten inte kan upptäcka billigt. Högst utväxling ger ett **smartare tunt lager (a)**: sökbar metadata, koduppslag på text, normaliserade svar, operatorer och fältprojektion — inte en LLM inuti servern (b). Maximal täckning inom AFR är *antal + smala listor + uppslag*, inte dump av Sverige. Historik, andra SCB-källor, paginering och “hitta alla byggföretag i landet” är orealistiskt i nuvarande API.

Syskonanalyser (samma körning, parent slår ihop backlogar):

| Nr | Ämne | Denna texts gräns |
| --- | --- | --- |
| 01 | SCB-API:er och datamodeller | Här bara det agenten måste *välja* för NL |
| 02 | Arkitektur och gränser | Här bara hur 2 000 / 10 per 10 s / SSE *bryter NL-flödet* |
| 03 | Discovery och metadata | Här hur metadataverktygen misslyckas som *agent-UX* |
| 04 | Query planning | Här NL→filter och när count vs search |
| 05 | Fel och självkorrigering | Här bara fel som syns i NL-loopen |

---

## 1. Kontraktet i README (idealt flöde idag)

README (svensk `main`) är entydig:

> Servern är **bara ett dataåtkomstlager**. Den söker inte i andra källor, berikar inte poster, skrapar inte webbplatser och **kör ingen LLM**.

JE (juridisk enhet / `company`) och AE (arbetsställe / `workplace`) är alltid explicita. Filterkontraktet är SCB-nära JSON, inte ett DSL för naturligt språk. Kategori- och variabelnamn ska tas från metadataverktygen, inte hårdkodas.

### 1.1 Verktyg agenten får

| Verktyg | Roll i NL-flödet |
| --- | --- |
| `scb_list_categories` | Vilka kodtabellskategorier kontot får använda (JE eller AE). `includeCodeTables` kan slå på hela kodtabeller. |
| `scb_get_category_values` | En kodtabell, med **exakt** kategorinamn från listan. |
| `scb_list_variables` | Fritextfält (t.ex. namn, postort). `includeValueMetadata` för värdedomän. |
| `scb_count_companies` / `scb_count_workplaces` | Antal träffar. |
| `scb_search_companies` / `scb_search_workplaces` | Rader. Räknar först; `QUERY_TOO_BROAD` om count > 2 000. |

Ingen MCP-resource, ingen MCP-prompt, inget uppslagsverktyg, ingen fältlista vid hämtning. Operator är fri `string` och skickas rakt till SCB (`src/scb/schemas.ts`, `src/scb/payload.ts`). Metadata returneras som SCB:s rå-JSON (`parseListResponse` är identitet).

### 1.2 README:ns exempel

Användare: *“Hitta aktiva byggföretag i Gävleborg med 10–49 anställda.”*

Agenten **ska** (citat av flödet, inte servern):

1. Lista kategorier/variabler för `company` (och AE “om frågan egentligen gäller arbetsställen”).
2. Hämta kodtabeller för SNI/bransch, län, företagsstatus, storleksklass, …
3. `scb_count_companies` med de koderna.
4. 0 → stopp. \> 2 000 → smalna. ≤ 2 000 → fortsätt.
5. `scb_search_companies`.
6. Resonera på returnerad JSON.

README tillägger att Gävleborg är **län på arbetsställe**; säteslän är företagsnivå — agenten ska ta det från SCB-metadata, inte från README.

Filterexemplet i samma README är däremot:

```json
{ "variable": "Företagsnamn", "operator": "Innehaller", "value": "Bygg" }
```

Det är en **annan fråga** (namn innehåller “Bygg”), inte SNI-byggverksamhet. Live-testets exempelJe använder `Firma` + `SätesKommun`. Redan dokumentationen ger tre konkurrerande ledtrådar (JE vs AE, namn vs bransch, Firma vs Företagsnamn).

### 1.3 SCB-gränser som flödet antar att agenten respekterar

- Högst 2 000 rader, **ingen paginering**.
- 10 anrop / 10 sekunder / användare (klienten köar utgående anrop).
- HTTP 503 vid störning.
- **Endast aktuellt läge** — ingen historik i AFR-API:et.
- `Reklam` lämnas orörd (reklamspärr är inte något att runda).
- Kontot ser bara **köpta** kategorier/variabler (`koptakategorier`, `koptavariabler`).

SCB:s publika villkor (avgiftsfritt AFR-API) bekräftar samma tak, nattlig uppdatering utom lördag–söndag, och att kategorier har kodtabeller medan variabler är fritext (`Postort=Örebro`). Nytt API aviseras september 2026 (API-nyckel, paginering, sammanslagna layouter utgår). Den här analysen gäller **nuvarande** sokpavar.

---

## 2. Vad som faktiskt fallerar

Idealfödet förutsätter att agenten (i) väljer rätt objekttyp, (ii) hittar rätt SCB-namn, (iii) översätter svenska begrepp till koder, (iv) känner operatorer, (v) håller sig inom anrops- och tokenbudget, (vi) smalnar när count > 2 000. Inget av det stöds av verktygsytan utöver korta engelska `description`-strängar.

### 2.1 Genomlysning av README-exemplet

| Användarens ord | Vad AFR faktiskt kräver | Typiskt agentfel utan minne |
| --- | --- | --- |
| “Hitta” | Antingen **antal** (alltid möjligt) eller **lista** (bara om ≤ 2 000). | Search direkt, eller search efter för bred count. |
| “aktiva” | JE: `Företagsstatus` = `1` (verksam = moms och/eller arbetsgivare och/eller F-skatt). Ofta också `Registreringsstatus`. AE: `Arbetsställestatus` = `1`. | Gissar `status: "active"`, blandar JE/AE-fält, hoppar status. |
| “byggföretag” | SNI 2025-kod(er) i kategori Bransch, ev. `branchLevel` / `Branschniva`. Företagen sätter själva SNI; max fem koder; JE-SNI aggregeras från AE. | Fritext `Företagsnamn Innehaller Bygg`; SNI 2007 `41–43`; en femsiffrig kod när frågan är avdelning F. |
| “i Gävleborg” | AE: kategori **Län**, kod `21`. JE: **Säteslän** (säte / folkbokföring), inte var verksamheten ligger. | `Län` på JE; variabelvärdet `"Gävleborg"`; Stockholm-säten med Gävleborg-AE missas eller räknas fel. |
| “10–49 anställda” | **AnstSME** kod `2` = 10–49. **Storleksklass Anställda** är *annan* indelning (`4` = 10–19, `5` = 20–49). Antal anställda är sekretessbelagt — bara klasser. | Fritext “10-49”; fel tabell; antar exakt headcount. |

README steg 1 startar med `company`. För “i Gävleborg” är den *affärsmässigt* korrekta objekttypen nästan alltid **AE**. En agent som följer README bokstavligen svarar på “företag med säte i Gävleborg”, inte “verksamhet i Gävleborg”.

### 2.2 Failure modes (ordnade efter hur ofta de dödar svaret)

**F1 — Discovery dump slår ut kontexten.**  
`includeCodeTables: true` hämtar `kategoriermedkodtabeller`. SNI 2025 är tusentals rader. En yttre modell som “gör som README” får antingen (a) en payload som inte får plats, eller (b) en trunkerad kodtabell och hallucinerar resten. `scb_get_category_values` utan sökprefix har samma problem för Bransch.

**F2 — Exakta namn är osynliga.**  
Verktygen kräver SCB:s strängar (`Företagsstatus`, `SätesKommun`, `Firma`, …). Listverktygen returnerar okänd SCB-form (smoke-testet letar `categories.Kategorier`). Agenten gissar engelska (`industry`, `county`) eller närliggande svenska (`Företagsnamn` vs `Firma` vs `Benämning`). Det ger `SCB_UNKNOWN_CATEGORY` / `SCB_UNKNOWN_VARIABLE` / `SCB_INVALID_QUERY` med SCB-body-snippet — inte “menade du X?”.

**F3 — Kodtabell ≠ naturligt språk.**  
Län, kommun, juridisk form, SNI, storleksklass, reklam, sektor är koder. Det finns inget `q=Gävleborg`. Agenten måste antingen memorera koder (förbjudet mål) eller hämta hela tabellen (F1).

**F4 — Operatorer är odokumenterade i MCP.**  
README: kontrollera SCB help (certifikatkrav). Schema: `operator: z.string()`. Tester visar `Innehaller`. Yttre agent utan certifikat kan inte läsa `/help/exampleJe`. Vanliga gissningar (`contains`, `LIKE`, `=`) är ogiltiga.

**F5 — Anropsbudgeten tar slut före sökningen.**  
Idealfödet: 2 listor + 4–6 kodtabeller + count + search ≈ 8–10 SCB-anrop, plus att varje search redan gör en intern count (`ScbClient.search`). 10 / 10 s är lätt att träffa. Discovery på *både* JE och AE fördubblar. `SCB_RATE_LIMITED` (`retryable: true`) utan vägledning om vilka anrop som var onödiga.

**F6 — `QUERY_TOO_BROAD` utan karta.**  
`details.suggestion` är `"Narrow the query using additional SCB filters."` Agenten vet inte *vilket* filter som delar populationen (kommun vs SNI-nivå vs storlek). Blind retrys slösar kvot. Se även 04 (query planning).

**F7 — 2 000 rader är inte ett agentsvar.**  
En “lyckad” search kan dumpa 2 000 JE/AE-poster med alla basfält (+ `*` för obeställda tillägg enligt postbeskrivningen). Det fyller kontexten och ger inget användbart svar. Det finns ingen fältprojektion, ingen `limit` under 2 000, ingen sammanfattning.

**F8 — JE/AE-semantik.**  
Frågor om adress, “i stan”, “butiker”, “arbetsplatser” är AE. Frågor om org.nr, juridisk form, F-skatt, koncern/ägarkategori, omsättningsklass är JE. Flödet har två parallella verktygsfamiljer men ingen routinghjälp. Sammanslagna layouter (JE+huvud-AE) finns i SCB:s postbeskrivningar men **ingår inte** i SCBmcp — medvetet, och de utgår i 2026-API:et.

**F9 — Kontospecifik yta.**  
Metadata är *köpt* utbud, inte “alla AFR-fält”. En agent som memorerar postbeskrivningens tillägg (telefon, e-post, koordinater, …) kan anropa fält kontot saknar. Omvänt: utan att lista variabler vet den inte att PeOrgNr går att söka på.

**F10 — Hjälpsidor och PDF:er är utanför MCP.**  
Variabelbeskrivning, SNI-sök, Rikets indelningar, operatorer kräver webben eller certifikat. En agent “med minimal förkunskap” har bara de sju verktygen.

### 2.3 Vad som *redan* fungerar (behåll)

Tunna lagret gör rätt saker som inte ska ersättas med LLM:

- JE/AE är inte hopslagna till “provider”.
- Count-first och vägran > 2 000 (skyddar SCB-kvot och agenten mot tysta trunkeringar).
- Maskinläsbara felkoder.
- `Reklam` strippas inte.
- Toppnivåfälten `Företagsstatus` / `Registreringsstatus` serialiseras som SCB exampleJe — agenten behöver inte veta det.
- Rate limiter utåt.

Problemet är inte att servern är “för dum” i affärslogik. Den är **för tyst** i *upptäckt och uppslag*.

---

## 3. Vad SCBmcp måste ge en yttre agent

Mål: agenten ska kunna gå från svensk fråga → giltig SCB-query med **verktygsanrop**, inte med inbakad SCB-kunskap. Servern ska fortfarande inte *tolka frågan som mening*.

### 3.1 Kapabiliteter (lager a)

| # | Kapabilitet | Varför agenten behöver den |
| --- | --- | --- |
| K1 | **Stabil, liten katalog** över kategorier och variabler per `objectType`: kanoniskt namn, JE/AE, kort semantik (kodtabell vs fritext), ev. alias. | Slipper parsera rå SCB-JSON och gissa `Kategorier[]`. |
| K2 | **Sök i katalog och kodtabell** (`q`, prefix, maxträffar). SNI, län, kommun, storleksklass, juridisk form. | Ersätter “hämta hela SNI”. |
| K3 | **Operatorer som enum + när de gäller** (kategori vs variabel, `value2` för intervall). | Tar bort certifikat-gated help ur den kritiska vägen. |
| K4 | **JE/AE-routing som data**, inte som LLM: vilka begrepp hör till säte vs belägenhet, statusfält per objekt, identiteter (`PeOrgNr` 12 tecken / `CfarNr`). | README-fällan “börja alltid med company”. |
| K5 | **Count som förstahandssvar** + search bara när count ≤ 2 000 *och* användaren behöver rader. | “Hur många …” ska inte ens försöka hamta. |
| K6 | **Smalningshjälp vid bred query** (vilka ytterligare kategorier *finns* att skära på; inte automatisk omräkning av hela Sverige). | F6 utan att gömma query planning i en modell. |
| K7 | **Fältprojektion och hårt max** på search-svar (plus schema över *tillgängliga* fält). | F7. |
| K8 | **Lokal metadata-cache** (katalog + små kodtabeller) så discovery inte äter 10/10 s. TTL efter SCB:s nattjobb räcker. | F5. |
| K9 | **MCP-prompt** (statisk) för flödet: metadata → koder → count → ev. search; stoppregler; Reklam. | Yttre agent med “minimal förkunskap”. |
| K10 | **MCP-resources** för små, stabila tabeller (län, storleksklasser, företagsstatus) och länk till SCB:s variabelbeskrivning. | Billigare än tool-anrop för det som sällan ändras. |
| K11 | **Kontoets faktiska yta** i katalogen (“den här sessionen har inte e-post”). | F9. |
| K12 | **Identitetsuppslag** som förstaklass: PeOrgNr / CFAR / namn-contains, med normalisering (10- vs 12-siffrigt org.nr). | Vanligaste *precisa* affärsfrågan. |

Allt ovan är deterministisk dataåtkomst, normalisering och indexering av det SCB redan returnerar.

### 3.2 Vad som *inte* ska ligga i SCBmcp

- Tolka hela användarfrågan till filter i ett `ask("hitta bygg i Gävleborg")`.
- Synonymgenerering via LLM (“bygg” → SNI-träd).
- Berikning från Bolagsverket, webb, kredit, PxWeb.
- Cirkumvention av Reklam.
- Paginering som låtsas att SCB har sidnummer.

Synonymtabeller *som data* (Gävleborg→21, “aktiebolag”→juridisk form 49, AnstSME 10–49→2) är lager (a) om de är granskade och versionerade. De är inte “en modell i servern”.

---

## 4. (a) Smartare tunt lager vs (b) LLM i servern

**Rekommendation: (a), med hög tröskel för (b).** README:ns produktgräns är redan (a). Analysen ger inte starka skäl att bryta den.

### 4.1 Varför (a) vinner för just NL→SCB

| Kriterium | (a) Tunt lager | (b) LLM i MCP-processen |
| --- | --- | --- |
| Hallucinerade koder | Omöjliga om uppslag bara returnerar rader ur kodtabellen | Vanligt (fel SNI-år, fel länskod) och svårt att testa |
| Yttre agent | Finns redan; den *ska* göra NL | Duplicerar samma förmåga, med extra latens och kostnad |
| Determinism | Samma fråga + samma register → samma filterkandidater | Modellbyte ändrar svar |
| Kvot mot SCB | Cache och sök minskar anrop | Extra anrop när modellen “provar sig fram” |
| Certifikat/säkerhet | mTLS stannar i SCB-klienten | LLM-provider i samma process som `.pfx` är onödig yta |
| Kontoets utbud | Katalog = `koptakategorier` | Modellen känner “alla SCB-fält” |
| 2026-API | Normalisering isolerar namnbyten | Promptar måste skrivas om ändå |
| Utvärdering | Fixtures: `q=Gävleborg` → kod 21 | Kräver LLM-eval, fläckigt |

NL-förståelse (“användaren menar belägenhet, inte säte”) är den yttre agentens jobb **om** servern exponerar skillnaden som struktur (K4) snarare än som prosa i README.

### 4.2 När (b) *skulle* kunna motiveras — och varför det ändå är fel produkt

| Argument för (b) | Motargument |
| --- | --- |
| SNI-etiketter är luddiga (“bygg”, “tech”, “vård”) | Luddighet hör hemma hos yttre agent + (a)-träfflista. Ev. **embeddings/BM25 över kodtexter** är sökindex, inte generativ LLM. |
| Klienter utan agent (curl, intern UI) vill ställa frågor på svenska | Det är en **annan tjänst** framför MCP, med egen eval och disclaimer. Inte SCBmcp. |
| Kontextfönstret räcker inte för kodtabeller | Då ska tabellen inte in i kontexten — K2/K8/K10. LLM i servern löser inte payloadstorlek mot SCB. |
| En `scb_ask`-tool minskar tool-churn | Den gömmer F6–F8. Agenten kan inte rätta en felaktig SNI om den bara ser ett svar. |

**Tillåten gråzon (fortfarande a):** lexikalt/n-gram/embedding-index över *SCB:s egna kodtexter*. Inget token-API, ingen “förstå frågan”. Träffar är `{kod, text, score}` så den yttre agenten väljer.

### 4.3 Arbetsfördelning

```
Användare (svenska)
    → yttre agent: avsikt, JE vs AE, “antal eller lista?”, avböj om utanför AFR
    → SCBmcp (a): katalog, kod-sök, count, smal search, fel med nästa steg
    → SCB AFR
    → yttre agent: citat, osäkerhet, Reklam, “detta är registerutdrag inte officiell statistik”
```

Servern översätter inte “byggföretag”. Den svarar på “koder vars text innehåller bygg, avdelning F, `objectType=workplace`”.

---

## 5. Vad som mest höjer agentens framgång

Ungefärlig effekt om agenten *inte* har SCB memorerat. “Framgång” = korrekt objekttyp + giltiga filter + antingen rätt antal eller en lista som faktiskt matchar frågan — inom kvoten.

| Rank | Förändring | Effekt | Kostnad / risk |
| --- | --- | --- | --- |
| 1 | **Kod- och katalogsök** (K2) med tak på träffar | Tar bort F1+F3, den största blockeraren | Måste cacha tabeller; SNI-sök behöver `branchLevel` |
| 2 | **Normaliserad katalog** (K1) + operatorer (K3) | Tar bort F2+F4 | Måste verifieras live mot kontot |
| 3 | **Statisk MCP-prompt + tjockare tool descriptions** (K9) | Billigast; räcker inte ensam men skär F8 och count-first | Promptdrift vs SCB-namn — peka på katalogverktyg, hårdkoda inte koder |
| 4 | **Metadata-cache** (K8) | Gör 1–3 praktiskt inom 10/10 s | TTL; inte cacha sökresultat som “sanning” över nattjobb utan medvetenhet |
| 5 | **Fältprojektion + svarstak** (K7) | Gör ≤ 2 000-listor användbara | Defaultfält måste väljas varsamt (Reklam ska följa med) |
| 6 | **QUERY_TOO_BROAD med skärförslag från katalog** (K6) | F6: “lägg till Kommun eller höj Branschniva” | Inte N extra räkningar per län utan att agenten ber om det (kvot) |
| 7 | **Identitetsnormalisering** (K12) | Org.nr-frågor blir pålitliga | Personnummer i PeOrgNr: minimera loggning |
| 8 | **Små resources** (K10) | Status, AnstSME, län | Håll SNI *utanför* resources om den är för stor — sökverktyg i stället |

**Lägst utväxling mot risk:** generativ `scb_nl_query`, automatisk “smart smalning” som kör 21 count-anrop (ett per län), `includeCodeTables` som default.

Mätning (för parent/eval, inte denna PR): en gulduppsättning på 30–50 svenska frågor med förväntad objekttyp, kategorinamn och *kodkälla* (inte nödvändigtvis exakt SNI-mängd). Utan K1–K3 kommer samma suite att mäta modellminne, inte SCBmcp.

---

## 6. Maximal praktisk täckning inom Allmänna företagsregistret

“Maximal” här = vad en yttre agent **kan** svara tillförlitligt *om* lager (a) finns, inte vad registret innehåller i PDF:en. Avgränsning: **bara AFR-API:et som SCBmcp redan wrappar** (JE + AE). Inte FDB-mikrodata, inte avisering, inte PxWeb.

### 6.1 Vad registret kan bära (agentens frågeklasser)

SCB:s AFR rymmer bl.a. (variabelbeskrivning API, SNI 2025): identitet (PeOrgNr, CfarNr), namn (Företagsnamn, Firma, Benämning), status (företag / arbetsställe / Bolagsverket / moms / F-skatt / arbetsgivare), geografi (säte vs kommun/län på AE, post- och besöksadress, A-region, tätort), näringsgren (upp till fem SNI), storlek (AnstSME, Storleksklass Anställda, omsättningsklasser, export/importklasser), juridisk form, sektor, ägarkategori, privat/publikt, Reklam, vissa tillägg (telefon, e-post, koordinater) beroende på konto.

| Klass | Exempel | Praktisk metod | Täckning |
| --- | --- | --- | --- |
| A. Uppslag | “Vad är 556…?”, “CFAR …”, “heter X” | Variabel + operator / identitetsverktyg; search count 0–n | Hög om namn-unikt eller org.nr normaliserat |
| B. Antal med filter | “Hur många verksamma AE i kommun 2180 med SNI-prefix …?” | Bara count | Hög; det är AFR:s starka sida (jfr SCB:s egen räknesida) |
| C. Smala listor | “Verksamma AB i en liten kommun + en SNI-avdelning + storleksklass” | count → search ≤ 2 000 + projektion | Medel–hög |
| D. Jämförelser | “Antal per kommun i Gävleborg för SNI F” | Loop av count (21 kommuner) med medveten kvot | Medel; kräver plan (04) |
| E. Breda listor | “Alla byggföretag i Gävleborg” / “alla i Stockholm” | Ofta count ≫ 2 000 | **Antal + be om smalning**; inte lista |
| F. Semantik som registret inte har | “innovativa”, “kunder till X”, “bästa”, webbplats, koncernträd, historisk SNI | — | **Noll inom AFR**; agenten ska avböja |

### 6.2 Vad som krävs för att *nå* den täckningen (inte mer)

1. **Rätt objekttyp som defaultregel i katalog/prompt:** belägenhet → AE; säte, juridik, skatt, ägande, omsättning → JE; “företag i regionen” → förklara båda och räkna AE om användaren menar verksamhet.
2. **Koduppslag för de filter som 80 % av affärsfrågor använder:** status, län, kommun, SNI (hierarki), storleksklass(er), juridisk form. Resten kan förbli `get_category_values` med sök.
3. **Count-first som produktsvar:** många “hitta”-frågor är egentligen populationsfrågor. Maximal täckning *ökar* om agenten slutar försöka lista Sverige.
4. **Sanning om storlek och omsättning:** bara klasser; AnstSME vs Storleksklass Anställda utskrivet i katalogen (README-exemplet 10–49 är AnstSME `2`, inte en enda kod i den finare skalan).
5. **SNI som hierarki:** `Branschniva` / prefix-sök så “bygg” kan bli avdelning snarare än en femsiffrig kod. Agenten måste kunna säga att SNI är egenrapporterad och att JE-SNI är aggregerad.
6. **Kontoets layout:** basutbud vs tillägg. Maximal täckning för *detta* certifikat ≠ postbeskrivningens alla kolumner.
7. **Reklam i varje listningssvar** så yttre agent inte föreslår utskick.
8. **Två komplementära svar** när geografi är tvetydig: `count_workplaces` i länet vs `count_companies` med säteslän — explicit, inte tyst “samma sak”.
9. **Uppdateringskadens i katalogen:** veckovis vs månadsvis vs årlig (export/import baseras på föregående år). Agenten ska inte påstå realtid.
10. **Avböjningslista inbäddad i prompt** (avsnitt 7) så täckning inte “maximeras” genom gissning.

Med (1)–(10) är praktiskt tak ungefär: **vilken som helst count-fråga som AFR:s kategorier/variabler kan uttrycka**, plus **listor för populationer ≤ 2 000**, plus **enstaka uppslag**. Det *är* maximal täckning mot detta API. Att jaga 100 % av PDF-variablerna i search-payloaden höjer inte träffsäkerheten — det höjer F7.

### 6.3 Täckning som ser hög ut men är en fälla

- **Namncontains “Bygg”** som proxy för bransch: hög recall på fel population.
- **Säteslän = Gävleborg** för regional näringslivsfråga: systematiskt fel för flerarbetsställeföretag (SCB:s eget exempel: huvudkontor vs verkstäder).
- **`includeCodeTables` för att “ha allt”:** täcker tabellen i teorin, noll i en agent-session.
- **Search när count är 1 800:** tekniskt tillåtet, praktiskt obrukbart utan projektion.
- **Export/import på AE-adress:** uppgiften finns på JE; SCB varnar uttryckligen för detta.

---

## 7. Orealistiskt

Inte backlog. Agenten ska säga nej (eller peka på annan SCB-tjänst), inte SCBmcp låtsas.

| Önskemål | Varför det inte går i AFR-MCP nu |
| --- | --- |
| Lista *alla* matchande JE/AE när N > 2 000 | Ingen paginering; 10/10 s; 2026-API kan ändra detta — inte idag |
| Tidsserier, “nya sedan i fjol”, diff mot igår | Ingen historik; avisering är annan, avgiftsbelagd tjänst |
| Officiell statistik, BNP, ram för undersökningar | AFR-utdrag är registerantal, inte statistikprodukten; SCB skriver det på räknesidan |
| “Hela Sverige, bygg, med namn och telefon” | Populationsstorlek + tilläggsfält + Reklam |
| Koncernstruktur, verkliga huvudmän, årsredovisning | Inte AFR:s uppdrag; Bolagsverket / andra källor |
| Exakt antal anställda eller omsättning i kronor | Sekretess → storleksklasser |
| Webb, mejl till alla, lead-generering som kringgår Reklam | Produkt- och lagbrott; servern ska inte strippa Reklam |
| Sammanslagen JE+AE-rad som default | Finns som SCB-layout men utgår 2026; SCBmcp exponerar dem medvetet inte |
| En inre LLM som “klär” alla svenska branschord till rätt SNI utan gulddata | Hallucination; SNI 2025 ≠ 2007; egenrapportering |
| Andra SCB-API:er (PxWeb, statistikdatabasen) via samma sju verktyg | Utanför serverns kontrakt |
| Personuppgifter om enskilda näringsidkare som “företagsinfo” utan minimering | PeOrgNr kan vara personnummer; loggning och onödig search är olämpligt |
| Att README:ns sex steg räcker för en kall agent | Det är kärnan i denna analys: kontraktet är rätt, ytan räcker inte |

---

## 8. Designprinciper för implementation (när parent prioriterar)

1. **Ingen ny intelligens som inte kan fixture-testas** mot sparad SCB-JSON.
2. **Sök returnerar SCB-koder, aldrig en påhittad kod.**
3. **Default: small payloads.** Kodtabellssök `limit` t.ex. 25. Search-defaultfält: identitet, namn, status, geografi, SNI, storleksklass, Reklam.
4. **JE och AE förblir två vägar.** Ev. “förklara skillnad”-resource, inte ett tredje `objectType`.
5. **Fel ska föreslå *verktygsnästa steg*** (`retryable`, saknat namn → katalogsök, bred query → vilka kategorier som återstår) — detaljer i 05.
6. **Bygg mot 2026:** isolera SCB-fältnamn bakom katalogen så paginering/API-nyckel inte kräver ny NL-strategi.

---

## 9. Utkast: prioriterad backlog

Parent slår ihop med 01–05. ID-prefix `NL` = denna analys. Alla poster är **lager (a)** om inget annat sägs.

| ID | Prio | Post | Varför det höjer NL-framgång | Överlappar |
| --- | --- | --- | --- | --- |
| NL-P0-01 | P0 | Katalogverktyg: normaliserad lista kategorier/variabler per objekttyp (namn, typ kod/fritext, JE/AE, kort hjälptext från SCB när den finns i svaret) | F2; slutar mata rå SCB-JSON till agenten | 03 |
| NL-P0-02 | P0 | `scb_lookup_codes` (arbetsnamn): `objectType` + kategori + `q` + `limit` → `{kod, text}[]` | F1+F3; README-exemplet blir möjligt utan SNI-dump | 03 |
| NL-P0-03 | P0 | Operatorer som enum i schema + resource/prompt: minst de SCB help/exampleJe faktiskt använder; `value2` dokumenterat | F4 | 01, 04 |
| NL-P0-04 | P0 | MCP-prompt `scb-query-workflow`: count-first, JE vs AE-geografi, AnstSME vs Storleksklass, Reklam, stopp vid 0 / > 2 000 | F8; minimal förkunskap | 04, 05 |
| NL-P0-05 | P0 | Tool descriptions på svenska *och* med anti-mönster (“Bygg i namn ≠ SNI”; “Gävleborg är AE-län”) | Billig delseger; räcker inte utan P0-02 | — |
| NL-P1-01 | P1 | In-process cache av katalog + kodtabeller (TTL ~ dygn, bakom samma mTLS) | F5; gör P0-02 billigt | 02 |
| NL-P1-02 | P1 | Search: `fields[]` + `maxRows` ≤ 2 000; defaultfält enligt §8.3; räkna `returned` vs `count` | F7 | 02 |
| NL-P1-03 | P1 | `QUERY_TOO_BROAD.details`: count, max, *kandidatkategorier att skära på* från katalog (inga extra SCB-anrop) | F6 | 04, 05 |
| NL-P1-04 | P1 | Identitet: acceptera org.nr 10/12 siffror → PeOrgNr; CFAR-uppslag dokumenterat i katalog | Klass A | 01 |
| NL-P1-05 | P1 | Resources: små tabeller (Företagsstatus, Arbetsställestatus, AnstSME, län) + URL till variabelbeskrivning | F10 för det stabila | 03 |
| NL-P1-06 | P1 | Katalogfält: “säte vs belägenhet”, vilken status som hör till objekttypen | README-fällan | 01, 04 |
| NL-P1-07 | P1 | SNI: sök + valfri `branchLevel`; dokumentera max fem koder och JE-aggregering | “byggföretag” | 01 |
| NL-P2-01 | P2 | Granskad synonymfil (lännamn, vanliga juridiska former, AnstSME-intervall) — data, inte modell | Höjer P0-02 för svenska smeknamn | — |
| NL-P2-02 | P2 | Valfritt BM25/embedding-index över kodtexter, träffar som koder | Luddig SNI utan (b) | — |
| NL-P2-03 | P2 | Count-hjälp “samma filter, ett värde i taget” *endast när agenten skickar värdelistan* (kvotmedveten) | Klass D | 04, 02 |
| NL-P2-04 | P2 | Eval-svit: NL-frågor → förväntad objekttyp + kategorinamn + att koder kommer från lookup | Mäter lagret, inte GPT-minne | parent |
| NL-P2-05 | P2 | I prompt: 2026-API (paginering kommer, sammanslagna layouter försvinner) så agenter inte bygger mot döda layouter | Hållbarhet | 02 |
| NL-X-01 | Inte nu | Generativ `scb_ask` / LLM i servern | Se §4 | — |
| NL-X-02 | Inte nu | Paginering, historik, andra register, strippa Reklam | §7 | 02 |

**Första implementationssnitt (rekommendation till parent):** NL-P0-01, NL-P0-02, NL-P0-03, NL-P0-04, NL-P1-01. Det är skillnaden mellan “agenten måste kunna SCB” och “agenten kan fråga SCBmcp som en katalog”. NL-P0-05 kan släppas samtidigt som docs. Resten är förstärkning av täckning (listor, identitet, SNI-hierarki), inte en ny produktidé.

---

## 10. Källor för denna analys

- Repo: `README.md` (svensk main), `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/scb/{client,payload,schemas,endpoints,types}.ts`, `src/domain/errors.ts`, tester och `scripts/mcp-smoke.ts` / `verify-live.ts`.
- SCB: [Avgiftsfria uppgifter i företagsregistret](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/avgiftsfria-uppgifter-i-foretagsregistret/), [Variabelbeskrivning API (SNI 2025, PDF)](https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/variabelbeskrivning-api-sni-2025.pdf), [Variabelbeskrivning (webb)](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/variabelbeskrivning/).
- Certifikat-gateda SCB help-URL:er är **inte** lästa i denna körning; operatorlistan i backlog förutsätter live-koll mot `/help/exampleJe` och `/help/exampleAe`.
