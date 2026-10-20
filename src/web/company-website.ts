import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import { fold } from "../domain/catalog.js";

export const WEBSITE_PAGE_TIMEOUT_MS = 4_000;
export const WEBSITE_TAVILY_TIMEOUT_MS = 6_000;
export const WEBSITE_BUDGET_MS = 12_000;
export const WEBSITE_SUMMARY_MAX_CHARS = 600;

const DIRECTORY_HOSTS = [
  "allabolag.se",
  "hitta.se",
  "ratsit.se",
  "linkedin.com",
  "facebook.com",
  "fb.com",
  "yayo.se",
  "eniro.se",
  "merinfo.se",
  "bolagsfakta.se",
  "proff.se",
  "upplysning.se",
  "foretagsfakta.se",
  "118100.se",
  "gulasidorna.se",
  "bizzdo.se",
  "kompass.com",
  "kompass.se",
];
const PAGE_HINTS = ["tjanster", "tjanst", "services", "service", "omoss", "about", "kunder", "customers", "verksamhet", "erbjudanden"];
const LEGAL_TOKENS = new Set(["ab", "hb", "kb", "aktiebolag", "handelsbolag", "kommanditbolag"]);
const STOP_TOKENS = new Set(["och", "the", "for", "sweden", "sverige", "entreprenad"]);
const TITLE_CHECK_LIMIT = 3;
const CUSTOMER_TYPES: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /privatperson|konsument/u, label: "Privatpersoner" },
  { pattern: /företag|foretag|bolag/u, label: "Företag" },
  { pattern: /kommun/u, label: "Kommuner" },
  { pattern: /regioner|regionen/u, label: "Regioner" },
  { pattern: /offentlig sektor|myndighet/u, label: "Offentlig sektor" },
  { pattern: /bostadsrätt|brf/u, label: "Bostadsrättsföreningar" },
  { pattern: /industri/u, label: "Industri" },
];

export const companyWebsiteInputSchema = z.object({
  name: z.string().trim().min(1).describe("Företagsnamn, till exempel från scb_find_company."),
  city: z.string().trim().min(1).optional().describe("Ort om den är känd. Gör webbsöket träffsäkrare."),
  organizationNumber: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Organisationsnummer om det är känt."),
  url: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Officiell webbplats. Utelämnad betyder att verktyget söker fram den."),
});

export type CompanyWebsiteInput = z.infer<typeof companyWebsiteInputSchema>;

export type WebsiteConfidence = "high" | "medium" | "low";

export type CompanyWebsiteSummary = {
  url: string;
  summary: string;
  services: string[];
  customerTypes: string[];
  signals: string[];
  confidence: WebsiteConfidence;
};

export class WebsiteSummaryError extends Error {
  readonly code: string;
  readonly reason: string;

  constructor(code: string, message: string, reason = code) {
    super(message);
    this.name = "WebsiteSummaryError";
    this.code = code;
    this.reason = reason;
  }
}

export type WebsiteRuntime = {
  fetchImpl?: typeof fetch;
  tavilyApiKey?: string;
  openAiApiKey?: string;
  now?: () => number;
  pageTimeoutMs?: number;
  tavilyTimeoutMs?: number;
  budgetMs?: number;
};

/** Keys loaded by `loadConfig` from `TAVILY_API_KEY` and `OPENAI_API_KEY`. */
export function websiteRuntimeFromConfig(
  config: Pick<AppConfig, "tavilyApiKey" | "openAiApiKey">,
): WebsiteRuntime {
  return {
    ...(config.tavilyApiKey ? { tavilyApiKey: config.tavilyApiKey } : {}),
    ...(config.openAiApiKey ? { openAiApiKey: config.openAiApiKey } : {}),
  };
}

type Page = { url: string; html: string; text: string };

type SearchNotes = {
  answer?: string;
  snippets: string[];
};

type SearchHit = {
  url: URL;
  title?: string;
  content?: string;
};

