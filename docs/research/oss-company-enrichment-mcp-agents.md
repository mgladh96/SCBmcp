# Slice C — OSS MCP / AI-agent tooling for company contact enrichment

**Scope:** existing open-source or agent-ready tools that enrich a company (name or domain) with website, email, and/or phone — so SCBmcp might *wrap* them instead of building an enrichment engine.

**Out of scope:** changes to SCBmcp product or runtime. This note is research only.

**Date:** 2026-09-15. URLs, licenses, and star counts were checked against GitHub/PyPI/docs around this date. Several of the “MCP enrichment” repos are weeks–months old and have single-digit stars; treat maturity as a first-class filter.

---

## 1. How this sits next to SCBmcp

SCBmcp is a **data-access layer** for SCB Allmänna företagsregister. The README is explicit: it does not search other sources, enrich records, scrape websites, or run an LLM.

`scb_query` / `scb_search_companies` already return JSON with SCB field names. Default projection is identity, name, status, geography, SNI/bransch, size class, and **always** `Reklam`. Website, email, and phone are **not** in that contract.

The eval suite already treats those fields as out of AFR:

| Eval id | Question (short) | Why it fails today |
| --- | --- | --- |
| `q21` | Byggföretag med namn och **telefon** | Population ≫ 2000; phone is an add-on; Reklam must not be bypassed |
| `q26` | Mejla alla byggföretag i länet | Reklamspärr; server is not an outbound tool |
| `q30` | Webbplats och verkliga huvudmän | Enrichment outside AFR; MCP does not scrape |

**Plug-in shape we should assume** (JSON in → enriched JSON out), without touching SCBmcp:

```json
{
  "input": {
    "source": "SCB Allmänna företagsregister",
    "objectType": "company",
    "OrgNr": "5560160680",
    "Företagsnamn": "Telefonaktiebolaget LM Ericsson",
    "Säteskommun": "Stockholm",
    "Reklam": "Ja"
  },
  "enriched": {
    "website": "https://www.ericsson.com",
    "email": { "value": "info@ericsson.com", "kind": "generic", "confidence": 0.62 },
    "phone": { "value": "+46-10-7190000", "confidence": 0.4 },
    "domain": "ericsson.com"
  },
  "provenance": [
    { "field": "website", "tool": "tavily_search", "url": "…" },
    { "field": "email", "tool": "prospector.find_emails", "method": "website_scrape" }
  ],
  "skipped": {
    "reason": null,
    "reklam": true
  }
}
```

If `Reklam` is set (SCB advertising opt-out), any wrap **must** either refuse contact fields or pass the flag through and refuse marketing use. SCBmcp already never strips `Reklam`; an enrichment sibling must not become a bypass.

Join key: **10-digit `OrgNr`** (or 12-digit when present). Company name is a search hint, not a unique key.

---

## 2. Shortlist

Grouped by what they actually do. “Would wrap?” is about plugging **beside** SCBmcp, not merging into it.

### 2.1 Swedish registry / allabolag-adjacent (highest geographic fit)

