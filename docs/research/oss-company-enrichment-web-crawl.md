# OSS company enrichment — web crawl and contact extraction

**Slice B.** Research only. No product or runtime code.

Given a company **name**, **org number**, and/or **website URL**, this note surveys existing open-source projects that:

1. find a homepage,
2. crawl a small set of contact/about pages,
3. extract **emails**, **phones**, and **about text** from HTML (`mailto:`, `tel:`, JSON-LD / schema.org, main-content extractors).

Checked against GitHub on **2026-09-15**. Star counts and last-push dates move; treat them as activity signals, not a ranking.

SCBmcp today is a TypeScript MCP server over SCB’s Allmänna företagsregister. It does not crawl the web. Any enrichment worker would be a **separate** process (Python sidecar or Node crawler), not a change to the SCB client.

---

## Bottom line

There is **no mature, Swedish-first OSS product** that does name/org-number → website → bounded contact crawl → emails/phones/about in one box.

What exists is a **compose-able stack**:

| Layer | Best OSS fit | Role |
| --- | --- | --- |
| Homepage finding | Weak. Wikidata P856 + search; no Clearbit-class OSS | Input often already a URL from the operator |
| Bounded crawl | Crawl4AI or Crawlee (Playwright fallback) | Homepage + `/kontakt` + `/om-oss`, 5–20 pages |
| Contact fields | Purpose-built extractors (Omkar / ORGA / extract-emails) or a thin custom parser | `mailto:`, `tel:`, JSON-LD, obfuscation |
| About text | Trafilatura | Main content, not nav/footer noise |
| Structured blocks | extruct | schema.org `Organization` / `ContactPoint` |
| Swedish directories | **Do not scrape** Allabolag, Merinfo, Ratsit, Hitta, Eniro | ToS + database rights; licensed APIs exist |

**Recommendation:** do not vendor a lead-gen scraper. Build a **one-company queue worker** on Crawl4AI *or* Crawlee, with Trafilatura + extruct + libphonenumber, URL priors for Swedish contact pages, and robots.txt on by default. Borrow MIT extraction ideas from Omkar / ORGA; do not take their anti-bot or directory-scrape posture as a product default.

---

## Shortlist

Twelve projects. The first eight are the ones to actually evaluate. The last four are supporting libraries or “know about, do not depend on.”

### 1. [omkarcloud/website-email-contact-scraper](https://github.com/omkarcloud/website-email-contact-scraper)