export async function summarizeCompanyWebsite(
  input: CompanyWebsiteInput,
  runtime: WebsiteRuntime = {},
): Promise<CompanyWebsiteSummary> {
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const now = runtime.now ?? Date.now;
  const pageTimeoutMs = runtime.pageTimeoutMs ?? WEBSITE_PAGE_TIMEOUT_MS;
  const tavilyTimeoutMs = runtime.tavilyTimeoutMs ?? WEBSITE_TAVILY_TIMEOUT_MS;
  const budgetMs = runtime.budgetMs ?? WEBSITE_BUDGET_MS;
  const started = now();
  const remaining = (): number => Math.max(0, budgetMs - (now() - started));
  const resolved = await resolveOfficialSite(
    input,
    runtime.tavilyApiKey,
    fetchImpl,
    remaining,
    pageTimeoutMs,
    tavilyTimeoutMs,
  );
  const home = resolved.page;
  const links = pickInternalLinks(home.html, new URL(home.url), input.name, input.city).slice(0, 3);
  const extras = await Promise.all(
    links.map((link) => fetchPage(link, fetchImpl, Math.min(pageTimeoutMs, remaining()), input.name, input.city)),
  );
  const pages = [home, ...extras.flatMap((fetched) => (fetched.page ? [fetched.page] : []))];
  const text = pages.map((page) => page.text).join("\n");
  const extracted = extractWebsiteFacts(text, input.city);
  extracted.summary = capSummary(composeSummary(pages, resolved.notes, input.name, input.city) || extracted.summary);
  const readable = `${text} ${extracted.summary}`;
  if (fold(readable).length < 40) {
    throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Webbplatsen gick inte att läsa.", "page_unreadable");
  }
  const nameMatched = siteMatchesName(home, input.name, input.city);
  const heuristic = toSummary(home.url, extracted, confidenceFor(nameMatched, text.length, pages.length, extracted.summary.length));
  if (!runtime.openAiApiKey || remaining() < 1_500) {
    return heuristic;
  }
  const generated = await summarizeWithModel(text, runtime.openAiApiKey, fetchImpl, Math.min(pageTimeoutMs, remaining()));
  if (!generated) {
    return heuristic;
  }
  return {
    url: home.url,
    summary: capSummary(generated.summary || heuristic.summary),
    services: generated.services.length > 0 ? generated.services.slice(0, 6) : heuristic.services,
    customerTypes: generated.customerTypes.length > 0 ? generated.customerTypes.slice(0, 6) : heuristic.customerTypes,
    signals: unique([...generated.signals, ...heuristic.signals]).slice(0, 6),
    confidence: generated.confidence ?? heuristic.confidence,
  };
}

async function resolveOfficialSite(
  input: CompanyWebsiteInput,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  remaining: () => number,
  pageTimeoutMs: number,
  tavilyTimeoutMs: number,
): Promise<{ page: Page; notes?: SearchNotes }> {
  if (input.url?.trim()) {
    const official = normalizeOfficialUrl(input.url, input.name, input.city);
    const fetched = await fetchPage(official.href, fetchImpl, Math.min(pageTimeoutMs, remaining()), input.name, input.city);
    if (!fetched.page) {
      throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Webbplatsen svarade inte.", fetched.reason);
    }
    if (!siteMatchesName(fetched.page, input.name, input.city)) {
      throw new WebsiteSummaryError(
        "WEBSITE_NOT_FOUND",
        "Jag hittade ingen officiell webbplats.",
        `name_mismatch host=${hostKey(new URL(fetched.page.url))}`,
      );
    }
    return { page: fetched.page };
  }
  return searchOfficialSite(input, apiKey, fetchImpl, remaining, pageTimeoutMs, tavilyTimeoutMs);
}