| Candidate | URL | License | Maturity | Contacts (web / email / phone) | Would wrap? |
| --- | --- | --- | --- | --- | --- |
| **foretak/registry-mcp** | https://github.com/foretak/registry-mcp · https://pypi.org/project/registry-mcp/ · hosted `https://api.foretak.dev/mcp` | MIT (code). SE data: Bolagsverket/SCB HVD, publisher names no licence | Live v0.4.x, FastMCP + REST, official MCP registry `io.github.foretak/registry-mcp` | **No phone/website.** Lookup by organisationsnummer. HVD payload: name, legal form, SNI, postal city, derived status. `search_company` for SE is `not_implemented` (free BV API has no name index). `advertising_protected` exists for SE *reklamspärr* | **Yes — sibling registry MCP**, not a contact engine. Best OSS Bolagsverket MCP found |
| **GunnarPomiloAI/annual_report_mcp_server** (Pomilo-AI) | https://github.com/GunnarPomiloAI/annual_report_mcp_server | MIT | Demo-grade, 3 stars, author says not production | Org data + årsredovisningar via BV HVD; **Tavily** for name → orgnr. No dedicated contact tools | **Maybe as a pattern** (BV OAuth + Tavily name resolve). Do not adopt as-is |
| **Berit `bolagsverket-mcp`** | https://github.com/robinandreeklund-collab/Berit (path `mcp-tools/bolagsverket-mcp/`) | Check parent repo | Embedded TS client, not a standalone product | HVD REST: OAuth client-credentials, cache, 60 req/min. Org lookup, not contacts | **Copy the client pattern**, do not depend on the whole app |
| **PierreMesure/oppna-bolagsdata** | https://github.com/PierreMesure/oppna-bolagsdata · HF datasets | AGPL-3.0 (code) | Bulk-file helper, not MCP | Downloads BV/SCB HVD zips. Firmographics, not live contacts | **No for live enrichment**; useful only if we ever want an offline HVD mirror. AGPL is a product-license issue |
| **marple-newsrobot/allabolag** (`pip install allabolag`) | https://github.com/marple-newsrobot/allabolag · https://pypi.org/project/allabolag/ | MIT | Real OSS scraper, 21★, last site rewrite Oct 2024 (v0.9.0). Not MCP | `Company("559071-2807").data` dumps the public allabolag page. Contacts **if the page publishes them**; unofficial, ToS risk | **Prototype-only wrap** behind a legal review. Closest true OSS allabolag client |
| **logiover/allabolag-scraper** | https://github.com/logiover/allabolag-scraper · Apify actor | MIT on the **docs repo**; Actor source is **not** published | Hosted scraper, pay-per-result | Claims CEO, **phone (~57%)**, **email (~28%)**, **homePage**. Join by `orgNumber` | **Buy/wrap the Actor via Apify MCP**, not “OSS engine”. ToS + GDPR + Reklam |
| **solidcode/allabolag-scraper** | https://apify.com/solidcode/allabolag-scraper | Proprietary Actor | Hosted, similar field set | phone / email / homePage / contactPerson | Same as logiover: commercial scrape, not wrap-as-library |
| **Bolagsverket official APIs** | [HVD (free)](https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/vardefulladatamangder/apiforvardefulladatamangder.5513.html) · [Företagsinformation (deeper)](https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/apiforatthamtaforetagsinformation.3988.html) | Data: EU HVD / BV terms. No OSS client of comparable quality besides registry-mcp | Official REST + OAuth2 | **HVD:** name, orgnr, SNI, digital annual reports — **not** phone/website. **Paid/deeper API:** `ORGANISATIONSADRESSER` = **postal address and email**; still no phone/website in the published field list. Lookup **by orgnr only** (name search “kommer”) | **Wrap HVD via registry-mcp or a thin BV client.** Treat email as an optional BV-paid field, not a scrape |

**Swedish takeaway:** there is **no** production-quality OSS MCP that, given a Swedish company name or orgnr, returns website + email + phone from an official register. Official sources stop at identity / address / maybe email. Contact-rich Sweden data lives on **allabolag.se** (D&B-backed portal) and similar aggregators — scrapers exist, but they are unofficial.

---

### 2.2 MCP servers that already do “company → contacts”

These are the closest *product* matches. Most are thin, young, or front-ends for paid APIs.

