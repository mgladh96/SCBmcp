import { loadConfig, loadEnvFiles } from "../src/config/env.js";
import { ScbClient } from "../src/scb/client.js";

function summarize(value: unknown): { kind: string; size: number } {
  if (Array.isArray(value)) {
    return { kind: "array", size: value.length };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.Kategorier)) {
      return { kind: "categories", size: record.Kategorier.length };
    }
    if (Array.isArray(record.Variabler)) {
      return { kind: "variables", size: record.Variabler.length };
    }
    return { kind: "object", size: Object.keys(record).length };
  }
  return { kind: typeof value, size: 0 };
}

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  const client = new ScbClient({
    baseUrl: config.baseUrl,
    auth: {
      apiId: config.apiId,
      apiIdHeader: config.apiIdHeader,
      certPath: config.certPath,
      certPassword: config.certPassword,
    },
    logLevel: "info",
  });

  const jeCategories = await client.listCategories("company");
  const aeCategories = await client.listCategories("workplace");
  const kodtabell = await client.getCategoryValues("company", "Företagsstatus");
  const count = await client.countCompanies({
    categories: [
      { category: "Företagsstatus", values: ["1"] },
      { category: "Registreringsstatus", values: ["1"] },
    ],
    variables: [],
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        jeCategories: summarize(jeCategories),
        aeCategories: summarize(aeCategories),
        kodtabell: summarize(kodtabell),
        countActiveRegisteredCompanies: count,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const payload =
    error && typeof error === "object" && "toJSON" in error
      ? (error as { toJSON: () => unknown }).toJSON()
      : { message: error instanceof Error ? error.message : "unknown" };
  process.stderr.write(`${JSON.stringify({ ok: false, ...payload })}\n`);
  process.exit(1);
});
