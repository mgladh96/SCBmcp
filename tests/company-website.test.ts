import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { summarizeCompanyWebsite } from "../src/web/company-website.js";
import { createTestClient, jsonResponse } from "./helpers.js";

const silent = createLogger("error");

const homeHtml = `<!doctype html><html><head><script>secret()</script></head><body>
<p>Cookie. Acceptera. Logga in.</p>
<h1>IKEA</h1>
<p>Vi säljer möbler och heminredning till privatpersoner och företag i Sverige, med bas i Älmhult. Sortimentet omfattar kök, förvaring, textilier och belysning för hem i hela landet.</p>
<h2>Tjänster</h2>
<ul><li>Kök</li><li>Förvaring</li><li>Heminredning</li></ul>
<a href="/tjanster">Tjänster</a>
<a href="/om-oss">Om oss</a>
<a href="/kunder">Kunder</a>
<a href="/verksamhet">Verksamhet</a>
<a href="/karriar">Karriär</a>
<a href="https://www.facebook.com/ikea">Facebook</a>
<a href="https://www.allabolag.se/ikea">Allabolag</a>
</body></html>`;

const pages: Record<string, string> = {
  "https://www.ikea.com/se/sv/": homeHtml,
  "https://www.ikea.com/tjanster":
    "<p>I webbutiken kan kunden köp online. Vi erbjuder kök och förvaring till privatpersoner i Sverige.</p>",
  "https://www.ikea.com/om-oss":
    "<p>Vi rekryterar medarbetare till varuhusen. Företaget är ISO 9001 certifierat och verkar i Sverige sedan länge.</p>",
  "https://www.ikea.com/kunder":
    "<p>Vi hjälper kommuner och offentlig sektor med inredning för företag i hela Sverige.</p>",
  "https://www.ikea.com/verksamhet": "<p>Verksamheten omfattar möbler.</p>",
};

function pageResponse(url: string): Response {
  const html = pages[url] ?? "<p>Okänd sida utan tillräcklig text för en sammanfattning här.</p>";
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
}