| Candidate | URL | License | Maturity | I/O | Would wrap? |
| --- | --- | --- | --- | --- | --- |
| **JosieBot26/prospector-mcp-email-finder** | https://github.com/JosieBot26/prospector-mcp-email-finder | MIT | ~11★, `npx prospector-mcp`, Node, stdio + HTTP/SSE | **In:** `{ domain, contact_name? }`. **Out:** scraped + pattern emails, SMTP verify, confidence 0–100. Tools: `find_emails`, `verify_email`, `check_domain` | **Yes as email step** once a domain exists. Needs outbound SMTP (port 25). Quota/tier env vars; verify it stays fully self-hosted |
| **CodeSerg21/leadspark-mcp** | https://github.com/CodeSerg21/leadspark-mcp | MIT | 0★, `npx leadspark-mcp` | **In:** domain. **Out:** `research_company` (firmographics from site/SSL/DNS/GitHub/DDG), `find_contacts` (names, LinkedIn, *probable* emails), tech stack | **Maybe.** Right JSON shape, weak provenance. Optional Hunter key. Fine as a spike, not a dependency |
| **Harvey-Yuan/leadhub** | https://github.com/Harvey-Yuan/leadhub | MIT | 0★, FastMCP + CLI | **In:** ICP brief. **Out:** `leadhub_find_leads` (DuckDuckGo → qualify → theHarvester → contact-page fetch → MX → SQLite/JSON). **No LLM inside the tool** | **Yes as a harvest pipeline reference.** Discovery-oriented (find companies), not “enrich this OrgNr”. Reuse harvester/enrichment modules, not the campaign CLI |
| **axelfreeman/tapac-mcp** | https://github.com/axelfreeman/tapac-mcp | MIT (server). Runtime talks to **tapacapi.com** | 3★, `uvx` from git | **In:** industry, titles, size, location. **Out:** `tapac_find_contacts` (name, title, company, email, source, verification). Pay-per-use $0.10–0.50 | **No as self-hosted OSS.** MCP is a client. Self-host the kit below instead |
| **axelfreeman/b2b-contact-mining-kit** | https://github.com/axelfreeman/b2b-contact-mining-kit | MIT | Scripts + prompts, not MCP | Google / Telegram / Discord extract + SMTP verify → JSON/CSV | **Yes as scripts to steal from**, if we accept scrape + SMTP. Not Sweden-specific |
| **carsonlabs/leadenrich-mcp** (PyPI `leadenrich-mcp`) | https://github.com/carsonlabs/leadenrich-mcp · https://pypi.org/project/leadenrich-mcp/ | MIT | 2★, FastMCP HTTP `:8300/mcp` | **In:** email / domain / name+domain. **Out:** waterfall merge from **Apollo + Clearbit + Hunter** with per-field attribution. `enrich_company(domain)` | **Wrap only if we already pay those APIs.** The OSS is an MCP façade, not an engine |
| **Aleksey-Panf/b2b-enrichment-mcp** | https://github.com/Aleksey-Panf/b2b-enrichment-mcp | MIT | 3★ | Hunter domain/person email + Apollo `enrich_company` / person | Same: **paid-API façade**. Cleaner split (Hunter emails, Apollo firmographics) than LeadEnrich |
| **impecablemee/gtm-mcp** | https://github.com/impecablemee/gtm-mcp | MIT | Claude Code toolkit, 49 tools, 0 LLM calls in-server | Apollo search/enrich + Apify scrape + SmartLead. `/launch` outreach pipeline | **Do not wrap as enrichment.** Useful *skill* patterns (scrape then classify). Heavy Apollo/SmartLead lock-in |
| **itsjustanks/sales-agent** | https://github.com/itsjustanks/sales-agent | MIT | Full outbound agent (skills + Playwright LinkedIn) | Research dossier skill; not a company-JSON enricher | **No.** Wrong job (CRM/outbound). LinkedIn scrape is ToS-grey |
| **datalayer-sh/mcp** | https://github.com/datalayer-sh/mcp | Unclear from listing | 0★, commercial positioning (60M companies) | Hosted B2B graph | **No** — not OSS enrichment |
| **SyncGTM Enrichment MCP** | https://syncgtm.com/product/enrichment-mcp | Commercial | Hosted, 49–75 actions | Scrape emails/phones from site + paid providers | **Buy later**, not wrap |

---

### 2.3 Web browsing / scrape / extract primitives (mature, wrap these)

These do **not** return “the email for OrgNr X”. They are the engines a thin orchestrator would call after SCB.

