/**
 * Golden-path benchmark for StructuredQuery → compile → count_then_fetch.
 *
 * Default: mocked live-shaped SCB metadata (CI-safe, no cert).
 * Compile industry uses the same discoverCodes motor as scb_lookup_codes.
 *
 * Live SCB is not invoked here. After merge, coordinators run:
 *   SCB_LIVE_TESTS=true pnpm test:live
 *   SCB_LIVE_TESTS=true pnpm verify:live
 * those require an SCB .pfx (absent in CI).
 *
 * Happy path for agents: ≤2 MCP tools (scb_query first; scb_compile_query optional dry-run).
 */
import { compileStructuredQuery, countThenFetch, structuredQuerySchema } from "../src/scb/compile/index.js";
import { fold } from "../src/domain/catalog.js";
import { catalogAndSearchFetch, createTestClient } from "../tests/helpers.js";
import { diverseCatalogSpec } from "../tests/eval/catalog.js";
import { LIVE_JE_SEARCH_ROW } from "../tests/fixtures/live-scb-metadata.js";

const GOLDEN_QUERY = {
  objectType: "company" as const,
  industry: { query: "bygg" },
  geography: { type: "county" as const, value: "Jämtland" },
  employees: { min: 10, max: 15 },
  maxRows: 50,
  fields: ["name", "organizationNumber", "municipality", "employeeCount"],
};

const GOLDEN_ROW = LIVE_JE_SEARCH_ROW;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const query = structuredQuerySchema.parse(GOLDEN_QUERY);
  const hamtaBodies: unknown[] = [];
  const inner = catalogAndSearchFetch(diverseCatalogSpec(), { count: 14, results: [GOLDEN_ROW] });
  const client = createTestClient(async (url, init) => {
    if (new URL(url).pathname.includes("hamta") && init.body) {
      hamtaBodies.push(JSON.parse(init.body));
    }
    return inner(url, init);
  });

  const compiled = await compileStructuredQuery(query, client);
  const geo = compiled.filters.categories.find((item) => fold(item.category).includes("sateslan"));
  assert(compiled.ok, `compile failed: ${JSON.stringify(compiled.unresolved)}`);
  assert(compiled.resolved.layout === "je", "expected JE layout");
  assert(geo && geo.category !== "Län", `expected Säteslän, got ${geo?.category}`);
  assert(fold(geo.category) === fold("SätesLän"), `live name should fold to SätesLän, got ${geo.category}`);
  assert(
    compiled.filters.categories.some((item) => fold(item.category).includes("bransch") && item.values.length > 0),
    "expected industry codes from metadata search",
  );
  const emp = compiled.coverage.find((item) => item.constraint === "employees");
  assert(emp?.relation === "superset" && emp.exact === false, `employee coverage ${JSON.stringify(emp)}`);
  const sizeCat = compiled.resolved.employees?.category ?? "";
  assert(!/omsattning/i.test(fold(sizeCat)), `employees mapped to revenue class ${sizeCat}`);
  const industry = compiled.filters.categories.find((item) => fold(item.category).includes("bransch"));
  const industryLabels = (compiled.resolved.industry?.codes ?? []).map((item) => item.label).join(" ");
  assert(/bygg/i.test(industryLabels), `expected bygg-relevant labels, got ${industryLabels}`);
  assert(industry?.values.length, "expected at least one industry code");

  const fetched = await countThenFetch(client, query);
  assert(fetched.coverage.some((item) => item.constraint === "employees"), "coverage dropped on fetch");
  assert(
    !fetched.filters.variables.some((item) => item.operator === "Finns" || item.operator === "ArLikaMed"),
    "count_then_fetch must not inject Finns/ArLikaMed for projection",
  );
  assert(hamtaBodies.length > 0, "expected a hamta POST");
  for (const body of hamtaBodies) {
    const vars = (body as { variabler?: Array<{ Operator?: string }> }).variabler ?? [];
    assert(
      vars.every((item) => item.Operator !== "Finns" && item.Operator !== "ArLikaMed"),
      `hamta POSTed illegal projection operator: ${JSON.stringify(body)}`,
    );
  }
  assert(fetched.results[0]?.name === "Jämtlands Bygg AB", "expected semantic key name");
  assert(fetched.results[0]?.organizationNumber === "5560747569", "expected semantic organizationNumber");
  assert(fetched.results[0]?.municipality === "Östersund", "expected semantic municipality");
  assert(fetched.results[0]?.employeeCount === "10-19 anställda", "expected semantic employeeCount");
  assert(fetched.results[0]?.Reklam === "11", "Reklam must be preserved");
  assert(fetched.results[0]?.Telefon === undefined, "non-projected SCB keys must be dropped");

  const compileJson = JSON.stringify(compiled);
  assert(!compileJson.includes("Id_Kategori"), "compile response dumped catalog identity keys");
  assert(compileJson.length < 15_000, "compile response is not compact");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        happyPathToolCalls: {
          typical: ["scb_query"],
          withDryRun: ["scb_compile_query", "scb_query"],
          ambiguous: ["scb_query", "scb_query"],
          max: 2,
          note: "Agent owns NL → StructuredQuery. Internal metadata lookups are not agent tool calls.",
        },
        layout: compiled.resolved.layout,
        geographyCategory: geo.category,
        industryCategory: industry.category,
        industryCodes: compiled.resolved.industry?.codes.map((item) => item.code),
        industryBranchLevel: compiled.resolved.industry?.branchLevel,
        employeeCategory: compiled.resolved.employees?.category,
        employeeCoverage: emp,
        projectedKeys: fetched.projectedFields,
        aliasNote:
          "Results use semantic keys (name, organizationNumber, municipality, employeeCount). resolved.fields prefers live hamta keys (Företagsnamn, OrgNr/PeOrgNr, Säteskommun, Storleksklass). Fetch does not POST Finns/ArLikaMed to select Namn.",
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