async function searchOfficialSite(
  input: CompanyWebsiteInput,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  remaining: () => number,
  pageTimeoutMs: number,
  tavilyTimeoutMs: number,
): Promise<{ page: Page; notes: SearchNotes }> {
  if (!apiKey) {
    throw new WebsiteSummaryError("WEBSITE_NOT_CONFIGURED", "Webbsök är inte aktiverat.", "tavily_not_configured");
  }
  const query = [input.name, input.city, input.organizationNumber, "officiell webbplats"].filter(Boolean).join(" ");
  const response = await fetchTavily(apiKey, query, fetchImpl, remaining, tavilyTimeoutMs);
  const payload = (await response.json()) as {
    answer?: unknown;
    results?: Array<{ url?: string; title?: string; content?: string }>;
  };
  const hits = (payload.results ?? []).flatMap((item) => {
    const url = typeof item.url === "string" ? safeUrl(item.url) : undefined;
    if (!url || isBlockedAddress(url) || isDirectoryUrl(url, input.name, input.city)) {
      return [];
    }
    return [{
      url,
      ...(typeof item.title === "string" && item.title.trim() ? { title: item.title.trim() } : {}),
      ...(typeof item.content === "string" && item.content.trim() ? { content: item.content.trim() } : {}),
    } satisfies SearchHit];
  });
  const answer = typeof payload.answer === "string" && payload.answer.trim() ? payload.answer.trim() : undefined;
  const picked = pickBestCandidate(hits.map((hit) => hit.url), input.name, input.city);
  if (picked) {
    const fetched = await fetchPage(picked.href, fetchImpl, Math.min(pageTimeoutMs, remaining()), input.name, input.city);
    if (!fetched.page) {
      throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Webbplatsen svarade inte.", fetched.reason);
    }
    if (!siteMatchesName(fetched.page, input.name, input.city)) {
      throw new WebsiteSummaryError(
        "WEBSITE_NOT_FOUND",
        "Jag hittade ingen officiell webbplats.",
        `name_mismatch host=${hostKey(new URL(fetched.page.url))}`,
      );
    }
    return { page: fetched.page, notes: notesFor(answer, hits, fetched.page) };
  }
  for (const hit of hits.slice(0, TITLE_CHECK_LIMIT)) {
    const fetched = await fetchPage(hit.url.href, fetchImpl, Math.min(pageTimeoutMs, remaining()), input.name, input.city);
    if (!fetched.page || !siteMatchesName(fetched.page, input.name, input.city)) {
      continue;
    }
    return { page: fetched.page, notes: notesFor(answer, hits, fetched.page) };
  }
  throw new WebsiteSummaryError("WEBSITE_NOT_FOUND", "Jag hittade ingen officiell webbplats.", noMatchReason(hits));
}

async function fetchTavily(
  apiKey: string,
  query: string,
  fetchImpl: typeof fetch,
  remaining: () => number,
  tavilyTimeoutMs: number,
): Promise<Response> {
  let failure = "tavily_http_500";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeoutMs = Math.min(tavilyTimeoutMs, remaining());
    if (timeoutMs < 200) {
      throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Jag kunde inte söka efter webbplatsen.", "tavily_budget");
    }
    try {
      const response = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: 8,
          include_answer: true,
          exclude_domains: DIRECTORY_HOSTS,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        return response;
      }
      failure = `tavily_http_${response.status}`;
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 500 || attempt === 1) {
        throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Jag kunde inte söka efter webbplatsen.", failure);
      }
    } catch (error) {
      if (error instanceof WebsiteSummaryError) {
        throw error;
      }
      const reason = isTimeout(error) ? "tavily_timeout" : "tavily_network";
      throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Jag kunde inte söka efter webbplatsen.", reason);
    }
  }
  throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Jag kunde inte söka efter webbplatsen.", failure);
}

