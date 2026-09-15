/**
 * Blind-eval runner: StructuredQuery → scb_compile_query + scb_count_then_fetch.
 * No NL parser. Product features frozen — no new MCP tools.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fold } from "../../src/domain/catalog.js";
import { createLogger } from "../../src/log.js";
import { createToolHandlers, type ToolHandlers } from "../../src/mcp/tools.js";
import { unionBandRange, rangeRelation } from "../../src/scb/compile/bands.js";
import {
  structuredQuerySchema,
  type CoverageEntry,
  type CoverageRelation,
  type StructuredQuery,
  type StructuredQueryInput,
} from "../../src/scb/compile/index.js";
import { loadConfig, loadEnvFiles } from "../../src/config/env.js";
import { ScbClient } from "../../src/scb/client.js";
import { layoutFor } from "../../src/scb/types.js";
import { catalogAndSearchFetch, createTestClient } from "../helpers.js";
import { LIVE_AE_SEARCH_ROW, LIVE_JE_SEARCH_ROW } from "../fixtures/live-scb-metadata.js";
import { catalogSpecFor } from "./catalog.js";

const CASES_PATH = join(dirname(fileURLToPath(import.meta.url)), "blind-cases.json");

const coverageRelationSchema = z.enum(["exact", "superset", "subset", "partial", "unrepresentable"]);

const fetchOutcomeSchema = z.enum(["success", "no_matches", "too_broad", "compile_fail"]);

export const evalCaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(8),
  tier: z.enum(["golden", "blind"]),
  live: z.boolean().optional(),
  fixture: z.enum(["construction", "diverse"]).optional().default("diverse"),
  query: z.unknown(),
  mock: z
    .object({
      count: z.number().int().nonnegative().optional(),
      results: z.array(z.unknown()).optional(),
    })
    .optional(),
  expect: z.object({
    objectType: z.enum(["company", "workplace"]),
    layout: z.enum(["je", "ae"]),
    geographyCategoryContains: z.string().min(1).optional(),
    industryMustIncludeCodes: z.array(z.string().min(1)).optional(),
    industryMustNotIncludeNoise: z.array(z.string().min(1)).optional(),
    employeeRelation: coverageRelationSchema.optional(),
    forbidFalseExact: z.boolean().optional().default(true),
    compileOk: z.boolean().optional(),
    fetchOutcome: fetchOutcomeSchema.optional(),
    unresolvedConstraint: z.enum(["geography", "industry", "employees", "status", "fields"]).optional(),
    minToolCallsMax: z.number().int().positive().optional().default(2),
  }),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

export type CaseResult = {
  id: string;
  tier: "golden" | "blind";
  live: boolean;
  pass: boolean;
  e2e: boolean;
  falseExact: boolean;
  compileOk: boolean;
  unresolved: boolean;
  fetchOutcome: "success" | "no_matches" | "too_broad" | "compile_fail" | "error";
  objectTypeOk: boolean;
  layoutOk: boolean;
  wrongCategoryClass: boolean;
  industryNoise: boolean;
  toolCalls: number;
  payloadChars: number;
  payloadBytes: number;
  failures: string[];
};

export type EvalSummary = {
  mode: "mocked" | "live";
  cases: CaseResult[];
  goldenTotal: number;
  goldenPass: number;
  blindTotal: number;
  blindPass: number;
  blindE2ERate: number;
  falseExactCount: number;
  compileOkBlind: number;
  avgPayloadChars: number;
  hardFail: boolean;
  skippedLive?: string;
};

type CompilePayload = {
  ok?: boolean;
  objectType?: string;
  layout?: string;
  filters?: {
    categories?: Array<{ category: string; values: string[]; branchLevel?: number }>;
  };
  resolved?: {
    layout?: string;
    geography?: { category?: string; codes?: Array<{ code: string }> };
    industry?: { category?: string; codes?: Array<{ code: string }> };
    employees?: { category?: string; bands?: Array<{ min: number; max: number | null }> };
    status?: { category?: string };
    fields?: Record<string, string[]>;
  };
  coverage?: CoverageEntry[];
  unresolved?: Array<{ constraint: string; reason?: string }>;
  warnings?: string[];
};

type ToolJson = {
  isError?: boolean;
  payload: Record<string, unknown>;
  text: string;
};

const silent = createLogger("error");

export function loadEvalCases(path = CASES_PATH): EvalCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("blind-cases.json must be an array");
  }
  return raw.map((item, index) => {
    const parsed = evalCaseSchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(`blind-cases.json[${index}]: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

export function defaultMockCount(fetchOutcome: z.infer<typeof fetchOutcomeSchema> | undefined): number {
  if (fetchOutcome === "no_matches") {
    return 0;
  }
  if (fetchOutcome === "too_broad") {
    return 2500;
  }
  if (fetchOutcome === "compile_fail") {
    return 0;
  }
  return 8;
}

export function mockedHandlersFor(evalCase: EvalCase): ToolHandlers {
  const fetchOutcome = evalCase.expect.fetchOutcome;
  const count = evalCase.mock?.count ?? defaultMockCount(fetchOutcome);
  const objectType = evalCase.expect.objectType;
  const results =
    evalCase.mock?.results ??
    [objectType === "workplace" ? LIVE_AE_SEARCH_ROW : LIVE_JE_SEARCH_ROW];
  const spec = catalogSpecFor(evalCase.fixture);
  return createToolHandlers(
    createTestClient(catalogAndSearchFetch(spec, { count, results })),
    silent,
  );
}

export function tryLiveClient(): { client: ScbClient } | { skipped: string } {
  if (process.env.SCB_LIVE_TESTS !== "true") {
    return { skipped: "SCB_LIVE_TESTS is not true" };
  }
  try {
    loadEnvFiles();
    const config = loadConfig();
    if (!existsSync(config.certPath)) {
      return { skipped: `cert not found at ${config.certPath}` };
    }
    return {
      client: new ScbClient({
        baseUrl: config.baseUrl,
        auth: {
          apiId: config.apiId,
          apiIdHeader: config.apiIdHeader,
          certPath: config.certPath,
          certPassword: config.certPassword,
        },
        logLevel: "error",
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { skipped: `live client unavailable: ${message}` };
  }
}

async function callTool(
  handlers: ToolHandlers,
  name: "scb_compile_query" | "scb_count_then_fetch",
  input: unknown,
): Promise<ToolJson> {
  const result = await handlers[name](input);
  const text = result.content[0]?.text ?? "";
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = { parseError: true, text };
  }
  return { isError: result.isError === true, payload, text };
}

function industryCodes(compiled: CompilePayload): string[] {
  const fromResolved = compiled.resolved?.industry?.codes?.map((item) => item.code) ?? [];
  if (fromResolved.length > 0) {
    return fromResolved;
  }
  const fromFilters =
    compiled.filters?.categories
      ?.filter((item) => fold(item.category).includes("bransch"))
      .flatMap((item) => item.values) ?? [];
  return fromFilters;
}

function employeeCoverage(compiled: CompilePayload): CoverageEntry | undefined {
  return compiled.coverage?.find((item) => item.constraint === "employees");
}

function actualEmployeeRelation(compiled: CompilePayload, query: StructuredQuery): CoverageRelation | undefined {
  const slot = query.employees;
  if (!slot || (slot.min === undefined && slot.max === undefined)) {
    return undefined;
  }
  const bands = compiled.resolved?.employees?.bands;
  if (!bands || bands.length === 0) {
    const entry = employeeCoverage(compiled);
    return entry?.relation === "unrepresentable" ? "unrepresentable" : undefined;
  }
  const union = unionBandRange(bands);
  if (!union) {
    return "unrepresentable";
  }
  return rangeRelation(slot.min ?? 0, slot.max ?? Number.POSITIVE_INFINITY, union.min, union.max);
}

export function detectFalseExact(compiled: CompilePayload, query: StructuredQuery): boolean {
  for (const entry of compiled.coverage ?? []) {
    if (entry.exact === true && entry.relation !== "exact") {
      return true;
    }
  }
  if (!query.employees) {
    return false;
  }
  const entry = employeeCoverage(compiled);
  if (!entry) {
    return false;
  }
  if (entry.exact !== true && entry.relation !== "exact") {
    return false;
  }
  const actual = actualEmployeeRelation(compiled, query);
  return actual !== "exact";
}

function categoryMatchesExpect(category: string, needle: string): boolean {
  const hay = fold(category);
  const n = fold(needle);
  if (n === "lan") {
    return hay === "lan" || (hay.endsWith("lan") && !hay.includes("sates") && !hay.includes("kommun"));
  }
  if (n === "kommun") {
    return hay === "kommun" || (hay.includes("kommun") && !hay.includes("sates"));
  }
  return hay.includes(n);
}

function geographyCategory(compiled: CompilePayload): string {
  return compiled.resolved?.geography?.category ?? "";
}

function employeeCategory(compiled: CompilePayload): string {
  return compiled.resolved?.employees?.category ?? "";
}

function statusCategoryInFilters(compiled: CompilePayload): boolean {
  return (compiled.filters?.categories ?? []).some((item) => fold(item.category).includes("status"));
}

function fetchOutcomeFromTool(fetchResult: ToolJson | undefined, compileOk: boolean): CaseResult["fetchOutcome"] {
  if (!compileOk) {
    return "compile_fail";
  }
  if (!fetchResult) {
    return "compile_fail";
  }
  if (!fetchResult.isError) {
    return "success";
  }
  const code = String(fetchResult.payload.code ?? "");
  if (code === "SCB_NO_MATCHES") {
    return "no_matches";
  }
  if (code === "QUERY_TOO_BROAD") {
    return "too_broad";
  }
  if (code === "SCB_INVALID_QUERY") {
    return "compile_fail";
  }
  return "error";
}

export function scoreCase(
  evalCase: EvalCase,
  query: StructuredQuery,
  compiled: CompilePayload,
  options: {
    toolCalls: number;
    payloadChars: number;
    payloadBytes: number;
    fetchOutcome: CaseResult["fetchOutcome"];
  },
): CaseResult {
  const failures: string[] = [];
  const expect = evalCase.expect;
  const compileOk = compiled.ok === true;
  const unresolved = (compiled.unresolved?.length ?? 0) > 0;
  const layout = String(compiled.layout ?? compiled.resolved?.layout ?? layoutFor(query.objectType));
  const objectType = String(compiled.objectType ?? query.objectType);
  const objectTypeOk = objectType === expect.objectType;
  const layoutOk = layout === expect.layout;
  if (!objectTypeOk) {
    failures.push(`objectType ${objectType} ≠ ${expect.objectType}`);
  }
  if (!layoutOk) {
    failures.push(`layout ${layout} ≠ ${expect.layout}`);
  }

  const expectedCompileOk = expect.compileOk ?? expect.fetchOutcome !== "compile_fail";
  if (compileOk !== expectedCompileOk) {
    failures.push(`compileOk=${compileOk}, expected ${expectedCompileOk}`);
  }

  const expectedFetch = expect.fetchOutcome ?? (expectedCompileOk ? "success" : "compile_fail");
  if (options.fetchOutcome !== expectedFetch) {
    failures.push(`fetchOutcome ${options.fetchOutcome} ≠ ${expectedFetch}`);
  }

  if (expect.unresolvedConstraint) {
    const inUnresolved = compiled.unresolved?.some((item) => item.constraint === expect.unresolvedConstraint);
    const inCoverage = compiled.coverage?.some(
      (item) => item.constraint === expect.unresolvedConstraint && item.relation === "unrepresentable",
    );
    if (!inUnresolved && !inCoverage) {
      failures.push(`missing unresolved/unrepresentable ${expect.unresolvedConstraint}`);
    }
  }

  const geoCat = geographyCategory(compiled);
  const geoFold = fold(geoCat);
  if (expect.geographyCategoryContains && compileOk) {
    if (!categoryMatchesExpect(geoCat, expect.geographyCategoryContains)) {
      failures.push(`geography category "${geoCat}" does not contain ${expect.geographyCategoryContains}`);
    }
  }

  let wrongCategoryClass = false;
  if (query.geography && compileOk) {
    if (query.objectType === "company" && query.geography.type === "county") {
      if (geoFold === "lan" || (geoFold.includes("lan") && !geoFold.includes("sates"))) {
        wrongCategoryClass = true;
        failures.push(`JE county used AE geography "${geoCat}"`);
      }
    }
    if (query.objectType === "workplace" && query.geography.type === "county") {
      if (geoFold.includes("sates")) {
        wrongCategoryClass = true;
        failures.push(`AE county used JE seat geography "${geoCat}"`);
      }
    }
    if (query.objectType === "company" && query.geography.type === "municipality") {
      if (geoFold === "kommun" || (geoFold.includes("kommun") && !geoFold.includes("sates"))) {
        wrongCategoryClass = true;
        failures.push(`JE municipality used AE Kommun "${geoCat}"`);
      }
    }
    if (query.objectType === "workplace" && query.geography.type === "municipality") {
      if (geoFold.includes("sates")) {
        wrongCategoryClass = true;
        failures.push(`AE municipality used JE Säteskommun "${geoCat}"`);
      }
    }
  }

  const empCat = employeeCategory(compiled);
  if (query.employees && fold(empCat).includes("omsattning")) {
    wrongCategoryClass = true;
    failures.push(`employees mapped to revenue class "${empCat}"`);
  }
  if (
    query.employees &&
    compileOk &&
    empCat &&
    !fold(empCat).includes("anst") &&
    !fold(empCat).includes("storleksklass")
  ) {
    wrongCategoryClass = true;
    failures.push(`employees mapped to unexpected category "${empCat}"`);
  }

  const codes = industryCodes(compiled);
  if (expect.industryMustIncludeCodes && compileOk) {
    const missing = expect.industryMustIncludeCodes.filter((code) => !codes.includes(code));
    if (missing.length > 0) {
      failures.push(`industry missing codes ${missing.join(",")} (got ${codes.join(",") || "∅"})`);
    }
  }
  let industryNoise = false;
  if (expect.industryMustNotIncludeNoise) {
    const noise = expect.industryMustNotIncludeNoise.filter((code) => codes.includes(code));
    if (noise.length > 0) {
      industryNoise = true;
      failures.push(`industry noise codes ${noise.join(",")} (applied ${codes.join(",")})`);
    }
  }

  const empEntry = employeeCoverage(compiled);
  const actualEmp = actualEmployeeRelation(compiled, query);
  if (expect.employeeRelation) {
    const reported = empEntry?.relation ?? (compileOk ? undefined : "unrepresentable");
    if (reported !== expect.employeeRelation && actualEmp !== expect.employeeRelation) {
      failures.push(
        `employeeRelation reported=${reported ?? "?"} actual=${actualEmp ?? "?"} expected=${expect.employeeRelation}`,
      );
    }
  }

  const falseExact = detectFalseExact(compiled, query);
  if (falseExact) {
    failures.push(
      `falseExact: coverage claimed exact but applied employees ${JSON.stringify(empEntry?.applied)} vs requested ${JSON.stringify(query.employees)}`,
    );
  }

  if (query.status === "any" && statusCategoryInFilters(compiled)) {
    failures.push("status=any still applied a status category");
  }
  if (compileOk && query.status !== "any" && !statusCategoryInFilters(compiled) && !compiled.resolved?.status) {
    failures.push("status=active missing status filter");
  }

  const maxTools = expect.minToolCallsMax;
  if (options.toolCalls > maxTools) {
    failures.push(`toolCalls ${options.toolCalls} > max ${maxTools}`);
  }

  const e2e = failures.length === 0;
  return {
    id: evalCase.id,
    tier: evalCase.tier,
    live: false,
    pass: e2e,
    e2e,
    falseExact,
    compileOk,
    unresolved,
    fetchOutcome: options.fetchOutcome,
    objectTypeOk,
    layoutOk,
    wrongCategoryClass,
    industryNoise,
    toolCalls: options.toolCalls,
    payloadChars: options.payloadChars,
    payloadBytes: options.payloadBytes,
    failures,
  };
}

export async function runOneCase(evalCase: EvalCase, handlers: ToolHandlers): Promise<CaseResult> {
  const parsed = structuredQuerySchema.safeParse(evalCase.query);
  if (!parsed.success) {
    return {
      id: evalCase.id,
      tier: evalCase.tier,
      live: false,
      pass: false,
      e2e: false,
      falseExact: false,
      compileOk: false,
      unresolved: true,
      fetchOutcome: "error",
      objectTypeOk: false,
      layoutOk: false,
      wrongCategoryClass: false,
      industryNoise: false,
      toolCalls: 0,
      payloadChars: 0,
      payloadBytes: 0,
      failures: [`StructuredQuery invalid: ${parsed.error.message}`],
    };
  }
  const query = parsed.data;
  const input = evalCase.query as StructuredQueryInput;

  let toolCalls = 0;
  const compileResult = await callTool(handlers, "scb_compile_query", input);
  toolCalls += 1;
  const compiled = compileResult.payload as CompilePayload;

  let fetchResult: ToolJson | undefined;
  const expectFetch = evalCase.expect.fetchOutcome ?? (evalCase.expect.compileOk === false ? "compile_fail" : "success");
  if (expectFetch !== "compile_fail" || compiled.ok === true) {
    fetchResult = await callTool(handlers, "scb_count_then_fetch", input);
    toolCalls += 1;
  }

  const texts = [compileResult.text, fetchResult?.text ?? ""];
  const payloadText = texts.join("");
  const payloadBytes = Buffer.byteLength(payloadText, "utf8");
  const fetchOutcome = fetchOutcomeFromTool(fetchResult, compiled.ok === true);

  return scoreCase(evalCase, query, compiled, {
    toolCalls,
    payloadChars: payloadText.length,
    payloadBytes,
    fetchOutcome,
  });
}

function summarize(mode: EvalSummary["mode"], cases: CaseResult[], skippedLive?: string): EvalSummary {
  const golden = cases.filter((item) => item.tier === "golden");
  const blind = cases.filter((item) => item.tier === "blind");
  const goldenPass = golden.filter((item) => item.e2e).length;
  const blindPass = blind.filter((item) => item.e2e).length;
  const falseExactCount = cases.filter((item) => item.falseExact).length;
  const payloadSum = cases.reduce((sum, item) => sum + item.payloadChars, 0);
  const hardFail = falseExactCount > 0 || goldenPass < golden.length;
  const summary: EvalSummary = {
    mode,
    cases,
    goldenTotal: golden.length,
    goldenPass,
    blindTotal: blind.length,
    blindPass,
    blindE2ERate: blind.length === 0 ? 0 : blindPass / blind.length,
    falseExactCount,
    compileOkBlind: blind.filter((item) => item.compileOk).length,
    avgPayloadChars: cases.length === 0 ? 0 : Math.round(payloadSum / cases.length),
    hardFail,
  };
  if (skippedLive !== undefined) {
    summary.skippedLive = skippedLive;
  }
  return summary;
}

export async function runMockedEval(cases = loadEvalCases()): Promise<EvalSummary> {
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    results.push(await runOneCase(evalCase, mockedHandlersFor(evalCase)));
  }
  return summarize("mocked", results);
}

export async function runLiveEval(cases = loadEvalCases()): Promise<EvalSummary> {
  const live = tryLiveClient();
  const tagged = cases.filter((item) => item.live === true);
  if ("skipped" in live) {
    return summarize("live", [], live.skipped);
  }
  if (tagged.length === 0) {
    return summarize("live", [], "no cases tagged live: true");
  }
  const handlers = createToolHandlers(live.client, silent);
  const results: CaseResult[] = [];
  for (const evalCase of tagged) {
    const result = await runOneCase(evalCase, handlers);
    result.live = true;
    results.push(result);
  }
  return summarize("live", results);
}

export function formatReport(mocked: EvalSummary, live?: EvalSummary): string {
  const lines: string[] = [];
  lines.push("SCB blind eval — feature freeze (no new MCP tools)");
  lines.push("Happy path ≤2 tools: scb_count_then_fetch alone, or scb_compile_query + scb_count_then_fetch.");
  lines.push("False exact (claimed exact coverage that is wider/narrower than requested) is a CRITICAL fail.");
  lines.push("Hard-fail: any falseExact, or golden-tier regression. Blind E2E % is the milestone metric (no 90% gate).");
  lines.push("");
  lines.push(formatTable(mocked));
  lines.push(formatSummaryBlock(mocked));
  if (live) {
    lines.push("");
    if (live.skippedLive) {
      lines.push(`Live subset skipped: ${live.skippedLive}`);
    } else {
      lines.push("Live subset (live: true)");
      lines.push(formatTable(live));
      lines.push(formatSummaryBlock(live));
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatTable(summary: EvalSummary): string {
  const header = pad("ID", 40) + pad("TIER", 8) + pad("PASS", 6) + pad("FEX", 5) + pad("COMPILE", 9) + pad("FETCH", 14) + pad("LAY", 4) + pad("CHARS", 8) + "TOOLS";
  const rows = summary.cases.map((item) => {
    return (
      pad(item.id, 40) +
      pad(item.tier, 8) +
      pad(item.e2e ? "PASS" : "FAIL", 6) +
      pad(item.falseExact ? "YES" : "0", 5) +
      pad(item.compileOk ? "ok" : "fail", 9) +
      pad(item.fetchOutcome, 14) +
      pad(item.layoutOk ? "ok" : "bad", 4) +
      pad(String(item.payloadChars), 8) +
      String(item.toolCalls)
    );
  });
  const failNotes = summary.cases
    .filter((item) => !item.e2e)
    .map((item) => `  - ${item.id}: ${item.failures.join("; ")}`);
  return [header, ...rows, ...(failNotes.length > 0 ? ["", "Failures:", ...failNotes] : [])].join("\n");
}

function formatSummaryBlock(summary: EvalSummary): string {
  const blindPct = summary.blindTotal === 0 ? "n/a" : `${(summary.blindE2ERate * 100).toFixed(1)}%`;
  const compileRate =
    summary.blindTotal === 0 ? "n/a" : `${((summary.compileOkBlind / summary.blindTotal) * 100).toFixed(1)}%`;
  return [
    "---",
    `Mode: ${summary.mode}`,
    `Golden E2E: ${summary.goldenPass}/${summary.goldenTotal}${summary.goldenPass === summary.goldenTotal ? "" : "  REGRESSION"}`,
    `Blind E2E:  ${summary.blindPass}/${summary.blindTotal} (${blindPct})   ← milestone metric`,
    `False exact: ${summary.falseExactCount}${summary.falseExactCount > 0 ? "  CRITICAL" : ""}`,
    `Blind compile-ok rate: ${compileRate}`,
    `Avg payload: ${summary.avgPayloadChars} chars`,
    `Hard-fail: ${summary.hardFail ? "YES" : "no"} (falseExact or golden regression only)`,
  ].join("\n");
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return `${value.slice(0, width - 1)} `;
  }
  return value.padEnd(width);
}

export function exitCode(mocked: EvalSummary, live?: EvalSummary): number {
  if (mocked.hardFail) {
    return 1;
  }
  if (live && !live.skippedLive && live.hardFail) {
    return 1;
  }
  return 0;
}
