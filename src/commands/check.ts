import pc from "picocolors";
import { collectAll } from "../collectors/index.js";
import { analyzeEnv } from "../analyze/envDiff.js";
import { buildPayload } from "../analyze/payload.js";
import { renderFindings, renderContextSummary } from "../output/render.js";
import { Spinner } from "../output/spinner.js";

export interface CheckOptions {
  dryRun?: boolean;
  vercel?: boolean;
  cwd?: string;
}

/**
 * Audits environment variables without running a build.
 *
 * The zero-friction entry point: no tokens required, no network unless asked.
 */
export async function check(options: CheckOptions): Promise<number> {
  const root = options.cwd ?? process.cwd();
  const spinner = new Spinner();

  spinner.start("Scanning project…");
  const context = await collectAll({ root, skipVercel: !options.vercel });
  spinner.stop();

  const findings = analyzeEnv(context);

  if (options.dryRun) {
    // Print the exact payload instead of a report, so the privacy boundary is
    // inspectable before anything is ever sent anywhere.
    console.log(JSON.stringify(buildPayload(context, findings), null, 2));
    return 0;
  }

  renderContextSummary(context);

  if (options.vercel && !context.vercel.available) {
    console.log(pc.yellow(`\n  ${context.vercel.unavailableReason}`));
  }

  renderFindings(findings, context);

  return findings.some((finding) => finding.severity === "error") ? 1 : 0;
}
