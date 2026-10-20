import { loadConfig, loadEnvFiles } from "../src/config/env.js";
import { createToolHandlers } from "../src/mcp/tools.js";
import { ScbClient } from "../src/scb/client.js";
import { createLogger } from "../src/log.js";

/**
 * Times the old full Innehaller download against the voice lookup.
 * Prints durations and company names only. Never prints credentials.
 */
const QUERIES = ["Anders Westlunds Entreprenad", "Westlund"];

async function main(): Promise<void> {
  loadEnvFiles();
  if (!process.env.SCB_CERT_PASSWORD || !(process.env.SCB_CERT_PATH || process.env.SCB_CERT_BASE64)) {
    process.stdout.write(
      `${JSON.stringify({ measured: false, reason: "SCB certificate is not configured in this environment" })}\n`,
    );
    return;
  }
  const config = loadConfig();
  const client = new ScbClient({
    baseUrl: config.baseUrl,
    auth: {
      apiId: config.apiId,
      apiIdHeader: config.apiIdHeader,
      certPassword: config.certPassword,
      ...(config.certPath ? { certPath: config.certPath } : {}),
      ...(config.certPfx ? { certPfx: config.certPfx } : {}),
    },
    logLevel: "error",
  });
  const handlers = createToolHandlers(client, createLogger("error"));
  const rows: unknown[] = [];
  for (const name of QUERIES) {
    const baselineStarted = Date.now();
    const baseline = await client.searchCompanies({
      categories: [],
      variables: [{ variable: "Namn", operator: "Innehaller", value: name }],
    });
    const baselineMs = Date.now() - baselineStarted;
    const optimizedStarted = Date.now();
    const optimized = await handlers.scb_find_company({ name });
    const optimizedMs = Date.now() - optimizedStarted;
    const cachedStarted = Date.now();
    await handlers.scb_find_company({ name });
    const cachedMs = Date.now() - cachedStarted;
    const payload = JSON.parse(optimized.content[0]?.text ?? "{}") as {
      count?: number;
      returned?: number;
      results?: Array<{ name?: string; organizationNumber?: string }>;
      code?: string;
    };
    rows.push({
      name,
      baselineMs,
      baselineCount: baseline.count,
      baselineRows: baseline.results.length,
      optimizedMs,
      cachedMs,
      optimizedCount: payload.count ?? null,
      returned: payload.returned ?? null,
      top: (payload.results ?? []).map((row) => row.name ?? ""),
      error: payload.code ?? null,
    });
  }
  process.stdout.write(`${JSON.stringify({ measured: true, rows }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "ERROR";
  process.stderr.write(`${JSON.stringify({ measured: false, code })}\n`);
  process.exit(1);
});