| Candidate | URL | License | Role next to SCBmcp |
| --- | --- | --- | --- |
| **microsoft/playwright-mcp** (`@playwright/mcp`) | https://github.com/microsoft/playwright-mcp | Apache-2.0 | Local browser. Accessibility snapshot, click through cookie walls / JS contact pages. Best when the site is interactive. Heavy for bulk |
| **firecrawl/firecrawl-mcp-server** (`firecrawl-mcp`) | https://github.com/firecrawl/firecrawl-mcp-server | MIT (MCP). Core Firecrawl: **AGPL-3.0** if self-hosted | `scrape` / `search` / `map` / `extract` → markdown or **JSON schema**. Hosted + self-host. **Best structured extract of `{email, phone, website}` from a known URL** |
| **tavily-ai/tavily-mcp** | https://github.com/tavily-ai/tavily-mcp | MIT | `search`, `extract`, `map`, `crawl`. Hosted `https://mcp.tavily.com/mcp`. **Best “company name + kommun → official website” search** |
| **exa-labs/exa-mcp-server** | https://github.com/exa-labs/exa-mcp-server | MIT | Neural web search + fetch. Hosted `https://mcp.exa.ai/mcp`. Strong for research; paid at volume |
| **apify/apify-mcp-server** | https://github.com/apify/apify-mcp-server · https://mcp.apify.com | MIT (server) | Run any Store Actor, including contact extractors and allabolag scrapers, as MCP tools. **Fastest path to Sweden-specific contact fields** if we accept Actor ToS/cost |
| **brightdata/brightdata-mcp** | https://github.com/brightdata-com/brightdata-mcp | MIT | Search + scrape + browser via Bright Data network. Free tier exists. Commercial anti-bot |
| **Crawl4AI + MCP wrappers** | Engine: https://github.com/unclecode/crawl4ai (**Apache-2.0** + attribution). Wrappers: [sadiuysal/crawl4ai-mcp-server](https://github.com/sadiuysal/crawl4ai-mcp-server) MIT; `mcp-crawl4ai` on npm | Self-hosted Firecrawl-like scrape/crawl without AGPL core. Good if we want **no SaaS scrape key** |
| **schwarztim/sec-theharvester-mcp** | https://github.com/schwarztim/sec-theharvester-mcp | MIT | Wraps [laramies/theHarvester](https://github.com/laramies/theHarvester) (`theharvester_emails` given a **domain**). OSINT recon, not sales-grade. Many sources need extra API keys |
| **Apify Contact Info Extractor** | https://apify.com/optimus-fulcria/contact-info-extractor/api/mcp | Actor (pay per use) | URL → emails, phones, socials, contact-page follow. Usable through Apify MCP |

**LangChain / LlamaIndex (not MCP, still wrap-able):**

| Candidate | URL | License | Notes |
| --- | --- | --- | --- |
| **langchain-ai/company-researcher** | https://github.com/langchain-ai/company-researcher | (no LICENSE file in tree; treat as LangGraph example) | **In:** `{ company, extraction_schema, user_notes }`. **Out:** JSON matching the schema via Tavily + LLM extract + reflection. Closest “JSON schema in / JSON out” research agent. Needs LLM + Tavily keys. Not Sweden-aware |
| **Personal-AI-LangGraph/ai-company-researcher** | https://github.com/Personal-AI-LangGraph/ai-company-researcher | Check repo | LangGraph + Firecrawl: **URL in**, structured company report out, web-search fallback |
| **guy-hartstein/company-research-agent** | https://github.com/guy-hartstein/company-research-agent | MIT | Multi-agent diligence reports (Tavily). Overkill; narrative not contact-JSON |
| **llama-index-tools-mcp** | https://github.com/run-llama/llama_index/tree/main/llama-index-integrations/tools/llama-index-tools-mcp | MIT (typical for LlamaIndex integrations) | Consume **any** MCP (including SCBmcp + Firecrawl) from a LlamaIndex agent. Glue, not enrichment |
| **Composio Hunter toolkit** | https://composio.dev/toolkits/hunter/framework/llama-index | Commercial glue | Hunter MCP → LangChain/LlamaIndex. Same as wrapping Hunter yourself |

---

## 3. Build vs buy vs wrap

### Recommendation: **wrap primitives + a thin orchestrator; do not greenfield an enrichment engine; do not fold it into SCBmcp**

