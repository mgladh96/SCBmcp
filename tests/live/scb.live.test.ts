import { describe, expect, it } from "vitest";
import { ScbClient } from "../../src/scb/client.js";
import { loadConfig } from "../../src/config/env.js";

const live = process.env.SCB_LIVE_TESTS === "true";

describe.skipIf(!live)("live SCB Allmänna företagsregister", () => {
  it("lists JE categories with the configured certificate", async () => {
    const config = loadConfig();
    const client = new ScbClient({
      baseUrl: config.baseUrl,
      auth: {
        apiId: config.apiId,
        apiIdHeader: config.apiIdHeader,
        certPath: config.certPath,
        certPassword: config.certPassword,
      },
    });
    const categories = await client.listCategories("company");
    expect(categories).toBeDefined();
  });
});
