import pc from "picocolors";
import { run as runCommand } from "../runner/spawn.js";
import { collectAll } from "../collectors/index.js";
import { analyzeEnv } from "../analyze/envDiff.js";
import { buildPayload } from "../analyze/payload.js";
import { renderFindings } from "../output/render.js";
import { renderDiagnosis } from "../output/diagnosis.js";
import { Spinner } from "../output/spinner.js";
import { resolveProvider, NO_KEY_MESSAGE } from "../llm/index.js";
import type { LlmProvider } from "../llm/types.js";

/** Marks the start of --dry-run JSON, since build output shares stdout. */
export const PAYLOAD_SENTINEL = "===DEPLOYDOCTOR_PAYLOAD===";

export interface RunOptions {
  dryRun?: boolean;
  vercel?: boolean;
  cwd?: string;
  /** Overrides provider resolution. Used by tests; unset in normal operation. */
  provider?: LlmProvider | null;
}

/**
 * Wraps the user's command and diagnoses it if it fails.
 *
 * Transparency first: on success this is indistinguishable from running the
 * command directly, and the child's exit code is always what we return.
 */
export async function run(argv: string[], options: RunOptions): Promise<number> {
  const root = options.cwd ?? process.cwd();
  const result = await runCommand(argv, root);

  if (result.exitCode === 0) {
    console.log(
      pc.green(`\n✓ ${pc.bold(result.command)} succeeded in ${formatDuration(result.durationMs)}`),
    );
    return 0;
  }

  console.log(
    pc.red(
      `\n✗ ${pc.bold(result.command)} failed${
        result.exitCode !== null ? ` with exit code ${result.exitCode}` : ` (${result.signal})`
      }`,
    ),
  );
  console.log(pc.dim("  Diagnosing…\n"));

  const spinner = new Spinner();
  spinner.start("Gathering context…");
  const context = await collectAll({
    root,
    buildResult: result,
    skipVercel: options.vercel === false,
  });
  spinner.stop();

  const findings = analyzeEnv(context);
  const payload = buildPayload(context, findings);

  if (options.dryRun) {
    // The child's output already went to stdout, so the payload is fenced by a
    // sentinel to stay extractable:
    //   deploydoctor run ... --dry-run | sed -n '/^===DEPLOYDOCTOR_PAYLOAD===$/,$p' | tail -n +2
    console.log(`\n${PAYLOAD_SENTINEL}`);
    console.log(JSON.stringify(payload, null, 2));
    return result.exitCode ?? 1;
  }

  // Deterministic findings first — they're free, instant, and often the answer.
  if (findings.length) {
    renderFindings(findings, context);
  }

  if (!context.vercel.available && context.vercel.unavailableReason) {
    console.log(pc.dim(`  ${context.vercel.unavailableReason}\n`));
  }

  const provider = options.provider !== undefined ? options.provider : resolveProvider();
  if (!provider) {
    console.log(pc.yellow(`  ${NO_KEY_MESSAGE}\n`));
    return result.exitCode ?? 1;
  }

  spinner.start("Analyzing the failure…");
  try {
    const diagnosis = await provider.diagnose(payload);
    spinner.stop();
    renderDiagnosis(diagnosis);
  } catch (error) {
    spinner.stop();
    console.log(
      pc.yellow(
        `  Couldn't complete the analysis: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      ),
    );
  }

  // Always surface the real failure's exit code, so this stays CI-safe.
  return result.exitCode ?? 1;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
