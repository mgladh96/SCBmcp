import { describe, expect, it, vi } from "vitest";
import { ScbError } from "../src/domain/errors.js";
import { ScbClient } from "../src/scb/client.js";
import { SCB_ENDPOINTS } from "../src/scb/endpoints.js";
import { toKodtabellBody } from "../src/scb/payload.js";
import { SlidingWindowRateLimiter } from "../src/scb/rate-limit.js";
import { layoutFor, MAX_RESULTS } from "../src/scb/types.js";
import { createTestClient, jsonResponse, textResponse, testAuth } from "./helpers.js";

describe("JE vs AE routing", () => {
  it("maps company to je and workplace to ae", () => {
    expect(layoutFor("company")).toBe("je");
    expect(layoutFor("workplace")).toBe("ae");
  });

  it("calls JE metadata endpoints for companies", async () => {
    const urls: string[] = [];
    const client = createTestClient(async (url) => {
      urls.push(url);
      return jsonResponse(200, [{ Kategori: "Företagsstatus" }]);
    });
    await client.listCategories("company");
    await client.listCategories("company", true);
    await client.listVariables("company");
    await client.listVariables("company", true);
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      expect.stringContaining(SCB_ENDPOINTS.je.koptakategorier),
      expect.stringContaining(SCB_ENDPOINTS.je.kategoriermedkodtabeller),
      expect.stringContaining(SCB_ENDPOINTS.je.koptavariabler),
      expect.stringContaining(SCB_ENDPOINTS.je.variabler),
    ]);
  });

  it("calls AE metadata endpoints for workplaces", async () => {
    const urls: string[] = [];
    const client = createTestClient(async (url) => {
      urls.push(url);
      return jsonResponse(200, []);
    });
    await client.listCategories("workplace");
    await client.listCategories("workplace", true);
    await client.listVariables("workplace");
    await client.listVariables("workplace", true);
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      expect.stringContaining(SCB_ENDPOINTS.ae.koptakategorier),
      expect.stringContaining(SCB_ENDPOINTS.ae.kategoriermedkodtabeller),
      expect.stringContaining(SCB_ENDPOINTS.ae.koptavariabler),
      expect.stringContaining(SCB_ENDPOINTS.ae.variabler),
    ]);
  });
});