function noMatchReason(hits: SearchHit[]): string {
  const hosts = unique(hits.map((hit) => hostKey(hit.url))).slice(0, 8);
  return hosts.length > 0 ? `no_name_match hosts=${hosts.join(",")}` : "no_name_match";
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function notesFor(answer: string | undefined, hits: SearchHit[], page: Page): SearchNotes {
  const host = hostKey(new URL(page.url));
  const snippets = unique(
    hits
      .filter((hit) => hostKey(hit.url) === host && hit.content)
      .map((hit) => hit.content ?? ""),
  );
  return {
    ...(answer ? { answer } : {}),
    snippets,
  };
}

function normalizeOfficialUrl(raw: string, name?: string, city?: string): URL {
  const url = safeUrl(raw.includes("://") ? raw : `https://${raw}`);
  if (!url || isBlockedAddress(url)) {
    throw new WebsiteSummaryError("WEBSITE_INVALID_URL", "Jag kan inte hämta den adressen.", "blocked_address");
  }
  if (isDirectoryUrl(url, name, city)) {
    throw new WebsiteSummaryError("WEBSITE_INVALID_URL", "Jag kan inte hämta den adressen.", "directory_url");
  }
  return url;
}

const IGNORED_LABELS = new Set(["www", "co", "com", "se", "nu", "net", "org", "io", "uk", "de", "no", "dk", "fi", "eu"]);

export function pickBestCandidate(candidates: URL[], name: string, city?: string): URL | undefined {
  let best: { url: URL; score: number } | undefined;
  for (const url of candidates) {
    if (isDirectoryUrl(url, name, city)) {
      continue;
    }
    const score = domainScore(url.hostname, name, city);
    if (score <= 0) {
      continue;
    }
    if (!best || score > best.score || (score === best.score && preferSwedishHost(url, best.url))) {
      best = { url, score };
    }
  }
  return best?.url;
}

function preferSwedishHost(url: URL, current: URL): boolean {
  return url.hostname.toLowerCase().endsWith(".se") && !current.hostname.toLowerCase().endsWith(".se");
}

function domainScore(hostname: string, name: string, city?: string): number {
  const token = nameTokens(name, city)[0];
  if (!token) {
    return 0;
  }
  let score = 0;
  for (const label of hostLabels(hostname)) {
    if (label === token) {
      score = Math.max(score, 100);
    } else if (label.startsWith(token)) {
      score = Math.max(score, 80);
    }
  }
  return score;
}

function hostLabels(hostname: string): string[] {
  return hostname
    .toLowerCase()
    .replace(/\.$/u, "")
    .split(".")
    .map((label) => fold(label))
    .filter((label) => label.length >= 2 && !IGNORED_LABELS.has(label));
}

function hostMatchesName(hostname: string, name: string, city?: string): boolean {
  return domainScore(hostname, name, city) > 0;
}

function nameTokens(name: string, city?: string): string[] {
  let source = name;
  if (city?.trim()) {
    const escaped = city.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    source = source.replace(new RegExp(`\\bi\\s+${escaped}\\b`, "giu"), " ");
  }
  source = source.replace(/\bi\s+\p{Lu}[\p{L}\p{M}'’-]*$/u, " ");
  return source
    .split(/[^0-9A-Za-zÅÄÖåäö]+/u)
    .map((part) => fold(part))
    .filter((part) => part.length >= 3 && !STOP_TOKENS.has(part) && !LEGAL_TOKENS.has(part));
}

function siteMatchesName(page: Page, name: string, city?: string): boolean {
  const url = safeUrl(page.url);
  if (!url || isDirectoryUrl(url, name, city) || isBlockedAddress(url)) {
    return false;
  }
  if (hostMatchesName(url.hostname, name, city)) {
    return true;
  }
  return pageMentionsName(page.html, name, city);
}

function pageMentionsName(html: string, name: string, city?: string): boolean {
  const token = nameTokens(name, city)[0];
  if (!token) {
    return false;
  }
  const title = fold(metaOrTitle(html));
  const h1 = fold(headingTexts(html, "h1").join(" "));
  return title.includes(token) || h1.includes(token);
}

function isDirectoryHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  return DIRECTORY_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function hasDirectoryPath(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  return /\/foretag(?:\/|$)/u.test(path) || /\/company(?:\/|$)/u.test(path);
}

function isDirectoryUrl(url: URL, name?: string, city?: string): boolean {
  if (isDirectoryHost(url)) {
    return true;
  }
  if (!hasDirectoryPath(url)) {
    return false;
  }
  if (!name || !hostMatchesName(url.hostname, name, city)) {
    return true;
  }
  return false;
}

function isBlockedAddress(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return true;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host === "0.0.0.0") {
    return true;
  }
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!match) {
    return false;
  }
  const a = Number(match[1]);
  const b = Number(match[2]);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function fetchPage(
  raw: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  name?: string,
  city?: string,
): Promise<{ page: Page | null; reason: string }> {
  const url = safeUrl(raw);
  if (!url || isBlockedAddress(url)) {
    return { page: null, reason: "page_blocked" };
  }
  if (isDirectoryUrl(url, name, city)) {
    return { page: null, reason: `page_directory host=${hostKey(url)}` };
  }
  if (timeoutMs < 200) {
    return { page: null, reason: "page_budget" };
  }
  try {
    const response = await fetchImpl(url.href, {
      headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "sv" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { page: null, reason: `page_http_${response.status} host=${hostKey(url)}` };
    }
    const finalUrl = safeUrl(response.url || url.href) ?? url;
    if (isBlockedAddress(finalUrl)) {
      return { page: null, reason: "page_blocked" };
    }
    if (isDirectoryUrl(finalUrl, name, city)) {
      return { page: null, reason: `page_directory host=${hostKey(finalUrl)}` };
    }
    const html = (await response.text()).slice(0, 500_000);
    return { page: { url: finalUrl.href, html, text: pageText(html) }, reason: "ok" };
  } catch (error) {
    const reason = isTimeout(error) ? "page_timeout" : "page_network";
    return { page: null, reason: `${reason} host=${hostKey(url)}` };
  }
}

export function pickInternalLinks(html: string, base: URL, name?: string, city?: string): string[] {
  const source = html.replace(/<script[\s\S]*?<\/script>/giu, " ").replace(/<style[\s\S]*?<\/style>/giu, " ");
  const seen = new Set<string>([normalizePath(base)]);
  const scored: Array<{ href: string; score: number; index: number }> = [];
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(source))) {
    const href = match[1]?.trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }
    let url: URL | undefined;
    try {
      url = safeUrl(new URL(href, base).href);
    } catch {
      url = undefined;
    }
    if (!url || isBlockedAddress(url) || isDirectoryUrl(url, name, city)) {
      continue;
    }
    if (hostKey(url) !== hostKey(base)) {
      continue;
    }
    const key = normalizePath(url);
    if (seen.has(key)) {
      continue;
    }
    const text = fold(`${href} ${htmlToText(match[2] ?? "")}`);
    const score = PAGE_HINTS.reduce((sum, hint) => sum + (text.includes(hint) ? 1 : 0), 0);
    if (score === 0) {
      continue;
    }
    seen.add(key);
    scored.push({ href: url.href, score, index });
    index += 1;
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((item) => item.href);
}

function hostKey(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./u, "");
}

