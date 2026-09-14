import { describe, expect, it } from "vitest";
import { extractBearerToken, mcpTokensEqual } from "../src/mcp/auth.js";

describe("MCP token comparison", () => {
  it("accepts equal tokens", () => {
    expect(mcpTokensEqual("abc", "abc")).toBe(true);
  });

  it("rejects mismatched tokens without throwing on length differences", () => {
    expect(mcpTokensEqual("short", "much-longer-secret")).toBe(false);
    expect(mcpTokensEqual("abc", "abd")).toBe(false);
  });
});

describe("Bearer extraction", () => {
  it("reads a Bearer token", () => {
    expect(extractBearerToken("Bearer secret-value")).toBe("secret-value");
  });

  it("rejects missing or non-bearer credentials", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("Basic abc")).toBeUndefined();
  });
});
