/**
 * Golden-path benchmark for StructuredQuery → compile → count_then_fetch.
 *
 * Default: mocked live-shaped SCB metadata (CI-safe).
 * Optional live compile: SCB_LIVE_TESTS=true (requires cert; fetch still skipped).
 *
 * Happy path for agents: ≤2 MCP tools (scb_compile_query optional, scb_count_then_fetch required).
 */
import { compileStructuredQuery, countThenFetch, structuredQuerySchema } from "../src/scb/compile/index.js";
import { fold } from "../src/domain/catalog.js";
import { catalogAndSearchFetch, createTestClient } from "../tests/helpers.js";

const GOLDEN_QUERY = {
  objectType: "company" as const,
  industry: { query: "bygg" },
  geography: { type: "county" as const, value: "Jämtland" },
  employees: { min: 10, max: 15 },
  maxRows: 50,
  fields: ["name", "organizationNumber", "municipality", "employeeCount"],
};

const GOLDEN_ROW = {
  Företagsnamn: "Jämtlands Bygg AB",
  "OrgNr (10 siffror)": "5560747569",
  "Säteskommun, text": "Östersund",
  "Säteskommun, kod": "2380",
  "Storleksklass Anställda, text": "10-19 anställda",
  "Storleksklass Anställda, kod": "4",
  Reklam: "11",
  Telefon: "secret",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const query = structuredQuerySchema.parse(GOLDEN_QUERY);
  const client = createTestClient(
    catalogAndSearchFetch({ shape: "live" }, { count: 1, results: [GOLDEN_ROW] }),
  );

  const compiled = await compileStructuredQuery(query, client);
  const geo = compiled.filters.categories.find((item) => fold(item.category).includes("sateslan"));
  assert(compiled.ok, `compile failed: ${JSON.stringify(compiled.unresolved)}`);
  assert(compiled.resolved.layout === "je", "expected JE layout");
  assert(geo && geo.category !== "Län", `expected Säteslän, got ${geo?.category}`);
  assert(fold(geo.category) === fold("SätesLän"), `live name should fold to SätesLän, got ${geo.category}`);
  assert(
    compiled.filters.categories.some((item) => item.values.includes("F") || item.values.includes("41")),
    "expected industry codes",
  );
  const emp = compiled.coverage.find((item) => item.constraint === "employees");
  assert(emp?.relation === "superset" && emp.exact === false, `employee coverage ${JSON.stringify(emp)}`);
  const sizeCat = compiled.resolved.employees?.category ?? "";
  assert(!/omsattning/i.test(fold(sizeCat)), `employees mapped to revenue class ${sizeCat}`);
  const industry = compiled.filters.categories.find((item) => fold(item.category).includes("bransch"));
  assert(industry?.branchLevel !== undefined, "Bransch requires Branschniva");
  assert(
    (industry?.branchLevel ?? 0) >= 1 && (industry?.branchLevel ?? 0) <= 3,
    `Branschniva out of 1–3: ${industry?.branchLevel}`,
  );
  assert((industry?.values.length ?? 0) <= 8, `too many industry codes: ${industry?.values.join(",")}`);

  const fetched = await countThenFetch(client, query);
  assert(fetched.coverage.some((item) => item.constraint === "employees"), "coverage dropped on fetch");
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
          typical: ["scb_count_then_fetch"],
          withDryRun: ["scb_compile_query", "scb_count_then_fetch"],
          max: 2,
          note: "Agent owns NL → StructuredQuery. Internal metadata lookups are not agent tool calls.",
        },
        layout: compiled.resolved.layout,
        geographyCategory: geo.category,
        industryCodes: compiled.resolved.industry?.codes.map((item) => item.code),
        industryBranchLevel: compiled.resolved.industry?.branchLevel,
        employeeCategory: compiled.resolved.employees?.category,
        employeeCoverage: emp,
        projectedKeys: fetched.projectedFields,
        aliasNote:
          "Results use semantic keys (name, organizationNumber, municipality, employeeCount). resolved.fields maps them to live SCB names (e.g. Företagsnamn, OrgNr (10 siffror), Säteskommun).",
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