function normalizePath(url: URL): string {
  return `${hostKey(url)}${url.pathname.replace(/\/+$/u, "") || "/"}`;
}

function pageText(html: string): string {
  return htmlToText(stripChrome(html))
    .split("\n")
    .filter((line) => !isChromeText(line))
    .join("\n");
}

function stripChrome(html: string): string {
  let source = html
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/giu, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/giu, " ");
  const chrome = /<(div|section|aside|header)\b[^>]*(?:cookie|consent|gdpr|kakor)[^>]*>[\s\S]*?<\/\1>/giu;
  let previous = "";
  while (previous !== source) {
    previous = source;
    source = source.replace(chrome, " ");
  }
  return source;
}

function metaContent(html: string, key: string): string {
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, "iu"),
    new RegExp(`<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${key}["']`, "iu"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    const value = match?.[1]?.trim();
    if (value) {
      return decodeEntities(value).replace(/\s+/gu, " ").trim();
    }
  }
  return "";
}

function metaOrTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  return decodeEntities(match?.[1] ?? "").replace(/\s+/gu, " ").trim();
}

function headingTexts(html: string, level: "h1" | "h2"): string[] {
  const pattern = new RegExp(`<${level}\\b[^>]*>([\\s\\S]*?)<\\/${level}>`, "giu");
  const headings: string[] = [];
  for (const match of html.matchAll(pattern)) {
    const text = htmlToText(match[1] ?? "").replace(/\s+/gu, " ").trim();
    if (text) {
      headings.push(text);
    }
  }
  return headings;
}

function paragraphTexts(html: string): string[] {
  const paragraphs: string[] = [];
  for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu)) {
    const text = htmlToText(match[1] ?? "").replace(/\s+/gu, " ").trim();
    if (text) {
      paragraphs.push(text);
    }
  }
  return paragraphs;
}

function readContent(html: string): { description: string; headings: string[]; paragraphs: string[] } {
  const stripped = stripChrome(html);
  const description = metaContent(html, "description") || metaContent(html, "og:description");
  const headings = [...headingTexts(stripped, "h1"), ...headingTexts(stripped, "h2")].filter(
    (heading) => heading.length >= 2 && heading.length <= 120 && !isChromeText(heading),
  );
  const paragraphs = paragraphTexts(stripped)
    .filter((paragraph) => paragraph.length >= 40 && paragraph.length <= 400 && !isChromeText(paragraph))
    .slice(0, 3);
  return { description, headings, paragraphs };
}

