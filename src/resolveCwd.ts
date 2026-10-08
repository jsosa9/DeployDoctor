import fs from "node:fs";
import path from "node:path";

/**
 * Resolves the `--cwd` flag to an absolute directory, failing loudly if it
 * isn't usable.
 *
 * Every collector swallows its own errors so that a partial diagnosis still
 * beats none — which means a mistyped path would otherwise sail all the way
 * through and report "no environment variable problems found". A confident
 * wrong answer is the one output this tool must never produce, so the check
 * happens here, before any collector gets the chance to shrug it off.
 *
 * Lives apart from cli.ts because that module parses argv on import.
 */
export function resolveCwd(value: string | undefined): string {
  if (value === undefined) return process.cwd();

  const resolved = path.resolve(value);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`--cwd: no such directory: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`--cwd: not a directory: ${resolved}`);
  }
  return resolved;
}
