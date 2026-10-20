import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import { fold } from "../domain/catalog.js";

export const WEBSITE_PAGE_TIMEOUT_MS = 4_000;
export const WEBSITE_BUDGET_MS = 8_000;
export const WEBSITE_SUMMARY_MAX_CHARS = 600;

const DIRECTORY_HOSTS = ["allabolag.se", "hitta.se", "ratsit.se", "linkedin.com", "facebook.com", "fb.com"];
const PAGE_HINTS = ["tjanster", "tjanst", "services", "service", "omoss", "about", "kunder", "customers", "verksamhet", "erbjudanden"];
const LEGAL_SUFFIX = /(aktiebolag|handelsbolag|kommanditbolag|ab|hb|kb)$/u;
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

  constructor(code: string, message: string) {
    super(message);
    this.name = "WebsiteSummaryError";
    this.code = code;
  }
}

export type WebsiteRuntime = {
  fetchImpl?: typeof fetch;
  tavilyApiKey?: string;
  openAiApiKey?: string;
  now?: () => number;
  pageTimeoutMs?: number;
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

export async function summarizeCompanyWebsite(
  input: CompanyWebsiteInput,
  runtime: WebsiteRuntime = {},
): Promise<CompanyWebsiteSummary> {
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const now = runtime.now ?? Date.now;
  const pageTimeoutMs = runtime.pageTimeoutMs ?? WEBSITE_PAGE_TIMEOUT_MS;
  const budgetMs = runtime.budgetMs ?? WEBSITE_BUDGET_MS;
  const started = now();
  const remaining = (): number => Math.max(0, budgetMs - (now() - started));
  const official = input.url?.trim()
    ? normalizeOfficialUrl(input.url)
    : await searchOfficialUrl(input, runtime.tavilyApiKey, fetchImpl, remaining, pageTimeoutMs);
  const home = await fetchPage(official.href, fetchImpl, Math.min(pageTimeoutMs, remaining()));
  if (!home) {
    throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Webbplatsen svarade inte.");
  }
  const links = pickInternalLinks(home.html, new URL(home.url)).slice(0, 3);
  const extras = await Promise.all(
    links.map((link) => fetchPage(link, fetchImpl, Math.min(pageTimeoutMs, remaining()))),
  );
  const pages = [home, ...extras.filter((page): page is Page => page !== null)];
  const text = pages.map((page) => page.text).join("\n");
  if (fold(text).length < 40) {
    throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Webbplatsen gick inte att läsa.");
  }
  const extracted = extractWebsiteFacts(text, input.city);
  const nameMatched = hostMatchesName(new URL(home.url).hostname, input.name);
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

async function searchOfficialUrl(
  input: CompanyWebsiteInput,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
  remaining: () => number,
  pageTimeoutMs: number,
): Promise<URL> {
  if (!apiKey) {
    throw new WebsiteSummaryError("WEBSITE_NOT_CONFIGURED", "Webbsök är inte aktiverat.");
  }
  const timeoutMs = Math.min(pageTimeoutMs, remaining());
  if (timeoutMs < 200) {
    throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Jag kunde inte söka efter webbplatsen.");
  }
  const query = [input.name, input.city, input.organizationNumber, "officiell webbplats"].filter(Boolean).join(" ");
  let response: Response;
  try {
    response = await fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 8,
        include_answer: false,
        exclude_domains: DIRECTORY_HOSTS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Jag kunde inte söka efter webbplatsen.");
  }
  if (!response.ok) {
    throw new WebsiteSummaryError("WEBSITE_UNAVAILABLE", "Jag kunde inte söka efter webbplatsen.");
  }
  const payload = (await response.json()) as { results?: Array<{ url?: string }> };
  const candidates = (payload.results ?? [])
    .map((item) => item.url)
    .filter((url): url is string => typeof url === "string")
    .map((url) => safeUrl(url))
    .filter((url): url is URL => url !== undefined && !isDirectoryUrl(url) && !isBlockedAddress(url));
  const picked = pickBestCandidate(candidates, input.name);
  if (!picked) {
    throw new WebsiteSummaryError("WEBSITE_NOT_FOUND", "Jag hittade ingen officiell webbplats.");
  }
  return picked;
}

function normalizeOfficialUrl(raw: string): URL {
  const url = safeUrl(raw.includes("://") ? raw : `https://${raw}`);
  if (!url || isBlockedAddress(url) || isDirectoryUrl(url)) {
    throw new WebsiteSummaryError("WEBSITE_INVALID_URL", "Jag kan inte hämta den adressen.");
  }
  return url;
}

export function pickBestCandidate(candidates: URL[], name: string): URL | undefined {
  let best: { url: URL; score: number } | undefined;
  for (const url of candidates) {
    const score = domainScore(url.hostname, name);
    if (!best || score > best.score) {
      best = { url, score };
    }
  }
  if (!best) {
    return undefined;
  }
  if (best.score > 0) {
    return best.url;
  }
  return candidates[0];
}

function domainScore(hostname: string, name: string): number {
  const host = fold(hostname.replace(/^www\./u, ""));
  const tokens = nameTokens(name);
  if (tokens.length === 0) {
    return 0;
  }
  const whole = tokens.join("");
  if (whole.length >= 4 && host.includes(whole)) {
    return 100;
  }
  let score = 0;
  for (const token of tokens) {
    if (token.length >= 4 && host.includes(token)) {
      score = Math.max(score, 80);
    } else if (token.length >= 3 && host.includes(token)) {
      score = Math.max(score, 40);
    }
  }
  return score;
}

function hostMatchesName(hostname: string, name: string): boolean {
  return domainScore(hostname, name) >= 40;
}

function nameTokens(name: string): string[] {
  return name
    .split(/[^0-9A-Za-zÅÄÖåäö]+/u)
    .map((part) => fold(part).replace(LEGAL_SUFFIX, ""))
    .filter((part) => part.length >= 3 && !["och", "the", "for", "sweden", "sverige"].includes(part));
}

function isDirectoryUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  return DIRECTORY_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
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

async function fetchPage(raw: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Page | null> {
  const url = safeUrl(raw);
  if (!url || isBlockedAddress(url) || isDirectoryUrl(url) || timeoutMs < 200) {
    return null;
  }
  try {
    const response = await fetchImpl(url.href, {
      headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "sv" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return null;
    }
    const finalUrl = safeUrl(response.url || url.href) ?? url;
    if (isBlockedAddress(finalUrl) || isDirectoryUrl(finalUrl)) {
      return null;
    }
    const html = (await response.text()).slice(0, 500_000);
    return { url: finalUrl.href, html, text: htmlToText(html) };
  } catch {
    return null;
  }
}

export function pickInternalLinks(html: string, base: URL): string[] {
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
    if (!url || isBlockedAddress(url) || isDirectoryUrl(url)) {
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
