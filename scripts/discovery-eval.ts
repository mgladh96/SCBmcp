/**
 * Discovery evaluation CLI (mocked live-shaped SCB kodtabeller).
 *
 * Top-K label/token relevance. Does not treat 41/42/43 as a facit for "bygg".
 */
import { formatDiscoveryReport, loadDiscoveryCases, runDiscoveryEval } from "../tests/eval/discovery-runner.js";

async function main(): Promise<void> {
  const cases = loadDiscoveryCases();
  const summary = await runDiscoveryEval(cases);
  process.stdout.write(formatDiscoveryReport(summary));
  process.exit(summary.hardFail ? 1 : 0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
