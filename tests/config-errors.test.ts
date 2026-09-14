import { describe, expect, it } from "vitest";
import { isLoopbackHost, loadConfig, McpConfigError } from "../src/config/env.js";
import { ScbError } from "../src/domain/errors.js";
import { mapHttpError, queryTooBroad } from "../src/domain/errors.js";
import { validateCertConfig } from "../src/scb/auth.js";
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
});

describe("HTTP error mapping", () => {
  it("treats 503 separately from malformed queries", () => {
    const error = mapHttpError(503, "http ERROR 503");
    expect(error.code).toBe("SCB_UNAVAILABLE");
    expect(error.retryable).toBe(true);
  });

  it("builds QUERY_TOO_BROAD details", () => {
    const error = queryTooBroad(8432, 2000);
    expect(error.toJSON()).toMatchObject({
      code: "QUERY_TOO_BROAD",
      details: { count: 8432, maxResults: 2000 },
    });
  });
});
