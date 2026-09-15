# OSS research (slice A): lead / contact / email–phone finders

**Scope:** Existing open-source projects we could reuse to enrich Swedish SCB company lists (`name` + `organizationNumber` + `municipality`) with **phone, email, website, short about**.

**This file only.** No product or runtime code changes. SCBmcp remains a data-access layer for SCB AFR ([README](../../README.md)): it does not scrape, enrich, or look up other sources.

**Researched:** 2026-09-15. Activity dates are GitHub `pushed_at` unless noted.

---

## Context that constrains reuse

Hunter.io / Clearbit / Apollo assume you already have a **domain** and often a **person name**. Our batch does not:

| We have (SCB AFR) | We typically do **not** have |
| --- | --- |
| Legal name, org.nr, municipality / county, SNI, size class, status | Website URL |
| Optional workplace address tokens | Contact person (first + last name) |
| `Reklam` opt-out flag (must not be bypassed) | Email, phone, “about” |

So the real pipeline is **not** “email finder given domain”. It is:

```
SCB row (name + org.nr + kommun)
  → resolve official website (and/or a directory phone)
  → extract email / phone / about from that site
  → optionally verify emails (MX / SMTP)
```

Swedish SME reality: many ABs have a `.se` site with `info@` / `kontakt@` on `/kontakt`, or only a Google Maps / Hitta listing with a phone and no email. Person-level permutation (`john.doe@company.se`) is a secondary path and usually needs a name we do not have.

GDPR / marketing: SCB’s `Reklam` field exists for a reason. SMTP RCPT probing and bulk scraping of personal inboxes are legally and operationally different from collecting a company `info@` published on the firm’s own site. This report flags that; it is not legal advice.

---

## 1. Shortlist

Ten candidates worth considering. “Last activity” = last git push as of 2026-09-15.

