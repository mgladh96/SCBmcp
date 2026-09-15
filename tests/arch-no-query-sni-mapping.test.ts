import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expandIndustryAliases, expandSearchTerms } from "../src/scb/compile/aliases.js";
import { looksLikeSniCode } from "../src/scb/discovery.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

const BANNED = [
  /CONSTRUCTION_SNI_/u,
  /\bisConstructionSniCode\b/u,
  /\bisConstructionIndustryQuery\b/u,
  /\bisConstructionNoiseLabel\b/u,
];

const QUERY_TO_CODE = [
  /bygg\s*[=:]\s*\[[^\]]*(["']F["']|["']41["'])/u,
  /byggverksamhet["']\s*:\s*\[[^\]]*["']41["']/u,
];

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTs(path));
    } else if (entry.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

describe("arch: no query→SNI-code mappings", () => {
  it("expandIndustryAliases emits search terms only, never SNI codes", () => {
    for (const query of ["bygg", "byggverksamhet", "restaurang", "transport", "IT", "handel"]) {
      const extra = expandIndustryAliases(query).filter((term) => term.trim().toLowerCase() !== query.trim().toLowerCase());
      for (const term of extra) {
        expect(looksLikeSniCode(term), `${query} → ${term}`).toBe(false);
      }
    }
    const bygg = expandSearchTerms("bygg");
    expect(bygg.some((term) => /byggverksamhet|byggnad|byggande/i.test(term))).toBe(true);
    expect(bygg.some((term) => looksLikeSniCode(term) && term.trim().toLowerCase() !== "bygg")).toBe(false);
  });

  it("aliases module has no construction code lists or query→code tables", () => {
    const src = readFileSync(join(SRC, "scb/compile/aliases.ts"), "utf8");
    for (const pattern of BANNED) {
      expect(src, pattern.source).not.toMatch(pattern);
    }
    expect(src).not.toMatch(/["']41["']\s*,\s*["']42["']\s*,\s*["']43["']/u);
    expect(src).not.toMatch(/\.\.\.\s*CONSTRUCTION_/u);
  });

  it("src does not reintroduce construction mapping helpers", () => {
    for (const file of walkTs(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of BANNED) {
        expect(text, `${file} ${pattern.source}`).not.toMatch(pattern);
      }
      for (const pattern of QUERY_TO_CODE) {
        expect(text, `${file} ${pattern.source}`).not.toMatch(pattern);
      }
    }
  });

  it("lookup_codes and compile industry share discoverCodes", () => {
    const tools = readFileSync(join(SRC, "mcp/tools.ts"), "utf8");
    const compile = readFileSync(join(SRC, "scb/compile/compile.ts"), "utf8");
    const industry = readFileSync(join(SRC, "scb/compile/industry.ts"), "utf8");
    expect(tools).toMatch(/discoverCodes/);
    expect(industry).toMatch(/discoverCodes/);
    expect(compile).not.toMatch(/selectIndustryCodes/);
    expect(industry).not.toMatch(/extractCodeRows/);
    expect(industry).not.toMatch(/["']41["']\s*,\s*["']42["']\s*,\s*["']43["']/u);
  });
});
