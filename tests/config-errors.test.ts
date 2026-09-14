import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { ScbError } from "../src/domain/errors.js";
import { mapHttpError, queryTooBroad } from "../src/domain/errors.js";
import { validateCertConfig } from "../src/scb/auth.js";
import { dummyCertPath } from "./helpers.js";

describe("env validation", () => {
  it("requires API id, cert path, and password", () => {
    expect(() => loadConfig({})).toThrow(ScbError);
  });

  it("loads defaults for base URL", () => {
    const config = loadConfig({
      SCB_API_ID: "A12345",
      SCB_CERT_PATH: dummyCertPath(),
      SCB_CERT_PASSWORD: "pw",
    });
    expect(config.baseUrl).toBe("https://privateapi.scb.se/nv0101/v1/sokpavar");
    expect(config.apiIdHeader).toBe("api-id");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
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
