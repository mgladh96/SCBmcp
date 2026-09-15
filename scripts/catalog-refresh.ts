/**
 * Refresh the bundled SCB code catalog.
 *
 *   pnpm catalog:refresh           Live SCB (requires .pfx + env)
 *   pnpm catalog:refresh --fixture From checked-in eval fixtures (CI-safe)
 */
import { loadConfig, loadEnvFiles } from "../src/config/env.js";
import { ScbClient } from "../src/scb/client.js";
import {
  buildCatalogFromClient,
  bundledCatalogPath,
  catalogDocCount,
  resolveCatalogPath,
  writeCatalogToDisk,
} from "../src/scb/offline-catalog.js";
import { fixtureCatalogArtifact } from "../tests/eval/catalog.js";

async function main(): Promise<void> {
  const fixture = process.argv.includes("--fixture");
  const out = resolveCatalogPath(process.env.SCB_CATALOG_PATH) || bundledCatalogPath();
  if (fixture) {
    const artifact = fixtureCatalogArtifact();
    writeCatalogToDisk(out, artifact);
    process.stdout.write(
      `Wrote fixture catalog ${out} (${catalogDocCount(artifact)} rows, builtAt=${artifact.builtAt})\n`,
    );
    return;
  }

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
    logLevel: config.logLevel,
    offlineCatalog: false,
  });
  const artifact = await buildCatalogFromClient(client, { source: "scb-live" });
  writeCatalogToDisk(out, artifact);
  process.stdout.write(
    `Wrote live catalog ${out} (${catalogDocCount(artifact)} rows, builtAt=${artifact.builtAt})\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
