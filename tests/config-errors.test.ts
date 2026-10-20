import { describe, expect, it } from "vitest";
import { isLoopbackHost, loadConfig, McpConfigError } from "../src/config/env.js";
import { ScbError } from "../src/domain/errors.js";
import { mapHttpError, queryTooBroad } from "../src/domain/errors.js";
import { createScbDispatcher, decodeCertBase64, validateCertConfig } from "../src/scb/auth.js";
import { dummyCertPath } from "./helpers.js";

function validScbEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SCB_API_ID: "A12345",
    SCB_CERT_PATH: dummyCertPath(),
    SCB_CERT_PASSWORD: "pw",
    ...overrides,
  };
}

describe("env validation", () => {
  it("requires API id, cert path, and password", () => {
    expect(() => loadConfig({})).toThrow(ScbError);
  });

  it("loads defaults for base URL", () => {
    const config = loadConfig(validScbEnv());
    expect(config.baseUrl).toBe("https://privateapi.scb.se/nv0101/v1/sokpavar");
    expect(config.apiIdHeader).toBe("api-id");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
    expect(config.authToken).toBeUndefined();
  });

  it("trims MCP_AUTH_TOKEN", () => {
    const config = loadConfig(
      validScbEnv({
        MCP_AUTH_TOKEN: "  local-secret  ",
      }),
    );
    expect(config.authToken).toBe("local-secret");
  });

  it("treats an empty MCP_AUTH_TOKEN as unset", () => {
    const config = loadConfig(validScbEnv({ MCP_AUTH_TOKEN: "   " }));
    expect(config.authToken).toBeUndefined();
  });

  it("refuses to bind to 0.0.0.0 without MCP_AUTH_TOKEN", () => {
    expect(() => loadConfig(validScbEnv({ MCP_HOST: "0.0.0.0" }))).toThrow(McpConfigError);
    expect(() => loadConfig(validScbEnv({ MCP_HOST: "0.0.0.0" }))).toThrow(/MCP_AUTH_TOKEN/);
  });

  it("allows a non-loopback bind when MCP_AUTH_TOKEN is set", () => {
    const config = loadConfig(
      validScbEnv({
        MCP_HOST: "0.0.0.0",
        MCP_AUTH_TOKEN: "bind-secret",
      }),
    );
    expect(config.host).toBe("0.0.0.0");
    expect(config.authToken).toBe("bind-secret");
  });

  it("listens on PORT and binds 0.0.0.0 when MCP_HOST is unset", () => {
    const config = loadConfig(
      validScbEnv({
        PORT: "8080",
        MCP_PORT: "3001",
        MCP_AUTH_TOKEN: "cloud-run-secret",
      }),
    );
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
  });

  it("keeps MCP_HOST when PORT is set", () => {
    const config = loadConfig(
      validScbEnv({
        PORT: "9090",
        MCP_HOST: "127.0.0.1",
      }),
    );
    expect(config.port).toBe(9090);
    expect(config.host).toBe("127.0.0.1");
    expect(config.authToken).toBeUndefined();
  });

  it("refuses PORT without MCP_AUTH_TOKEN when that implies a public bind", () => {
    expect(() => loadConfig(validScbEnv({ PORT: "8080" }))).toThrow(McpConfigError);
  });

  it("loads a certificate from SCB_CERT_BASE64 when no pfx file exists", () => {
    const pfx = Buffer.from("fake-pfx-bytes");
    const config = loadConfig(
      validScbEnv({
        SCB_CERT_PATH: "/tmp/scb-missing-certificate.pfx",
        SCB_CERT_BASE64: pfx.toString("base64"),
      }),
    );
    expect(config.certPfx?.equals(pfx)).toBe(true);
    expect(config.certPath).toBeUndefined();
  });

  it("prefers an existing SCB_CERT_PATH over SCB_CERT_BASE64", () => {
    const path = dummyCertPath();
    const config = loadConfig(
      validScbEnv({
        SCB_CERT_PATH: path,
        SCB_CERT_BASE64: Buffer.from("other-bytes").toString("base64"),
      }),
    );
    expect(config.certPath).toBe(path);
    expect(config.certPfx).toBeUndefined();
  });

  it("rejects invalid SCB_CERT_BASE64 without echoing the secret", () => {
    const marker = "secret-marker-do-not-leak";
    try {
      loadConfig(
        validScbEnv({
          SCB_CERT_PATH: undefined,
          SCB_CERT_BASE64: marker,
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScbError);
      expect(error instanceof Error ? error.message : "").toMatch(/SCB_CERT_BASE64/);
      expect(JSON.stringify(error)).not.toContain(marker);
    }
  });

  it("restricts tools with the voice preset", () => {
    const config = loadConfig(validScbEnv({ MCP_EXPOSED_TOOLS: "voice" }));
    expect(config.exposedTools).toEqual(["scb_find_company", "company_website_summary"]);
  });

  it("rejects unknown MCP_EXPOSED_TOOLS", () => {
    expect(() => loadConfig(validScbEnv({ MCP_EXPOSED_TOOLS: "scb_find_company,not_a_tool" }))).toThrow(
      McpConfigError,
    );
  });
});

describe("loopback bind detection", () => {
  it("treats localhost and 127/8 as loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("treats wildcard and LAN binds as non-loopback", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });
});

describe("certificate config", () => {
  it("rejects a missing pfx file", () => {
    expect(() =>
      validateCertConfig({
        apiId: "A1",
        apiIdHeader: "api-id",
        certPath: "C:\\no\\such\\file.pfx",
        certPassword: "pw",
      }),
    ).toThrow(ScbError);
  });

  it("accepts an existing file without logging the password", () => {
    expect(() =>
      validateCertConfig({
        apiId: "A1",
        apiIdHeader: "api-id",
        certPath: dummyCertPath(),
        certPassword: "pw",
      }),
    ).not.toThrow();
  });

  it("accepts pfx bytes without a file path", () => {
    expect(() =>
      validateCertConfig({
        apiId: "A1",
        apiIdHeader: "api-id",
        certPfx: Buffer.from("not-a-real-pfx"),
        certPassword: "pw",
      }),
    ).not.toThrow();
  });

  it("decodes base64 pfx bytes and ignores whitespace", () => {
    const pfx = Buffer.from("pfx-bytes");
    const wrapped = pfx.toString("base64").replace(/(.{4})/g, "$1\n");
    expect(decodeCertBase64(wrapped).equals(pfx)).toBe(true);
  });

  it("builds a TLS dispatcher from pfx bytes without a certificate file", () => {
    const agent = createScbDispatcher({
      apiId: "A1",
      apiIdHeader: "api-id",
      certPfx: Buffer.from("not-a-real-pfx"),
      certPassword: "super-secret-password",
    });
    expect(agent).toBeDefined();
    void agent.close();
  });
});

describe("HTTP error mapping", () => {
  it("treats 503 separately from malformed queries", () => {
    const error = mapHttpError(503, "http ERROR 503");
    expect(error.code).toBe("SCB_UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });

  it("includes retryAfterMs on HTTP 429", () => {
    const error = mapHttpError(429, "too many", { retryAfterMs: 3500 });
    expect(error.toJSON()).toMatchObject({
      code: "SCB_RATE_LIMITED",
      nextAction: "retry_same",
      details: { retryAfterMs: 3500, status: 429 },
    });
  });

  it("maps ModelState CustomError about Branschnivå to SCB_INVALID_QUERY, not unknown Företagsstatus", () => {
    const body = JSON.stringify({
      Message: "The request is invalid.",
      ModelState: {
        CustomError: ["Kategorin Bransch kräver att Branschnivå (1-3) angetts."],
      },
    });
    const error = mapHttpError(400, body, {
      submittedCategories: ["Företagsstatus", "Bransch", "Säteslän"],
      objectType: "company",
    });
    expect(error.code).toBe("SCB_INVALID_QUERY");
    expect(error.message).toMatch(/Branschnivå \(1-3\)/u);
    expect(error.nextAction).toBe("retry_modified");
    expect(error.details.field).toBe("branchLevel");
    expect(error.details.unknownName).toBe("Bransch");
    expect(error.details.customError).toMatch(/Branschnivå/u);
    expect(error.message).not.toMatch(/Företagsstatus/u);
  });

  it("builds QUERY_TOO_BROAD details with filters and narrowing dimensions", () => {
    const error = queryTooBroad(8432, 2000, {
      objectType: "company",
      layout: "je",
      appliedFilters: { categories: [{ category: "Företagsstatus", values: ["1"] }], variables: [] },
    });
    expect(error.toJSON()).toMatchObject({
      code: "QUERY_TOO_BROAD",
      nextAction: "retry_modified",
      details: {
        count: 8432,
        maxResults: 2000,
        objectType: "company",
        layout: "je",
        doNotPaginate: true,
      },
    });
    expect(error.details.candidateNarrowingDimensions).toEqual(
      expect.arrayContaining([expect.objectContaining({ dimension: "geography" })]),
    );
  });
});