function composeSummary(pages: Page[], notes: SearchNotes | undefined, name: string, city?: string): string {
  const parts: string[] = [];
  const push = (value: string): void => {
    const clean = value.replace(/\s+/gu, " ").trim();
    if (!clean || isChromeText(clean)) {
      return;
    }
    const folded = fold(clean);
    if (parts.some((part) => {
      const existing = fold(part);
      return existing.includes(folded) || (folded.includes(existing) && existing.length > 20);
    })) {
      return;
    }
    parts.push(clean);
  };
  for (const page of pages) {
    const content = readContent(page.html);
    if (content.description) {
      push(content.description);
    }
    for (const heading of content.headings) {
      push(heading);
    }
    for (const paragraph of content.paragraphs) {
      push(paragraph);
    }
  }
  const pageSummary = parts.join(" ");
  if (notes && pageSummary.length < WEBSITE_SUMMARY_MAX_CHARS) {
    const extras = pageSummary.length < 120 ? [...noteSentences(notes.answer, name, city), ...notes.snippets] : notes.snippets;
    for (const extra of extras.flatMap((blob) => contentSentences(blob))) {
      push(extra);
      if (parts.join(" ").length >= WEBSITE_SUMMARY_MAX_CHARS) {
        break;
      }
    }
  }
  return parts.join(" ");
}

function noteSentences(answer: string | undefined, name: string, city?: string): string[] {
  if (!answer) {
    return [];
  }
  const tokens = nameTokens(name, city);
  if (tokens.length > 0 && !tokens.every((token) => fold(answer).includes(token))) {
    return [];
  }
  return [answer];
}

function contentSentences(blob: string): string[] {
  return blob
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.replace(/\s+/gu, " ").trim())
    .filter((sentence) => sentence.length >= 40 && !isChromeText(sentence));
}

function isChromeText(value: string): boolean {
  const folded = fold(value);
  if (!folded) {
    return true;
  }
  const business = /erbjud|saljer|tillverk|utfor|tjanst|verksam|markarbete|kund|foretag|kommun/u.test(folded);
  if (/cookie|kakor|acceptera|samtycke|gdpr/u.test(folded) && !business) {
    return true;
  }
  if (/^(meny|loggain|varukorg|javascript)$/u.test(folded)) {
    return true;
  }
  return /loggain|varukorg|javascript/u.test(folded) && !business;
}

export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<h[1-6][^>]*>/giu, "\n## ")
    .replace(/<li[^>]*>/giu, "\n- ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p>/giu, "\n")
    .replace(/<[^>]+>/gu, " ");
  return decodeEntities(withoutNoise)
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&aring;/giu, "å")
    .replace(/&auml;/giu, "ä")
    .replace(/&ouml;/giu, "ö")
    .replace(/&Aring;/gu, "Å")
    .replace(/&Auml;/gu, "Ä")
    .replace(/&Ouml;/gu, "Ö");
}

type ExtractedFacts = {
  summary: string;
  services: string[];
  customerTypes: string[];
  signals: string[];
};

