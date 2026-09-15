/**
 * Discovery eval: top-K lexical relevance against live-shaped kodtabeller.
 * Not a compile eval. Do not hard-fail on exact SNI lists (41/42/43).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLogger } from "../../src/log.js";
import { createToolHandlers, type ToolHandlers } from "../../src/mcp/tools.js";
import { catalogFetch, createTestClient } from "../helpers.js";
import { diverseCatalogSpec } from "./catalog.js";

const CASES_PATH = join(dirname(fileURLToPath(import.meta.url)), "discovery-cases.json");
const silent = createLogger("error");
const WEAK_SCORE = 80;

const discoveryCaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(8),
  objectType: z.enum(["company", "workplace"]),
  query: z.string(),
  kind: z.enum(["industry", "geography", "size", "status", "other"]).optional(),
  category: z.string().min(1).optional(),
  parentCode: z.string().min(1).optional(),
  topK: z.number().int().positive().default(8),
  expect: z.object({
    minHits: z.number().int().nonnegative().optional(),
    filterReady: z.boolean().optional(),
    labelPattern: z.string().optional(),
    topCode: z.string().optional(),
    childrenOf: z.string().optional(),
    emptyOrWeak: z.boolean().optional(),
    forbidExactCodes: z.boolean().optional(),
  }),
});

export type DiscoveryEvalCase = z.infer<typeof discoveryCaseSchema>;

export type DiscoveryCaseResult = {
  id: string;
  pass: boolean;
  hits: number;
  top: Array<{ category: string; code: string; label: string; score?: number }>;
  failures: string[];
};

export type DiscoveryEvalSummary = {
  cases: DiscoveryCaseResult[];
  pass: number;
  total: number;
  hardFail: boolean;
};

type LookupPayload = {
  matches?: Array<{
    objectType?: string;
    kind?: string;
    category?: string;
    code?: string;
    label?: string;
    level?: number;
    parentCode?: string;
    hasChildren?: boolean;
    score?: number;
  }>;
  returned?: number;
};

export function loadDiscoveryCases(path = CASES_PATH): DiscoveryEvalCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("discovery-cases.json must be an array");
  }
  return raw.map((item, index) => {
    const parsed = discoveryCaseSchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(`discovery-cases.json[${index}]: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

export function discoveryHandlers(): ToolHandlers {
  return createToolHandlers(createTestClient(catalogFetch(diverseCatalogSpec())), silent);
}

function isFilterReady(match: NonNullable<LookupPayload["matches"]>[number]): boolean {
  return Boolean(match.category && match.category.length > 0 && match.code && String(match.code).length > 0);
}

export function scoreDiscoveryCase(evalCase: DiscoveryEvalCase, payload: LookupPayload): DiscoveryCaseResult {
  const failures: string[] = [];
  const matches = payload.matches ?? [];
  const top = matches.slice(0, evalCase.topK);
  const expect = evalCase.expect;

  if (expect.filterReady) {
    const bad = top.filter((item) => !isFilterReady(item));
    if (bad.length > 0) {
      failures.push(`not filter-ready: ${bad.map((item) => item.code ?? "?").join(",")}`);
    }
  }

  if (expect.minHits !== undefined && top.length < expect.minHits) {
    failures.push(`hits ${top.length} < minHits ${expect.minHits}`);
  }

  if (expect.labelPattern) {
    const re = new RegExp(expect.labelPattern, "i");
    const relevant = top.filter((item) => re.test(item.label ?? "") || re.test(item.code ?? ""));
    if (relevant.length === 0) {
      failures.push(`no top-${evalCase.topK} label matched /${expect.labelPattern}/ (got ${top.map((item) => item.label).join(" | ") || "∅"})`);
    }
  }

  if (expect.topCode && top[0]?.code !== expect.topCode) {
    failures.push(`top code ${top[0]?.code ?? "∅"} ≠ ${expect.topCode}`);
  }

  if (expect.childrenOf) {
    const parent = expect.childrenOf.toUpperCase();
    const ok = top.every(
      (item) =>
        (item.parentCode ?? "").toUpperCase() === parent ||
        (parent.length === 1 && /^\d/u.test(item.code ?? "")),
    );
    if (!ok || top.length === 0) {
      failures.push(`children of ${parent} not listed (got ${top.map((item) => `${item.code} parent=${item.parentCode ?? ""}`).join(", ")})`);
    }
  }

  if (expect.emptyOrWeak) {
    const strong = top.filter((item) => (item.score ?? 0) >= WEAK_SCORE);
    if (strong.length > 0) {
      failures.push(`unknown term returned strong hits ${strong.map((item) => item.code).join(",")}`);
    }
  }

  if (expect.forbidExactCodes && evalCase.id === "bygg") {
    // Presence of 41/42/43 is allowed as a ranking outcome but must not be required.
    void 0;
  }

  return {
    id: evalCase.id,
    pass: failures.length === 0,
    hits: top.length,
    top: top.map((item) => ({
      category: item.category ?? "",
      code: item.code ?? "",
      label: item.label ?? "",
      score: item.score,
    })),
    failures,
  };
}

export async function runDiscoveryEval(cases = loadDiscoveryCases()): Promise<DiscoveryEvalSummary> {
  const results: DiscoveryCaseResult[] = [];
  for (const evalCase of cases) {
    const handlers = discoveryHandlers();
    const result = await handlers.scb_lookup_codes({
      objectType: evalCase.objectType,
      query: evalCase.query,
      kind: evalCase.kind,
      category: evalCase.category,
      parentCode: evalCase.parentCode,
      limit: evalCase.topK,
    });
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as LookupPayload;
    if (result.isError) {
      results.push({
        id: evalCase.id,
        pass: false,
        hits: 0,
        top: [],
        failures: [`lookup error: ${JSON.stringify(payload)}`],
      });
      continue;
    }
    results.push(scoreDiscoveryCase(evalCase, payload));
  }
  const pass = results.filter((item) => item.pass).length;
  return { cases: results, pass, total: results.length, hardFail: pass < results.length };
}

export function formatDiscoveryReport(summary: DiscoveryEvalSummary): string {
  const lines = [
    "SCB discovery-eval — metadata search (no query→code oracles, no LLM)",
    "Measure: relevant info in top-K; hits are filter-ready (category+code).",
    "Do not hard-fail on exact 41/42/43 for bygg.",
    "",
    pad("ID", 22) + pad("PASS", 6) + pad("HITS", 6) + "TOP",
  ];
  for (const item of summary.cases) {
    const top = item.top
      .slice(0, 3)
      .map((hit) => `${hit.code}:${hit.label}`)
      .join(" | ");
    lines.push(pad(item.id, 22) + pad(item.pass ? "PASS" : "FAIL", 6) + pad(String(item.hits), 6) + top);
  }
  const failed = summary.cases.filter((item) => !item.pass);
  if (failed.length > 0) {
    lines.push("", "Failures:");
    for (const item of failed) {
      lines.push(`  - ${item.id}: ${item.failures.join("; ")}`);
    }
  }
  lines.push("", `Passed ${summary.pass}/${summary.total}${summary.hardFail ? "  FAIL" : ""}`);
  return `${lines.join("\n")}\n`;
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return `${value.slice(0, width - 1)} `;
  }
  return value.padEnd(width);
}