describe("company_website_summary", () => {
  it("picks a name-matching domain, skips directories, and reads three internal pages", async () => {
    const calls: string[] = [];
    const internalStarted: string[] = [];
    let releaseInternal: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseInternal = resolve;
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api.tavily.com")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer tavily-test" });
        const body = JSON.parse(String(init?.body)) as { exclude_domains?: string[]; query?: string };
        expect(body.exclude_domains).toEqual(expect.arrayContaining(["allabolag.se", "linkedin.com", "facebook.com"]));
        expect(body.query).toContain("IKEA");
        expect(body.query).toContain("Älmhult");
        return jsonResponse(200, {
          results: [
            { url: "https://www.allabolag.se/foretag/ikea" },
            { url: "https://www.hitta.se/ikea" },
            { url: "https://se.linkedin.com/company/ikea" },
            { url: "https://www.facebook.com/ikea" },
            { url: "https://www.ratsit.se/ikea" },
            { url: "https://example.com/nyheter/ikea" },
            { url: "https://www.ikea.com/se/sv/" },
          ],
        });
      }
      if (url === "https://www.ikea.com/se/sv/") {
        return pageResponse(url);
      }
      internalStarted.push(url);
      if (internalStarted.length === 3) {
        releaseInternal?.();
      }
      await gate;
      return pageResponse(url);
    };

    const handlers = createToolHandlers(createTestClient(async () => jsonResponse(200, [])), silent, {
      website: { fetchImpl, tavilyApiKey: "tavily-test" },
    });
    const pending = handlers.company_website_summary({ name: "IKEA of Sweden AB", city: "Älmhult" });
    await gate;
    expect(internalStarted).toEqual([
      "https://www.ikea.com/tjanster",
      "https://www.ikea.com/om-oss",
      "https://www.ikea.com/kunder",
    ]);
    const result = await pending;
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      url: string;
      summary: string;
      services: string[];
      customerTypes: string[];
      signals: string[];
      confidence: string;
    };
    expect(payload.url).toBe("https://www.ikea.com/se/sv/");
    expect(payload.summary.length).toBeLessThanOrEqual(600);
    expect(payload.summary.toLowerCase()).toContain("möbler");
    expect(payload.services).toEqual(["Kök", "Förvaring", "Heminredning"]);
    expect(payload.customerTypes).toEqual(expect.arrayContaining(["Privatpersoner", "Företag", "Kommuner"]));
    expect(payload.signals).toEqual(expect.arrayContaining(["har webbshop", "rekryterar", "certifieringar"]));
    expect(payload.confidence).toBe("high");
    expect(calls.some((url) => url.includes("allabolag") || url.includes("facebook") || url.includes("linkedin") || url.includes("example.com"))).toBe(false);
    expect(calls.some((url) => url.includes("api.openai.com"))).toBe(false);
    expect(calls.filter((url) => url.includes("verksamhet") || url.includes("karriar"))).toEqual([]);
  });

  it("uses a given url and does not call Tavily", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(
        "<p>Vi säljer möbler och heminredning till privatpersoner och företag i Sverige, med bas i Älmhult.</p>",
        { status: 200 },
      );
    };
    const summary = await summarizeCompanyWebsite(
      { name: "IKEA", url: "https://www.ikea.com/se/sv/" },
      { fetchImpl, tavilyApiKey: "unused" },
    );
    expect(summary.url).toBe("https://www.ikea.com/se/sv/");
    expect(calls).toEqual(["https://www.ikea.com/se/sv/"]);
  });

  it("fails fast with a short message when web search is not configured", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not fetch");
    };
    const handlers = createToolHandlers(createTestClient(async () => jsonResponse(200, [])), silent, {
      website: { fetchImpl },
    });
    const result = await handlers.company_website_summary({ name: "IKEA" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({ code: "WEBSITE_NOT_CONFIGURED", message: "Webbsök är inte aktiverat." });
    expect(result.content[0]?.text.length).toBeLessThan(120);
  });

  it("refuses a private address without fetching it", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not fetch");
    };
    const handlers = createToolHandlers(createTestClient(async () => jsonResponse(200, [])), silent, {
      website: { fetchImpl, tavilyApiKey: "tavily-test" },
    });
    const result = await handlers.company_website_summary({ name: "IKEA", url: "http://127.0.0.1/admin" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { message: string };
    expect(payload.message).toBe("Jag kan inte hämta den adressen.");
  });

  it("returns a short voice error when the site does not answer in time", async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const started = Date.now();
    const result = await createToolHandlers(createTestClient(async () => jsonResponse(200, [])), silent, {
      website: { fetchImpl, pageTimeoutMs: 250, budgetMs: 1_000 },
    }).company_website_summary({ name: "IKEA", url: "https://www.ikea.com/" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(150);
    expect(elapsed).toBeLessThan(1_000);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as { code: string; message: string };
    expect(payload).toEqual({ code: "WEBSITE_UNAVAILABLE", message: "Webbplatsen svarade inte." });
  });

  it("uses a cheap model only when a key is present and falls back if it fails", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api.openai.com")) {
        return jsonResponse(200, {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "De säljer möbler till hem i Sverige och Norden.",
                  services: ["Kök"],
                  customerTypes: ["Privatpersoner"],
                  signals: ["har webbshop"],
                  confidence: "high",
                }),
              },
            },
          ],
        });
      }
      return new Response("<p>Vi säljer möbler och heminredning till privatpersoner och företag i Sverige, med bas i Älmhult.</p>", {
        status: 200,
      });
    };
    const withModel = await summarizeCompanyWebsite(
      { name: "IKEA", url: "https://www.ikea.com/" },
      { fetchImpl, openAiApiKey: "sk-test" },
    );
    expect(withModel.summary).toBe("De säljer möbler till hem i Sverige och Norden.");
    expect(calls.some((url) => url.includes("api.openai.com"))).toBe(true);

    const failedModel: typeof fetch = async (input) => {
      if (String(input).includes("api.openai.com")) {
        return new Response("no", { status: 500 });
      }
      return new Response(
        "<p>Vi säljer möbler och heminredning till privatpersoner och företag i Sverige, med bas i Älmhult.</p>",
        { status: 200 },
      );
    };
    const fallback = await summarizeCompanyWebsite(
      { name: "IKEA", url: "https://www.ikea.com/" },
      { fetchImpl: failedModel, openAiApiKey: "sk-test" },
    );
    expect(fallback.summary.toLowerCase()).toContain("möbler");
    expect(fallback.summary.length).toBeLessThanOrEqual(600);
  });
});