export function extractWebsiteFacts(text: string, city?: string): ExtractedFacts {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const services = extractServices(lines);
  const plain = lines.map((line) => line.replace(/^##\s+/u, "").replace(/^-\s+/u, "")).join(" ");
  const folded = fold(plain);
  return {
    summary: capSummary(pickSentences(plain, city)),
    services,
    customerTypes: CUSTOMER_TYPES.filter((item) => item.pattern.test(plain)).map((item) => item.label),
    signals: signalsFrom(folded),
  };
}

function extractServices(lines: string[]): string[] {
  const services: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const heading = line.startsWith("## ");
    const folded = fold(line);
    if (heading && /tjanst|service|erbjud/u.test(folded)) {
      collecting = true;
      continue;
    }
    if (heading && collecting) {
      break;
    }
    if (collecting && line.startsWith("- ")) {
      const item = line.slice(2).trim();
      if (item.length >= 2 && item.length <= 80) {
        services.push(item);
      }
    }
    if (services.length >= 6) {
      break;
    }
  }
  return unique(services);
}

function pickSentences(text: string, city?: string): string {
  const cityFold = city ? fold(city) : "";
  const sentences = text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.replace(/\s+/gu, " ").trim())
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 280);
  const ranked = sentences
    .map((sentence, index) => ({ sentence, index, score: sentenceScore(sentence, cityFold) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: string[] = [];
  let length = 0;
  for (const item of ranked) {
    if (chosen.some((sentence) => fold(sentence) === fold(item.sentence))) {
      continue;
    }
    if (length + item.sentence.length > WEBSITE_SUMMARY_MAX_CHARS) {
      continue;
    }
    chosen.push(item.sentence);
    length += item.sentence.length + 1;
    if (chosen.length >= 4) {
      break;
    }
  }
  return chosen.join(" ");
}

function sentenceScore(sentence: string, cityFold: string): number {
  const folded = fold(sentence);
  if (/cookie|javascript|loggain|acceptera|varukorg|meny/u.test(folded)) {
    return 0;
  }
  let score = 1;
  if (/erbjud|hjalp|saljer|tillverk|utveckl|leverer|tjanst|verksam/u.test(folded)) {
    score += 3;
  }
  if (/kund|foretag|privat|kommun|region/u.test(folded)) {
    score += 2;
  }
  if (/sverige|norden|stockholm|goteborg|malmo/u.test(folded) || (cityFold && folded.includes(cityFold))) {
    score += 2;
  }
  return score;
}

function signalsFrom(folded: string): string[] {
  const signals: string[] = [];
  if (/webbutik|webbshop|ehandel|koponline|webshop|varukorg/u.test(folded)) {
    signals.push("har webbshop");
  }
  if (/rekryter|lediga jobb|karriar|jobba hos/u.test(folded)) {
    signals.push("rekryterar");
  }
  if (/certifier|iso9001|iso14001/u.test(folded)) {
    signals.push("certifieringar");
  }
  return signals;
}

function confidenceFor(nameMatched: boolean, textLength: number, pageCount: number, summaryLength: number): WebsiteConfidence {
  if (nameMatched && textLength > 400 && pageCount >= 2 && summaryLength > 80) {
    return "high";
  }
  if (textLength > 180 && summaryLength > 40) {
    return "medium";
  }
  return "low";
}

function toSummary(
  url: string,
  extracted: ExtractedFacts,
  confidence: WebsiteConfidence,
): CompanyWebsiteSummary {
  return {
    url,
    summary: extracted.summary,
    services: extracted.services,
    customerTypes: extracted.customerTypes,
    signals: extracted.signals,
    confidence,
  };
}

function capSummary(text: string): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= WEBSITE_SUMMARY_MAX_CHARS) {
    return clean;
  }
  const slice = clean.slice(0, WEBSITE_SUMMARY_MAX_CHARS);
  const stop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (stop >= 200) {
    return slice.slice(0, stop + 1).trim();
  }
  return slice.trim();
}

async function summarizeWithModel(
  text: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{
  summary: string;
  services: string[];
  customerTypes: string[];
  signals: string[];
  confidence?: WebsiteConfidence;
} | null> {
  if (timeoutMs < 200) {
    return null;
  }
  try {
    const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Sammanfatta ett svenskt företags webbplats. Svara bara med JSON: {summary, services, customerTypes, signals, confidence}. summary är högst 600 tecken på svenska om vad de gör, erbjudanden, kundtyper och regioner. services och customerTypes är korta listor. signals är korta fraser som 'har webbshop', 'rekryterar', 'certifieringar'. confidence är high, medium eller low.",
          },
          { role: "user", content: text.slice(0, 6_000) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return null;
    }
    const parsed = JSON.parse(content) as {
      summary?: unknown;
      services?: unknown;
      customerTypes?: unknown;
      signals?: unknown;
      confidence?: unknown;
    };
    const confidence = parsed.confidence;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      services: stringList(parsed.services),
      customerTypes: stringList(parsed.customerTypes),
      signals: stringList(parsed.signals),
      ...(confidence === "high" || confidence === "medium" || confidence === "low" ? { confidence } : {}),
    };
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, 6);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = fold(value);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(value);
  }
  return out;
}

function safeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}
