/**
 * Blind evaluation CLI.
 *
 * Default: mocked live-shaped SCB fixtures (CI-safe).
 * Optional live subset: SCB_LIVE_TESTS=true (skip if no cert).
 *
 * Exit 1 on any falseExact or golden-tier regression.
 * Blind E2E % is reported as the product metric — not a fake 90% gate.
 */
import { exitCode, formatReport, loadEvalCases, runLiveEval, runMockedEval } from "../tests/eval/runner.js";

async function main(): Promise<void> {
  const cases = loadEvalCases();
  const mocked = await runMockedEval(cases);
  const live = await runLiveEval(cases);
  process.stdout.write(formatReport(mocked, live));
  process.exit(exitCode(mocked, live));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
