import { describe, expect, it } from "vitest";
import { loadDiscoveryCases, runDiscoveryEval } from "./discovery-runner.js";

describe("discovery eval", () => {
  it("covers core queries without code-list oracles for bygg", () => {
    const cases = loadDiscoveryCases();
    expect(cases.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "bygg",
        "restaurang",
        "transport",
        "it",
        "sni-code-41",
        "parent-children-F",
        "jamtland",
        "lanlista",
        "stadning",
        "markentreprenad",
        "employee-size",
        "unknown-term",
      ]),
    );
    const bygg = cases.find((item) => item.id === "bygg");
    expect(bygg?.expect).not.toHaveProperty("mustIncludeCodes");
    expect(JSON.stringify(bygg)).not.toMatch(/"41"\s*,\s*"42"\s*,\s*"43"/u);
  });

  it("passes top-K relevance checks on mocked live-shaped fixtures", async () => {
    const summary = await runDiscoveryEval();
    expect(summary.hardFail, summary.cases.filter((item) => !item.pass).flatMap((item) => item.failures).join("; ")).toBe(
      false,
    );
    expect(summary.pass).toBe(summary.total);
  });
});