| # | Name | URL | License | Language | Last activity | Stars (approx.) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Website Email & Contact Scraper** | [omkarcloud/website-email-contact-scraper](https://github.com/omkarcloud/website-email-contact-scraper) | MIT | Python | 2026-09-09 | 7 |
| 2 | **Reacher / check-if-email-exists** | [reacherhq/check-if-email-exists](https://github.com/reacherhq/check-if-email-exists) | Dual: AGPL-3.0 **or** commercial | Rust (+ Docker HTTP API) | 2026-03-17 | ~9.9k |
| 3 | **theHarvester** | [laramies/theHarvester](https://github.com/laramies/theHarvester) | GPL-2.0-only | Python | 2026-09-10 | ~17k |
| 4 | **Photon** | [s0md3v/Photon](https://github.com/s0md3v/Photon) | GPL-3.0 | Python | 2026-09-04 | ~13k |
| 5 | **Trafilatura** | [adbar/trafilatura](https://github.com/adbar/trafilatura) | Apache-2.0 | Python | 2026-09-11 | ~6.8k |
| 6 | **Crawl4AI** | [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) | Apache-2.0 | Python | 2026-09-14 | ~83k |
| 7 | **Google Maps Scraper** | [omkarcloud/google-maps-scraper](https://github.com/omkarcloud/google-maps-scraper) | MIT | Python | 2026-09-12 | ~3.5k |
| 8 | **Reconcrawl** | [reconurge/reconcrawl](https://github.com/reconurge/reconcrawl) | MIT | Python | 2026-03-24 | 23 |
| 9 | **ColdReach** | [dhruvmojila/coldreach](https://github.com/dhruvmojila/coldreach) | MIT | Python (TUI + Docker) | 2026-05-11 | 3 |
| 10 | **Prospector MCP Email Finder** | [JosieBot26/prospector-mcp-email-finder](https://github.com/JosieBot26/prospector-mcp-email-finder) | MIT | JavaScript | 2026-03-05 | 11 |

Supporting libraries (not “products”, but we would reuse them anyway):

- [daviddrysdale/python-phonenumbers](https://github.com/daviddrysdale/python-phonenumbers) — Google libphonenumber port; region `SE`. Apache-2.0, actively maintained.
- [JoshData/python-email-validator](https://github.com/JoshData/python-email-validator) — syntax + DNS/MX, **not** mailbox SMTP. CC0 / permissive.

---

## 2. Pros / cons for batch Swedish AB (org.nr available)

### 1. Website Email & Contact Scraper — strongest extractor once we have a URL

Self-hostable Python scraper (also a paid hosted API). Crawls homepage + `/contact` / `/about` style pages, extracts emails (including Cloudflare/`[at]` obfuscation), phones via libphonenumber, socials, title/meta description. Batch API: `scrape_contacts([...])`. Docker + local UI. Built on [Botasaurus](https://github.com/omkarcloud/botasaurus) (MIT, last push 2026-07).

**Pros**

- Closest OSS to “given domain, return company email + phone + short about”.
- Region-aware phones; E.164 output; `is_likely_official` ranking.
- Handles JS / bot walls by escalating to Chrome — relevant for Swedish WordPress/Wix SMEs.
- MIT, self-host unlimited; hosted extras (website-from-name, SMTP verify) are **API-only**, so we would not get those for free.

**Cons**

- **Requires a website.** Does not take org.nr. “Find website from company name” is paid API, not in the OSS tree.
- Young repo (created 2026-08), low star count; extraction quality is the interesting part, not community size.
- Phone region is inferred from TLD; `.se` is fine, but many Swedish shops sit on `.com` or Shopify.
- Vendor also sells the same scraper; OSS vs hosted feature split may widen.

**Fit:** High **after** domain resolution. Not a complete enrichment product.

---

### 2. Reacher (`check-if-email-exists`) — best self-hosted verifier, not a finder

Rust library + Docker HTTP backend (`POST /v0/check_email`). Syntax, MX, SMTP handshake, catch-all, disposable detection. This is the OSS analogue of Hunter *verify*, not Hunter *find*. Docs: [reacher.email](https://reacher.email/).

**Pros**

- Mature, widely used, Docker-friendly sidecar.
- Catch-all detection matters: Swedish Google Workspace / Microsoft 365 tenants often accept all local-parts.
- Useful after we guess `info@`, `kontakt@`, `order@` on a resolved domain.

**Cons**

- **AGPL-3.0 for OSS use**; commercial license otherwise. Linking it into a proprietary enrichment service has license implications. Sidecar-over-HTTP is still a lawyer question.
- Last push 2026-03 (within 18 months, but slower than the crawlers).
- SMTP from cloud IPs is frequently greylisted; needs a host with outbound port 25.
- Does not discover emails. Does not understand org.nr.

**Fit:** High as an optional **verify** step. Do not treat as the finder.

---

### 3. theHarvester — classic domain OSINT, poor batch SME tool

Emails / names / subdomains from search engines and APIs. Actively maintained (push 2026-09-10). GPL-2.0-only.

**Pros**

- Battle-tested; many sources (some free, many need API keys: Hunter, Bing, etc.).
- Useful when the company is digitally visible (listed in GitHub, news, public pages).

**Cons**

- Input is a **domain**, not a Swedish company name / org.nr.
- Designed for pentest recon, not 2 000-row CRM enrichment.
- Yield on tiny Swedish ABs with no search footprint is near zero.
- GPL-2.0 copyleft if we vendor code; wrapping as an external process is cleaner.
- Several “free” sources are flaky; paid Hunter key reintroduces the SaaS we wanted to avoid.

**Fit:** Optional **email harvest from a known domain** when the site itself hides inboxes. Not the primary path.

---

### 4. Photon — fast OSINT crawler (emails, phones, secrets)

Crawls a seed URL, extracts emails, phone numbers, intel. GPL-3.0. Still receiving pushes (2026-09-04).

**Pros**

- Classic, fast, no API keys.
- Directly extracts phone + email from the company’s own site — the right *kind* of data.

**Cons**

- GPL-3.0 (stronger copyleft than theHarvester).
- CLI-oriented; unstructured dump files vs a stable JSON schema.
- Phone regex is not libphonenumber / SE-aware.
- Needs a URL. Not org.nr-aware. 61 open issues; “incredibly fast crawler” more than a productized enricher.

**Fit:** Fallback crawler if we cannot accept the Omkar Cloud stack. Prefer the structured scraper (#1) otherwise.

---

### 5. Trafilatura — short “about”, not contacts

Main-content extraction, metadata, crawl helpers. Apache-2.0. Very active.

**Pros**

- Best-in-class for turning a homepage / om-oss page into clean text for a short about.
- Library-grade, not a lead-gen TUI. Easy to call from a batch job.
- Permissive license.

**Cons**

- Does not find emails or phones (you layer regex / libphonenumber yourself).
- Needs a URL.

**Fit:** High for the **about** field. Combine with a contact extractor.

---

### 6. Crawl4AI — LLM-friendly crawler / JS rendering

Apache-2.0. Extremely active. Good when sites are JS-heavy and we want markdown + optional structured extraction.

**Pros**

- Playwright-class rendering without rolling our own.
- Can run custom extraction (CSS / LLM schema) for contact blocks.
- Permissive license; huge community.

**Cons**

- General crawler, not an email finder. We still write extractors.
- Heavy (browser) for 10k+ Swedish AB homepages unless we HTTP-first then escalate.
- LLM extraction (if used) adds cost and hallucination risk on phone/email.

**Fit:** Good **engine** under a custom extractor; do not adopt as the product.

---

### 7. Google Maps Scraper — phones + websites for *local* firms

MIT. Active. Extracts Maps business cards: name, address, phone, website, rating.

**Pros**

- For Swedish SMEs, Maps often has the **phone** and **website** when the company site does not publish email.
- Search can be `"Företagsnamn" + kommun` — closer to our inputs than Hunter-style domain tools.
- Batch-oriented lead-gen UX.

**Cons**

- **Not org.nr keyed.** Homonym risk: “Bygg AB” in the wrong kommun, or a shop vs the legal entity.
- ToS / scraping Google; operational and legal risk at batch scale. Expect blocks.
- Emails on Maps are rare; this does not replace a site crawler.
- Matching Maps place → SCB legal entity must be built by us (name + address + kommun, never org.nr on Maps).

**Fit:** Useful **phone/website hint** for consumer-facing workplaces (AE), weak for holding companies / pure B2B ABs with no public place.

---

### 8. Reconcrawl — small MIT email/phone crawler

CLI + Python library. Last push 2026-03. README advertises **US** phone formats.

**Pros**

- Tiny, MIT, easy to read and fork.
- Recursive crawl + mailto extraction.

**Cons**

- 23 stars; US-centric phones — Swedish `08-xxx xx xx` / `+46` will be lossy.
- No obfuscation / JS / Cloudflare handling comparable to #1.
- Needs URL.

**Fit:** Learning reference, not something to depend on for SE numbers.

---

### 9. ColdReach — self-hosted “Hunter.io alternative”

MIT. Docker + TUI. Web crawl, GitHub, WHOIS, SearXNG, theHarvester, SpiderFoot, SMTP via self-hosted Reacher. Claims 50–70% vs Hunter 85–90%. Last push 2026-05.

**Pros**

- Only OSS project that *packages* find + verify + draft as a Hunter clone.
- No API keys required for the core path (Groq optional).

**Cons**

- 3 stars, one maintainer, last push ~4 months ago. Not proven at batch scale.
- Oriented to **named people at tech companies with GitHub**, not Swedish AB org.nr lists.
- Pulls in SpiderFoot / theHarvester — heavy, noisy, pentest-shaped.
- TUI, not a library we can call per SCB row.

**Fit:** Interesting architecture to copy (crawl + Reacher). Do **not** vendor as our enricher.

---

### 10. Prospector MCP Email Finder — Hunter-like MCP, very young

MIT, JS. Scrapes site, permutes from a contact name, DNS/SMTP verify, catch-all. Last push 2026-03-05 (day of creation). 11 stars.

**Pros**

- MCP-shaped (same integration style as SCBmcp), zero paid APIs.
- Pattern generation + SMTP is the classic Hunter algorithm.

**Cons**

- Essentially a weekend project; no evidence of SE phone formats or batch org.nr.
- Permutation needs a **person name**.
- SMTP from a random host will fail the same way Reacher does, with less engineering.

**Fit:** Reject as a dependency. Fine as a sketch of MCP tool names.

---

## Looked at and rejected (for this slice)

| Project | Why not |
| --- | --- |
| [Josue87/EmailFinder](https://github.com/Josue87/EmailFinder) | **Archived** (2023). Search-engine email finder. GPL-3.0. |
| [khast3x/h8mail](https://github.com/khast3x/h8mail) | Breach / password-leak OSINT. Last push 2023-08. Wrong data, wrong ethics for CRM enrichment. |
| [sundowndev/phoneinfoga](https://github.com/sundowndev/phoneinfoga) | Active (2026-08), GPL-3.0, ~18k stars — but it **investigates a phone you already have**, it does not find company phones from org.nr. |
| [smicallef/spiderfoot](https://github.com/smicallef/spiderfoot) | Huge OSINT platform (MIT, push 2026-04). Overkill, noisy, not a batch enricher. ColdReach already wraps it. |
| [truemail-rb/truemail](https://github.com/truemail-rb/truemail) | Solid Ruby SMTP verifier (MIT) but **last push 2024-04** — outside the 12–18 month preference. Prefer Reacher. |
| [Harvey-Yuan/leadhub](https://github.com/Harvey-Yuan/leadhub) | MCP lead pipeline wrapping DuckDuckGo + theHarvester. 0 stars, one-day project (2026-06). |
| [tonykone555/keelead](https://github.com/tonykone555/keelead) / Atum246 forks | Self-hosted “62 sources” UI that **plugs in Hunter/Clearbit keys**. Not a replacement for SaaS. |
| [hippiiee/MailPermute](https://github.com/hippiiee/MailPermute) | Name → Gmail/Yahoo permutations. Last push 2025-02. Useless without a person; consumer mailboxes, not `ab.se`. |
| [MottaSec/MottaHunter](https://github.com/mottasec/mottahunter) | Permute + SMTP; 14 stars, one-day repo (2025-05). Same person-name requirement. |
| [marple-newsrobot/allabolag](https://github.com/marple-newsrobot/allabolag) | Python Allabolag.se scraper (MIT). Last push **2024-10**. Org.nr-native, which we need for **website** hints — but it is a **ToS-fragile directory scraper**, not an email/phone finder. Mentioned because other slices may cover Swedish registries; do not treat as contact OSS. |
| Hosted-only “OSS” | Tomba CLIs, Apify contact actors, RapidAPI wrappers: source may be public, **data plane is paid SaaS**. |

There is **no maintained Clearbit-like OSS graph** (company → email/phone) keyed by Swedish org.nr. Paid graphs (Hunter, Apollo, Lusha, FullContact, PDL) remain out of scope for “self-hostable”.

---

## 3. What we would still need to build vs reuse

```
┌─────────────────────────────────────────────────────────────┐
│ BUILD (Swedish-specific, no good OSS)                       │
│  1. Domain resolver: name + org.nr + kommun → website       │
│  2. Entity match / homonym guard (SCB row ↔ crawled site)   │
│  3. Batch job: SCB JSON → enrich → join on org.nr           │
│  4. Role-inbox candidates: info@, kontakt@, order@, …       │
│  5. Reklam / GDPR / robots / rate-limit policy              │
│  6. Confidence + provenance (URL, date, extractor)          │
└─────────────────────────────────────────────────────────────┘
              │ website (or Maps place)
              ▼
┌─────────────────────────────────────────────────────────────┐
│ REUSE                                                       │
│  A. Contact extract: website-email-contact-scraper (#1)     │
│     fallback crawler: Photon (#4) or Crawl4AI (#6)          │
│  B. About text: Trafilatura (#5)                            │
│  C. Phone parse: python-phonenumbers (SE)                   │
│  D. Optional verify: Reacher sidecar (#2)                   │
│  E. Optional local phone/web hint: Maps scraper (#7)        │
└─────────────────────────────────────────────────────────────┘
```

**Must build (nothing on the shortlist does this well):**

1. **Org.nr → website.** Candidates: search `"org.nr" + name`, DNS guess from slugified firma, Swedish directories (Allabolag / Proff — ToS), Maps (#7). Needs a confidence model (`site text contains org.nr` is the gold check).
2. **Join key.** Every OSS tool keys on URL or domain. We key on org.nr.
3. **Swedish phone normalisation** (`010`, `08`, `+46`, spaces). libphonenumber does the parse; we still choose *which* number is the switchboard vs a mobile scraped from a footer.
4. **Role-email guesser** for when the site has MX but no published inbox. Permutation libraries assume `First Last`; we should guess `info@` / `kontakt@` first, then SMTP-verify.
5. **Policy layer.** Honour `Reklam`, robots.txt, crawl-delay, no personal-email harvesting from leaked OSINT (theHarvester/h8mail style).
6. **About compression.** Trafilatura gives raw text; a 2–3 sentence summary is a small LLM or extractive step we own.

**Do not build from scratch:** HTML email/phone extraction, SMTP/MX verify, main-content extraction, Maps HTML parsing (if we accept that source).

**Do not vendor into SCBmcp:** The MCP server’s contract is SCB-only. Enrichment belongs in a **separate worker/service** that consumes AFR exports.

---

## 4. Recommendation

**Do not reuse a Hunter.io clone as the product** (ColdReach, Prospector, KeeLead, LeadHub, MottaHunter). They are either unmaintained toys, person-name permutators, or SaaS-key wrappers. None speak org.nr, Swedish phones, or batch AB lists.

**Reuse a small stack of libraries/sidecars, and build the Swedish glue:**

| Need | Reuse | Notes |
| --- | --- | --- |
| Email + phone from company site | **[website-email-contact-scraper](https://github.com/omkarcloud/website-email-contact-scraper)** | Best structured OSS extractor; MIT; self-host. Treat as a subprocess/library, not a fork we must maintain. |
| Short about | **[Trafilatura](https://github.com/adbar/trafilatura)** | Apache-2.0; homepage + `/om-oss` / `/about`. |
| Optional SMTP verify | **[Reacher](https://github.com/reacherhq/check-if-email-exists)** as Docker sidecar | **AGPL dual-license** — confirm with counsel before shipping inside a commercial service; otherwise MX-only via email-validator. |
| Optional local phone/website | **[google-maps-scraper](https://github.com/omkarcloud/google-maps-scraper)** | Only as a hint, matched carefully to kommun + name. |
| JS-heavy sites if #1 is not enough | **Crawl4AI** | Engine, not finder. |

**If Omkar Cloud’s scraper is unacceptable** (vendor risk, Chrome dependency): implement a thin crawler on Crawl4AI or HTTP+BeautifulSoup, reuse **libphonenumber** + mailto/obfuscation regexes (Photon as a GPL-3 **reference**, not a vendored core), plus Trafilatura.

**theHarvester** is optional later for high-value domains with no on-site inbox — not for the default batch.

---

## Bottom line

**None of the Hunter-like OSS projects fit as a drop-in enricher for Swedish AB lists.**

**Reuse X = contact scraper (#1) + Trafilatura (#5) + (optional) Reacher (#2),** behind an enrichment service we still have to write for org.nr → website, matching, Swedish role-emails, and compliance.

That is reuse of **extractors and verifiers**, not reuse of a lead-gen product.

---

## Sources

- GitHub repository metadata (`pushed_at`, license, language, stars) queried 2026-09-15 via GitHub search/API.
- Project READMEs linked above; Reacher license: [LICENSE.md](https://github.com/reacherhq/check-if-email-exists/blob/master/LICENSE.md); theHarvester license: `GPL-2.0-only` in [pyproject.toml](https://github.com/laramies/theHarvester/blob/master/pyproject.toml).
- SCBmcp default field tokens: [`src/scb/projection.ts`](../../src/scb/projection.ts) (name, org.nr, geography, SNI, `reklam` — no website/email/phone).