| | |
| --- | --- |
| **License** | MIT |
| **Stack** | Python 3, [Botasaurus](https://github.com/omkarcloud/botasaurus) (HTTP then Chrome), libphonenumber, JSON-LD |
| **Activity** | Created 2026-08; last push 2026-09-09; ~7 stars. Young, but the extraction design is the closest match to this slice. |
| **What it does** | Domain in → JSON out: emails, phones (E.164), 17 social networks, tech stack, homepage title/description. Modes: `homepage` / `key_pages` (≤7) / `deep` (≤20 pages, depth 2). Prioritises `/contact`, `/impressum`, `/about`. Extracts `mailto:`, Cloudflare-obfuscated emails, `[at]`/`[dot]` forms. Ranks `is_likely_official`. HTTP first, Chrome if JS/bot wall. |
| **Queue fit** | **High.** One domain per call, bounded crawl, stable schema, dead sites return `error` instead of crashing the batch. `scrape_contacts([...])` is already queue-shaped. |
| **Gaps** | Lead-gen product (hosted API + Apify). URL priors are EN/DE (`/contact`, `/impressum`), not Swedish `/kontakt`, `/om-oss`, `/kontakta-oss`. About *text* is only title + meta description, not a Trafilatura-style body. Chrome escalation is anti-bot-oriented; robots.txt is not a first-class documented control. Tiny community / bus factor. |

### 2. [discretewater/orga](https://github.com/discretewater/orga)

| | |
| --- | --- |
| **License** | MIT (PyPI: `orga`) |
| **Stack** | Python, httpx, selectolax, extruct, phonenumbers, email-validator, FastAPI. **No LLM, no browser.** |
| **Activity** | Created 2026-03; last push 2026-03-22; 1 star. Author calls M7.1 a frozen baseline. |
| **What it does** | Root URL → scored crawl of `/contact`, `/locations`, `/about` (about five subpages, ~0.6s/site in their benchmark) → structured org profile: phones, emails, socials, addresses, category. Deterministic; debug traces of selectors/rules. Single-URL HTTP API (`POST /extract`) plus async job manager. |
| **Queue fit** | **High architecturally** (one URL in, JSON out, no browser). **Low operationally** (unmaintained, 1 star, institutional/hospital taxonomy, no JS rendering). |
| **Gaps** | SPA/JS sites will be empty. Swedish SME WordPress/Webflow sites are a better fit than WHO/CHEO, but the classifier is not built for Swedish AB/HB. Treat as a **design reference**, not a dependency. |

### 3. [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai)

| | |
| --- | --- |
| **License** | Apache-2.0 |
| **Stack** | Python, Playwright, deep crawl, markdown, `RegexExtractionStrategy` (Email, PhoneIntl, PhoneUS), CSS/XPath JSON strategies, optional LLM extract |
| **Activity** | ~83.5k stars; last push 2026-09-14. Very active. |
| **What it does** | LLM-friendly crawler: render JS, clean HTML → markdown, sitemap/deep crawl, structured extraction **without** an LLM for emails/phones. `check_robots_txt` is a first-class flag (default **off**; cache TTL 7 days; 403 when disallowed). Hosted “enrich” API exists separately (`crawl4ai-cloud-sdk`); this note is about the OSS library. |
| **Queue fit** | **High as the crawl engine.** One URL (or a tiny URL list) per job, Playwright only when needed, regex extract for contacts, markdown dump for about-text / later LLM. You still write the “prefer /kontakt” policy and the SE phone normalisation. |
| **Gaps** | Not a company-enrichment product. Phone regex is intl/US, not libphonenumber-SE. Default robots off. Cloud enrich is a paid API, not the OSS core. |

### 4. [adbar/trafilatura](https://github.com/adbar/trafilatura)

| | |
| --- | --- |
| **License** | Apache-2.0 |
| **Stack** | Python / CLI; sitemaps, feeds, download, main-text + metadata; CSV/JSON/MD/XML |
| **Activity** | ~6.8k stars; last push 2026-09-11. Long-lived, widely used (Hugging Face, Internet Archive, etc.). |
| **What it does** | Best-in-class **about text**: strip chrome, keep the article/company story, plus title, sitename, description, author, date. Can crawl via sitemaps. Benchmarked as a top HTML main-content extractor. |
| **Queue fit** | **High for the about-text step**, once you already have HTML or a URL. Poor as a contact crawler (no `mailto:`/`tel:` pipeline). |
| **Gaps** | No JS rendering. Contact pages that are widget-only yield little. Pair with a renderer + a contact parser. |

### 5. [dmitriiweb/extract-emails](https://github.com/dmitriiweb/extract-emails)

| | |
| --- | --- |
| **License** | MIT |
| **Stack** | Python ≥3.10; httpx and/or Playwright (`extract_emails[httpx]` / `[playwright]`); CLI |
| **Activity** | ~110 stars; last push 2026-01-02. Oldest purpose-built library in this list (since 2017). |
| **What it does** | Crawl a start URL, collect emails and LinkedIn URLs, write CSV. `DefaultWorker` + `HttpxBrowser` or `ChromiumBrowser`. |
| **Queue fit** | **Medium.** One URL per worker is natural. No phones, no about text, no JSON-LD, no official-contact ranking. Useful as a fallback email pass or as a small library to wrap. |
| **Gaps** | Email-only. Crawl policy is generic, not contact-page-first. |

### 6. [apify/crawlee](https://github.com/apify/crawlee) and [apify/crawlee-python](https://github.com/apify/crawlee-python)

| | |
| --- | --- |
| **License** | Apache-2.0 |
| **Stack** | **TS:** Cheerio / JSDOM / Playwright / Puppeteer. **Python:** BeautifulSoup / Parsel / Playwright. Retries, session pool, proxy rotation, autoscaled pool. |
| **Activity** | TS ~25.8k stars, Python ~9.5k; both pushed 2026-09-15. |
| **What it does** | Production crawler *framework*. You write the request queue and extractors. Native robots handling, per-domain concurrency, HTTP vs browser routing. |
| **Queue fit** | **High if the worker stays in Node** (SCBmcp is TypeScript). One company = one `RequestQueue` with maxRequestsPerCrawl ≈ 10 and a link filter on `kontakt|om-oss|contact|about`. Extraction is still custom. |
| **Gaps** | No contact schema. Anti-bot is “bring proxies / Playwright,” not magic. Python port is younger than the TS core. |

### 7. [scrapy/scrapy](https://github.com/scrapy/scrapy) + [scrapy-plugins/scrapy-playwright](https://github.com/scrapy-plugins/scrapy-playwright)

| | |
| --- | --- |
| **License** | BSD-3-Clause (both) |
| **Stack** | Python, Twisted (Scrapy) + Playwright for JS. Protego for robots.txt. |
| **Activity** | Scrapy ~64.4k stars, last push 2026-09-15. scrapy-playwright ~1.4k, last push 2026-09-07. |
| **What it does** | The classic structured-extraction crawler. `ROBOTSTXT_OBEY`, download delays, item pipelines, auto-throttle. Playwright downloader for JS pages. |
| **Queue fit** | **Medium.** Excellent at 10k-site batch jobs. Heavy for “enrich this one org number now.” A Scrapy spider *can* run per company, but Crawlee/Crawl4AI are a better shape for a job queue. |
| **Gaps** | You still write the contact spider. Scrapy’s default `ROBOTSTXT_OBEY` has historically been `False` — must be turned on explicitly. |

### 8. [scrapinghub/extruct](https://github.com/scrapinghub/extruct)

| | |
| --- | --- |
| **License** | BSD-3-Clause |
| **Stack** | Python; JSON-LD, Microdata, Open Graph, Microformats, RDFa, Dublin Core |
| **Activity** | ~972 stars; last push 2026-04-01. Slower cadence, still the standard library for this job. |
| **What it does** | Parse embedded metadata. Company sites often publish `schema.org/Organization` with `email`, `telephone`, `contactPoint`, `address`, `sameAs`. Highest-precision contact source when present — no regex false positives. |
| **Queue fit** | **High as a parser**, zero as a crawler. Run on every fetched HTML blob. |
| **Gaps** | Many Swedish SME sites have no JSON-LD. Coverage is “free when present,” not a complete extractor. |

### 9. [firecrawl/firecrawl](https://github.com/firecrawl/firecrawl)

| | |
| --- | --- |
| **License** | **AGPL-3.0** (SDKs/UI bits MIT). Cloud anti-bot features are **not** in the OSS tree. |
| **Stack** | TypeScript service: scrape, crawl, map, search, LLM extract. Playwright + workers + Redis/Postgres if self-hosted. |
| **Activity** | ~181k stars; last push 2026-09-15. |
| **What it does** | One-shot “map this site / crawl / extract JSON.” Closest hosted UX to “give me contacts from this URL.” |
| **Queue fit** | **High UX, poor license/ops fit** for embedding in a proprietary MCP product. AGPL on a network service generally means you must offer corresponding source if you ship a modified self-hosted Firecrawl. Using the **cloud API** avoids that, at the cost of a vendor and of sending company URLs off-box. |
| **Gaps** | Self-host is a platform, not a library. OSS build is weaker on anti-bot than the cloud. Overkill for 10 HTML pages. |

### 10. [D4Vinci/Scrapling](https://github.com/D4Vinci/Scrapling)

| | |
| --- | --- |
| **License** | BSD-3-Clause |
| **Stack** | Python, Playwright, stealth/adaptive fetch, MCP server |
| **Activity** | ~81k stars; last push 2026-09-14. |
| **What it does** | Fetch layer that aims to look like a real browser. Not a contact enricher. |
| **Queue fit** | **Low as a product**, **medium as a fetch backend** if Crawl4AI/Crawlee HTTP keeps getting blocked. Stealth/anti-detect tools have a ToS and ethics cost (see Gaps). |
| **Gaps** | Using stealth to ignore robots.txt or bypass bot walls is a product decision, not a default. Do not treat star count as permission. |

### 11. [omkarcloud/botasaurus](https://github.com/omkarcloud/botasaurus)

| | |
| --- | --- |
| **License** | MIT |
| **Stack** | Python anti-detect browser framework (Cloudflare-oriented). Underpins project 1. |
| **Activity** | ~5.7k stars; last push 2026-07-26. |
| **What it does** | “Undefeatable scrapers” — the opposite of a polite, robots-first crawler. Useful only as the implementation detail of Omkar’s contact scraper, or if a later spike measures how many Swedish company sites are Cloudflare-gated. |
| **Queue fit** | Not the queue. A fetch strategy. |
| **Gaps** | Marketing is lead-gen/anti-bot. Pairing this with Allabolag-style targets would compound legal risk. |

### 12. [Nuclear-Marmalade/dataforge](https://github.com/Nuclear-Marmalade/dataforge)

| | |
| --- | --- |
| **License** | MIT |
| **Stack** | Python, Postgres, HTTP scraper, optional Ollama. MCP tools including `forge_enrich_record`. |
| **Activity** | ~52 stars; last push 2026-04-07. US-centric (FCC, NPI, SAM.gov, ZIP discover). |
| **What it does** | Apollo/Clearbit-shaped enrichment engine. Six-layer email extract (mailto, regex, Cloudflare decode, JSON-LD, obfuscation, contact-page crawl). SMTP RCPT verification. Tech stack. Local LLM summaries. |
| **Queue fit** | `forge_enrich_record` is literally one-record enrichment — **conceptually perfect**, geographically wrong. Government importers are US-only. SMTP probing is aggressive and can look like mailbox harvesting. |
| **Gaps** | Young, US data, SMTP verify is a policy no for most EU B2B products. Architecture (COALESCE writes, checkpoints, one record) is worth copying; the importers are not. |

---

## Website discovery (name / org number → URL)

This is the weakest OSS layer. Clearbit’s free Name-to-Domain API was shut down on 2025-04-30. Paid replacements (CUFinder, Datablist, Hunter) are APIs, not open engines.

Practical OSS / open-data options, in order of cleanliness:

1. **Already have the URL** — common if a human or CRM supplies it. Best case for a queue worker.
2. **Wikidata P856** (official website) via SPARQL — CC0 data, good for known brands, sparse for Swedish SMEs. Reverse lookup (domain → item) is also possible.
3. **Search** — DuckDuckGo-style clients (`ddgs` and similar) or a self-hosted SearXNG: query `"Bolagsnamn" orgnummer site:.se`. ToS of the search engine still apply; this is discovery, not scraping a directory.
4. **Guess + probe** — slugify the name to `name.se` / `name.nu` / `name.com`, HEAD/GET, compare title to the SCB name. High false-positive rate (parking pages, namesakes).
5. **Certificate Transparency / Common Crawl** — domain existence, not “this org number owns this site.”

**Do not** use unofficial Allabolag/Merinfo scrapers as a website finder. Those sites are commercial databases with an explicit “no copy, no commercial reuse” rule and a paid API. See the Swedish section.

SCB AFR (what SCBmcp already speaks) is the right source for **name + org number + industry + location**. It is not a website directory. Enrichment should treat SCB as the identity key and the company *homepage* as a separate, optional input.

---

## Fit for a “one company at a time” queue

Target shape:

```
job: { orgNumber, name, website? }
  → resolve homepage (skip if website present)
  → fetch homepage (HTTP; Playwright if empty shell)
  → score same-domain links (kontakt / om-oss / contact / about)
  → fetch ≤ N pages (N ≈ 5–10), honour robots.txt + crawl-delay
  → extract contacts + about
  → write { emails[], phones[], aboutText, sources[], errors[] }
```

| Project | One-job API | Bounded pages | Contact extract | About text | Robots | JS | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Omkar contact scraper | Yes | Yes (7 / 20) | Strong | Weak (meta only) | Unclear | Yes (Chrome escalate) | Best *product* to read; wrap carefully |
| ORGA | Yes (`/extract`) | Yes (~5) | Strong (rules) | Partial | Rate-limit only | No | Best *design*; too dead to depend on |
| Crawl4AI | Yes (`arun`) | Yes (deep crawl config) | Regex, not ranked | Markdown | Opt-in | Yes | Best **engine** (Python) |
| Crawlee TS | Yes (queue + max requests) | Yes | DIY | DIY | Built-in | Yes | Best **engine** if staying in Node |
| Trafilatura | Per URL | Sitemap crawl (broad) | No | **Best** | Downloader-dependent | No | About-text step only |
| extract-emails | Yes | Crawl, not contact-first | Emails only | No | DIY | Optional | Email fallback |
| Scrapy | Spider run | Yes | DIY | DIY | Opt-in | Via plugin | Batch, not interactive jobs |
| Firecrawl | Yes | Yes | LLM/schema | Markdown | Product-dependent | Yes | License/ops tax |
| Dataforge | `forge_enrich_record` | Contact-page layer | Emails (6 layers) | LLM summary | Unclear | Limited | Wrong geography |

For a queue, **prefer libraries you call once per job** over frameworks that want a long-running spider process. Crawl4AI `arun` and Crawlee with `maxRequestsPerCrawl` both fit. Omkar’s `scrape_contacts([url])` also fits, at the cost of pulling Botasaurus and a lead-gen default policy.

---

## Gaps (JS-heavy sites, anti-bot, robots.txt)

### JavaScript-heavy sites

Swedish SME sites are mixed: a lot of ordinary WordPress/Webflow (HTTP is enough), plus a growing tail of Next.js / custom React shells where the contact block is client-rendered or lives in a HubSpot/Formstack iframe.

- HTTP-only tools (ORGA, Trafilatura, Scrapy without Playwright, extract-emails httpx) **miss** those.
- Crawl4AI, Crawlee Playwright, scrapy-playwright, Omkar Chrome-escalate, Firecrawl **cover** the shell.
- **Iframes and contact widgets** (HubSpot, Recaptcha forms, “click to reveal email”) still lose. No OSS tool reliably extracts an email that only exists behind a form. Treat that as an expected empty, not a bug.
- **PDFs / image-only contact pages** need a separate path (not in this shortlist).

### Anti-bot

Cloudflare / “Just a moment…”, PerimeterX, and similar walls are common on *directories* and on some agency-built company sites. They are less common on small Swedish company homepages.

OSS options that advertise bypass (Botasaurus, Scrapling stealth, Firecrawl cloud) are **not** a free pass:

- Site ToS often forbid automated access and circumvention.
- Stealth browsers are a moving arms race; they will fail on a fraction of sites regardless.
- For a first-party enrichment queue, the honest policy is: **HTTP → Playwright (real UA, slow) → mark `blocked` and stop**. Do not default to Cloudflare bypass. Measure the block rate on a sample of SCB companies before adding stealth.

### robots.txt

| Tool | Default | Notes |
| --- | --- | --- |
| Crawl4AI | **Off** (`check_robots_txt=False`) | Must enable. Caches robots 7 days; 403 if disallowed. |
| Scrapy | **Off** historically (`ROBOTSTXT_OBEY`) | Must enable. Uses Protego. |
| Crawlee | On / respected in the robots plugin | Confirm per crawler class. |
| Trafilatura | Downloader-level | Not a site-wide crawler policy. |
| Omkar / Botasaurus / Scrapling stealth | Bypass-oriented | Assume robots is **not** the product goal. |
| ORGA | httpx + concurrency limiter | No robots discussion in the README. |

A company-enrichment worker should:

- send a **contactable User-Agent** (product name + URL or email),
- honour `robots.txt` and `Crawl-delay`,
- cap per-domain concurrency at 1 and pages at a small N,
- skip `Disallow` paths rather than “trying Playwright.”

`robots.txt` is not a law by itself, but ignoring it while also ignoring ToS is how directory-scraper projects get into trouble. For **the company’s own public website**, a polite bounded crawl of contact/about pages is the usual B2B enrichment pattern — still subject to that site’s ToS and to GDPR (below).

---

## Swedish-specific notes (Allabolag and friends)

### Commercial directories — do not scrape

These are **not** company websites. They are aggregators with copyright, database-right, and contract claims. OSS scrapers exist; that does not make them usable in a product.

**allabolag.se** (UC Affärsinformation AB / Enento):

- Rights page: [allabolag.se/info/rattigheter](https://www.allabolag.se/info/rattigheter/) — content, layout, and *collection* of information are protected; copying, distributing, making available, or **any commercial use** without express permission can lead to criminal and damages liability (Swedish original).
- They sell **APIs** for “quality-assured customer/supplier data in your own systems.” That is the legal path.
- OSS:
  - [marple-newsrobot/allabolag](https://github.com/marple-newsrobot/allabolag) — MIT Python package (`pip install allabolag`), last **code** push 2024-10-14, ~21 stars. README states it has **no formal relationship** with the site. Journalistic Newsworthy tool, not a license from UC.
  - [logiover/allabolag-scraper](https://github.com/logiover/allabolag-scraper) — MIT **docs only**; the actor runs on Apify. Same ToS problem, plus a third-party hosted scraper.
  - [VinayashreePatanakar/allabolag_scraper](https://github.com/VinayashreePatanakar/allabolag_scraper) — 0 stars, 2026-01, no license in GitHub metadata.

**merinfo.se:**

- Terms: [merinfo.se/villkor](https://merinfo.se/villkor) — **without written consent it is forbidden to copy content on Merinfo, regardless of technique.**
- They sell API and file delivery: [merinfo.se/data-via-api-eller-fil](https://www.merinfo.se/data-via-api-eller-fil).
- OSS: [alshfu/merinfo_scraper](https://github.com/alshfu/merinfo_scraper) — Selenium scraper of merinfo.se **and** allabolag.se; 0 stars. Same prohibition.

**Ratsit, Hitta, Eniro, 121.nu, Proff** — same class of product (licensed data + advertising). No need to list every GitHub toy scraper. If the data is valuable, **buy the feed**.

Database protection (Upphovsrättslagen 49 §, EU Database Directive) sits on top of copyright for substantial extraction of a database. “The org number is public at Bolagsverket/SCB” is not a defence for scraping UC’s compiled pages.

### What *is* Swedish-friendly on the company website

A crawler aimed at Swedish company sites should add URL and language priors that the EN/DE tools miss:

| EN/DE prior (Omkar / ORGA) | Swedish equivalent |
| --- | --- |
| `/contact`, `/contact-us` | `/kontakt`, `/kontakta-oss`, `/kontakt-oss`, `/hitta-oss` |
| `/about`, `/about-us` | `/om-oss`, `/omoss`, `/om-foretaget`, `/vilka-vi-ar` |
| `/impressum` (DE legal) | `/integritet`, `/gdpr`, `/personuppgifter` (often emails; noisy) |
| `/team` | `/medarbetare`, `/personal`, `/ledningen` |

Phone normalisation: Google [libphonenumber](https://github.com/google/libphonenumber) / PyPI `phonenumbers`, default region **`SE`**. Accept `08-…`, `070-…`, `+46 …`, and `tel:` hrefs. Crawl4AI’s `PhoneUS` pattern is the wrong default.

About text: Swedish “Om oss” pages are Trafilatura’s sweet spot. Keep `sv` language hint if the extractor supports it.

Homepage finding for Swedish SMEs: Wikidata is thin; Allabolag is the *convenient* answer and the *wrong* one. Prefer operator-supplied URL, then search, then domain guess. Bolagsverket / SCB remain the identity source.

### GDPR and marketing (even on the company’s own site)

- Generic inboxes (`info@`, `kontakt@`) on a public company site are still personal data if they identify a natural person, and are at least electronic contact details under marketing rules.
- Named `fornamn.efternamn@` harvested for outreach is a higher bar (GDPR + marknadsföringslagen / ePrivacy).
- SMTP mailbox probing (Dataforge) is not “just checking”; treat it as out of scope unless legal signs off.
- robots.txt + site ToS + purpose limitation should be in the worker’s design, not a later compliance patch.

This note is not legal advice. It is a warning that “MIT scraper on GitHub” ≠ “cleared for a Swedish B2B product.”

---

## Recommendation

**Do not scrape Allabolag / Merinfo / similar directories.** If those fields are required, license UC/Allabolag API or Merinfo’s API/file products.

**Do not adopt Firecrawl OSS** into SCBmcp: AGPL + a full scrape platform is the wrong shape. The cloud API is a vendor decision, not an OSS embed.

**Do not make Botasaurus/Scrapling stealth the default fetch.** Measure block rate; fail soft.

**Build a thin queue worker** (separate from the MCP SCB client) that composes:

1. **Crawl engine**
   - Python sidecar: **Crawl4AI** with `check_robots_txt=True`, Playwright, max 5–10 same-domain pages, include-pattern for `kontakt|om-oss|contact|about`.
   - Or stay in Node: **Crawlee** with the same limits (better process-model fit with SCBmcp).
2. **Extractors (run on each HTML)**
   - `mailto:` / `tel:` hrefs.
   - **extruct** JSON-LD `Organization` / `ContactPoint`.
   - Email regex + simple obfuscation (`[at]`, `(at)`, Cloudflare `data-cfemail` if you implement the documented decode — that encoding is on the page the company published).
   - **phonenumbers**, region `SE`.
   - **Trafilatura** on homepage + om-oss for about text.
3. **Ranking**
   - Prefer contacts whose domain matches the site; prefer homepage/footer/kontakt over `/blogg` and `/integritet`.
   - Keep `sources[]` per value (Omkar’s schema is a good target).
4. **Discovery**
   - Website field from the job payload first.
   - Optional Wikidata P856 + search probe; never Allabolag HTML.

**Read, do not vendor:** Omkar website-email-contact-scraper and ORGA for URL scoring, official-contact ranking, and JSON shape. extract-emails as a tiny email-only fallback. Dataforge only for the “one record, COALESCE, checkpoint” ops pattern.

**First spike (still out of scope for this PR):** 20–50 SCB companies with known websites, HTTP-only vs Playwright, count emails/phones/about, robots denials, and Cloudflare blocks. That number decides whether Crawlee HTTP is enough or whether Playwright must be in the hot path.

---

## Out of shortlist (seen, not recommended as core)

| Project | Why not |
| --- | --- |
| [ScrapeGraphAI/scrapegraph-ai](https://github.com/ScrapeGraphAI/scrapegraph-ai) (MIT, ~30k) | LLM-first extraction; cost and non-determinism for a queue. Fine as an optional “hard page” fallback later. |
| [web-scraping-tools/email-scraper](https://github.com/web-scraping-tools/email-scraper) | Tiny TS email crawler; **no SPDX license** in GitHub metadata; emails only. |
| [derksKCodes/email-extractor](https://github.com/derksKCodes/email-extractor) | Excel/Selenium script; 1 star; incomplete README vs actual JS support. |
| [ivan-sincek/scrapy-scraper](https://github.com/ivan-sincek/scrapy-scraper) | Security recon crawler, not company enrichment. |
| [PRO100CHOK/website-email-phone-extractor-python](https://github.com/PRO100CHOK/website-email-phone-extractor-python) | Apify client wrapper, not local OSS. |
| [internet-dot/companyscope-mcp](https://github.com/internet-dot/companyscope-mcp) | Multi-source company profile (Wikipedia, EDGAR, optional Hunter). Adjacent, not a website contact crawler. |
| Hosted name-to-domain APIs (CUFinder, etc.) | Not OSS; fine as a paid discovery add-on. |

---

## Sources (primary)

- GitHub repository metadata (license, stars, `pushed_at`) on 2026-09-15 for every shortlisted repo.
- Project READMEs: Omkar contact scraper, ORGA, Dataforge, extract-emails, Trafilatura, Crawl4AI, Crawlee, Firecrawl, Scrapy Playwright, extruct.
- Crawl4AI docs: [robots.txt](https://docs.crawl4ai.com/advanced/advanced-features/), [RegexExtractionStrategy](https://docs.crawl4ai.com/extraction/no-llm-strategies/).
- [allabolag.se/info/rattigheter](https://www.allabolag.se/info/rattigheter/), [allabolag.se/info/om-allabolag-se](https://www.allabolag.se/info/om-allabolag-se/), [allabolag.se/info](https://www.allabolag.se/info/) (API offering).
- [merinfo.se/villkor](https://merinfo.se/villkor), [merinfo.se/data-via-api-eller-fil](https://www.merinfo.se/data-via-api-eller-fil).
- Wikidata [P856](https://www.wikidata.org/wiki/Property:P856).
- schema.org [ContactPoint](https://schema.org/ContactPoint) / Organization.
