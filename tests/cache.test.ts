import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/scb/cache.js";

describe("TtlCache", () => {
  it("expires entries after ttl", () => {
    let now = 1_000;
    const cache = new TtlCache<number>(5_000, () => now);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    now = 6_000;
    expect(cache.get("a")).toBeUndefined();
  });
});