| Option | Verdict | Why |
| --- | --- | --- |
| **Greenfield scraper inside SCBmcp** | **No** | Violates the AFR-only contract, mixes mTLS SCB quota with scrape/SMTP, and the eval suite already encodes “webbplats/telefon = out of scope”. One process that holds an SCB client cert should not also hammer the public web |
| **Adopt a young “sales enrichment MCP” as the product** | **No** | LeadSpark / LeadHub / Prospector / TAPAC / LeadEnrich are MIT but small, often SaaS-backed, and none speak organisationsnummer or `Reklam` |
| **Buy Apollo/Hunter/Clearbit/SyncGTM and MCP-wrap** | **Optional paid waterfall**, not the Sweden path | Coverage is US/global people graphs. Swedish SMEs (the AFR population) are sparse. Cost scales with list size. OSS façades already exist (LeadEnrich, b2b-enrichment-mcp, gtm-mcp) |
| **Buy Apify allabolag Actor** | **Best contact coverage for SE**, highest legal/ToS risk | Unique join on orgnr; published coverage ~57% phone / ~28% email. Not OSS. Must honor Reklam + GDPR (CEO names, personal emails) |
| **Wrap official BV HVD via registry-mcp** | **Yes, cheap, legal** | Complements SCB (annual reports, legal form, postal). Does **not** solve website/phone. Email only if we later add the deeper BV API (`ORGANISATIONSADRESSER`) |
| **Wrap search+scrape MCPs (Tavily/Exa/Firecrawl/Playwright/Crawl4AI)** | **Yes — this is the engine** | Mature licenses (MIT / Apache-2.0). JSON-schema extract is already built. We only supply the Sweden-specific query and merge layer |
| **Thin sibling MCP `enrich_company` we own** | **Yes — the only greenfield** | ~one tool: SCB-shaped JSON in, provenance-tagged contacts out, Reklam gate, orgnr join. Calls wrapped OSS/SaaS underneath |

**Build vs wrap in one line:** wrap **registry-mcp + a scrape MCP (Firecrawl or Crawl4AI) + a search MCP (Tavily or Exa)**; optionally add **Prospector** for SMTP; optionally add **Apify allabolag** after legal review. Build only the **orchestrator and schema**.

---

## 4. Suggested architecture if we wrap OSS

Keep SCBmcp unchanged. Add a **sibling** process (or an agent that already composes two MCP servers).

```
AI agent
  ├─ SCBmcp (existing)          AFR: filter → companies JSON + Reklam
  └─ scb-enrich-mcp (new, thin)
        │  tool: enrich_companies({ records[], fields[] })
        │
        ├─ 0. Gate: if Reklam indicates opt-out → skip contact fields
        ├─ 1. registry-mcp lookup_company(id=OrgNr, country=SE)
        │       optional: Bolagsverket Företagsinformation email
        ├─ 2. Resolve website
        │       Tavily/Exa/Firecrawl search:
        │       "{Företagsnamn} {Säteskommun} officiell webbplats"
        ├─ 3. Extract contacts from site
        │       Firecrawl extract | Crawl4AI | Playwright-MCP
        │       schema: { emails[], phones[], website }
        ├─ 4. Optional verify
        │       Prospector verify_email / check_domain
        └─ 5. Merge → original SCB JSON + enriched + provenance
```

### 4.1 JSON contract (orchestrator)

**Input** (batch of SCB rows, already projected):

```json
{
  "records": [
    {
      "OrgNr": "5560160680",
      "Företagsnamn": "Telefonaktiebolaget LM Ericsson",
      "Säteskommun": "Stockholm",
      "Reklam": "Ja"
    }
  ],
  "want": ["website", "email", "phone"],
  "maxRecords": 25
}
```

**Output:**

```json
{
  "results": [
    {
      "OrgNr": "5560160680",
      "scb": { "Företagsnamn": "…", "Reklam": "Ja" },
      "website": "https://www.ericsson.com",
      "emails": [{ "value": "webmaster@ericsson.com", "kind": "generic", "source": "website", "verified": false }],
      "phones": [{ "value": "+46-10-7190000", "source": "website" }],
      "registry": { "legal_form": "Aktiebolag", "source": "bolagsverket" },
      "confidence": 0.7,
      "skippedContacts": false,
      "errors": []
    }
  ]
}
```

Same envelope SCBmcp already uses (`content[].text` + `structuredContent`) so a Cursor/Claude client can chain `scb_query` → `enrich_companies` in two MCP calls.

### 4.2 Why a sibling MCP rather than “just the agent”

An unconstrained agent with Playwright + search will work for 3 companies and fail on 75 (SCB default `maxRows`): no Reklam policy, no cache, no rate limit, no stable schema. The orchestrator is the policy + merge layer; the OSS MCPs stay replaceable.

### 4.3 Implementation sketch (not in this PR)