describe("SCB endpoint mapping", () => {
  it("posts kodtabell, count, and fetch to JE paths", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = createTestClient(async (url, init) => {
      calls.push({
        url,
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      if (url.includes("raknaforetag")) {
        return jsonResponse(200, { Antal: 2 });
      }
      if (url.includes("hamtaforetag")) {
        return jsonResponse(200, [{ PeOrgNr: "16" }]);
      }
      return jsonResponse(200, []);
    });
    await client.getCategoryValues("company", "Företagsstatus");
    await client.countCompanies({ categories: [], variables: [] });
    await client.searchCompanies({
      categories: [{ category: "Företagsstatus", values: ["1"] }],
      variables: [],
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      expect.stringContaining(SCB_ENDPOINTS.je.kodtabell),
      expect.stringContaining(SCB_ENDPOINTS.je.raknaforetag),
      expect.stringContaining(SCB_ENDPOINTS.je.raknaforetag),
      expect.stringContaining(SCB_ENDPOINTS.je.hamtaforetag),
    ]);
    expect(calls[0]?.body).toEqual(toKodtabellBody("Företagsstatus"));
    expect(calls[2]?.body).toEqual({ Företagsstatus: "1" });
  });

  it("posts count and fetch to AE paths", async () => {
    const paths: string[] = [];
    const client = createTestClient(async (url) => {
      paths.push(new URL(url).pathname);
      if (url.includes("raknaarbetsstallen")) {
        return jsonResponse(200, 1);
      }
      return jsonResponse(200, [{ CfarNr: "1" }]);
    });
    await client.searchWorkplaces({ categories: [], variables: [] });
    expect(paths).toEqual([
      expect.stringContaining(SCB_ENDPOINTS.ae.raknaarbetsstallen),
      expect.stringContaining(SCB_ENDPOINTS.ae.hamtaarbetsstallen),
    ]);
  });
});

describe("error mapping", () => {
  it("maps 503 to SCB_UNAVAILABLE", async () => {
    const client = createTestClient(async () => textResponse(503, "http ERROR 503"));
    await expect(client.listCategories("company")).rejects.toMatchObject({
      code: "SCB_UNAVAILABLE",
      retryable: true,
    });
  });

  it("maps 401 to SCB_AUTH_ERROR", async () => {
    const client = createTestClient(async () => textResponse(401, "unauthorized"));
    await expect(client.listCategories("company")).rejects.toMatchObject({
      code: "SCB_AUTH_ERROR",
    });
  });

  it("maps 429 to SCB_RATE_LIMITED", async () => {
    const client = createTestClient(async () => textResponse(429, "too many"));
    await expect(client.listCategories("company")).rejects.toMatchObject({
      code: "SCB_RATE_LIMITED",
      retryable: true,
    });
  });

  it("maps kategori 400 to SCB_UNKNOWN_CATEGORY", async () => {
    const client = createTestClient(async () => jsonResponse(400, { message: "Okänd kategori" }));
    await expect(client.getCategoryValues("company", "nope")).rejects.toMatchObject({
      code: "SCB_UNKNOWN_CATEGORY",
    });
  });
});

describe("2,000-result guard", () => {
  it("does not fetch when count exceeds 2000", async () => {
    const paths: string[] = [];
    const client = createTestClient(async (url) => {
      paths.push(new URL(url).pathname);
      return jsonResponse(200, MAX_RESULTS + 1);
    });
    await expect(
      client.searchCompanies({ categories: [], variables: [] }),
    ).rejects.toMatchObject({
      code: "QUERY_TOO_BROAD",
      details: {
        count: MAX_RESULTS + 1,
        maxResults: MAX_RESULTS,
      },
    });
    expect(paths.some((path) => path.includes("hamtaforetag"))).toBe(false);
  });

  it("fetches when count is within the SCB limit", async () => {
    const client = createTestClient(async (url) => {
      if (url.includes("raknaforetag")) {
        return jsonResponse(200, 2);
      }
      return jsonResponse(200, [{ PeOrgNr: "1" }, { PeOrgNr: "2" }]);
    });
    const result = await client.searchCompanies({ categories: [], variables: [] });
    expect(result.count).toBe(2);
    expect(result.results).toHaveLength(2);
  });
});

describe("malformed SCB responses", () => {
  it("rejects non-JSON", async () => {
    const client = createTestClient(async () => textResponse(200, "<xml>nope</xml>"));
    await expect(client.listCategories("company")).rejects.toMatchObject({
      code: "SCB_RESPONSE_VALIDATION_ERROR",
    });
  });

  it("rejects unparsable count payloads", async () => {
    const client = createTestClient(async () => jsonResponse(200, { foo: "bar" }));
    await expect(client.countCompanies({ categories: [], variables: [] })).rejects.toMatchObject({
      code: "SCB_RESPONSE_VALIDATION_ERROR",
    });
  });

  it("rejects unparsable search payloads after a valid count", async () => {
    const client = createTestClient(async (url) => {
      if (url.includes("raknaforetag")) {
        return jsonResponse(200, 1);
      }
      return jsonResponse(200, { unexpected: true });
    });
    await expect(client.searchCompanies({ categories: [], variables: [] })).rejects.toMatchObject({
      code: "SCB_RESPONSE_VALIDATION_ERROR",
    });
  });
});

describe("rate limiting", () => {
  it("waits instead of sending an 11th call inside 10 seconds", async () => {
    const sleep = vi.fn(async () => {
      now += 10_001;
    });
    let now = 1_000;
    const limiter = new SlidingWindowRateLimiter(10, 10_000, () => now, sleep);
    const client = new ScbClient({
      baseUrl: "https://privateapi.scb.se/nv0101/v1/sokpavar",
      auth: testAuth(),
      skipCertLoad: true,
      rateLimiter: limiter,
      logLevel: "error",
      fetch: async () => jsonResponse(200, []),
    });
    for (let i = 0; i < 10; i += 1) {
      await client.listCategories("company");
    }
    expect(sleep).not.toHaveBeenCalled();
    await client.listCategories("company");
    expect(sleep).toHaveBeenCalled();
  });
});

describe("certificate/config validation", () => {
  it("throws SCB_AUTH_ERROR when the certificate file is missing", async () => {
    expect(
      () =>
        new ScbClient({
          baseUrl: "https://privateapi.scb.se/nv0101/v1/sokpavar",
          auth: {
            apiId: "A1",
            apiIdHeader: "api-id",
            certPath: "C:\\missing\\cert.pfx",
            certPassword: "x",
          },
          skipCertLoad: true,
        }),
    ).toThrow(ScbError);
  });
});