1. New repo or `packages/scb-enrich-mcp` — **do not** add scrape deps to `scb-foretagsregister-mcp`.
2. First milestone: **website only** (search by name+kommun). Highest precision, lowest legal surface.
3. Second: JSON-schema extract of emails/phones from `/kontakt`, `/contact`, footer, `mailto:`.
4. Third: SMTP verify via Prospector **if** port 25 is available.
5. Parallel experiment (legal-gated): Apify `logiover/allabolag-scraper` keyed by `orgNumber`, compare fill-rate vs website scrape on a 50-row SCB sample.
6. Cache by OrgNr (hours–days). Honor robots.txt / crawl-delay. Cap concurrency. Never use contact fields when Reklam forbids marketing.

### 4.4 What we would still have to write ourselves

Even in a wrap-first world, nobody else ships:

- OrgNr-centric join with SCB field names (`OrgNr (10 siffror)`, `Företagsnamn`, `Reklam`)
- Reklamspärr as a hard gate
- Swedish query templates (`officiell webbplats`, kommun disambiguation, AB vs handelsbolag)
- Refusal to invent contacts (SCBmcp’s “never invent SNI” analogue)
- Batch + cache sized to AFR’s 75 / 2 000 row world

That is a **thin orchestrator**, not an enrichment engine.

---

## 5. Candidate scorecard (for a Sweden AFR list)

Assume input is an SCB company row (orgnr + name + kommun), desired outputs are website / email / phone.

| Need | Best wrap | Gap |
| --- | --- | --- |
| Legal identity / SNI / postal | **registry-mcp** (BV HVD) | No contacts; SE name search unimplemented |
| Registered email | Bolagsverket Företagsinformation `ORGANISATIONSADRESSER` | Paid/deeper API, OAuth, orgnr-only. No OSS MCP wraps this field set yet (registry-mcp uses HVD) |
| Website | **Tavily or Exa search** + confirm | Disambiguation (common names). Not in any Swedish register |
| Email/phone on the company site | **Firecrawl extract** or **Crawl4AI** (+ Playwright if JS) | Many Swedish SMEs have no site or only a Facebook page |
| Email verify | **Prospector** or Hunter verify | SMTP blocked on many hosts |
| Highest SE contact fill-rate | **Apify allabolag Actor** | Not OSS; ToS; personal data; Reklam |
| People at company (VD, board) | BV Funktionärer (deeper API) or allabolag `ceoName` | Personal data; not needed for “company phone/email” |
| Global people graph | Apollo/Hunter via LeadEnrich / b2b-enrichment-mcp | Weak on Swedish SMEs |

---

## 6. Risks and non-goals

- **Reklamspärr / GDPR:** SCB `Reklam` and BV `advertising_protected` must travel with any email/phone. CEO names and personal inboxes are personal data.
- **ToS:** allabolag.se scrapers and LinkedIn Playwright agents are legally grey even when MIT-licensed.
- **AGPL:** self-hosting Firecrawl core or oppna-bolagsdata can infect a proprietary product; prefer Firecrawl *cloud* or Crawl4AI (Apache-2.0).
- **SMTP:** Prospector/TAPAC-style verify needs egress on port 25; many clouds block it.
- **Maturity:** do not pin production on 0–3★ MCP servers. Copy algorithms; vendor the scrape/search layer from Microsoft / Firecrawl / Tavily / Exa / Apify.
- **SCBmcp quota:** enrichment retries must not amplify SCB `hamta` calls. Enrichment reads **already fetched** JSON.

---

## 7. Sources checked

- SCBmcp README + `src/scb/projection.ts` default tokens; `tests/eval/fixtures.json` q21/q26/q30
- GitHub/PyPI/docs for every URL in §2 (2026-09-15)
- Bolagsverket HVD and Företagsinformation field lists (`ORGANISATIONSADRESSER` = postal + email)
- Apify allabolag Actor coverage claims (phone ~57%, email ~28%) — vendor-reported, not independently measured here

**Bottom line:** wrap, don’t build the crawler. There is **no** drop-in OSS “Swedish company → website/email/phone” MCP. There **is** a drop-in OSS Bolagsverket MCP (registry-mcp) and several mature scrape/search MCPs. The missing piece is a small orchestrator that speaks SCB JSON and Reklam — outside this repo’s runtime.
