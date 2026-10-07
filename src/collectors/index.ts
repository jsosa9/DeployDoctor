import type { CollectedContext, VercelContext } from "../types.js";
import type { RunResult } from "../runner/spawn.js";
import { collectProject } from "./project.js";
import { collectEnvRefs } from "./envRefs.js";
import { collectEnvLocal } from "./envLocal.js";
import { collectGit } from "./git.js";
import { collectBuildLog } from "./buildLog.js";
import { collectVercel } from "./vercel.js";

export interface CollectOptions {
  root: string;
  buildResult?: RunResult;
  /** Skip the network call. Set by `check` and by `--no-vercel`. */
  skipVercel?: boolean;
}

/**
 * Runs every collector and assembles the context.
 *
 * Individual collectors never throw, but this guards each one anyway: a
 * diagnosis built from partial context is still useful, and a crash here would
 * throw away the build log the user is waiting to hear about.
 */
export async function collectAll(options: CollectOptions): Promise<CollectedContext> {
  const warnings: string[] = [];
  const { root } = options;

  const project = guard(() => collectProject(root), warnings, "project", {
    root,
    framework: "unknown" as const,
    packageManager: "unknown" as const,
    nextVersion: null,
    nodeEngine: null,
    scripts: {},
    dependencies: [],
    devDependencies: [],
    hasNextConfig: false,
    hasTsconfig: false,
  });

  const envRefs = guard(() => collectEnvRefs(root), warnings, "env references", []);
  const envLocal = guard(() => collectEnvLocal(root), warnings, "local .env files", []);

  const git = await guardAsync(() => collectGit(root), warnings, "git history", {
    isRepo: false,
    branch: null,
    commits: [],
    changedFiles: [],
    diffStat: null,
    isDirty: false,
  });

  // A deliberate skip carries no reason, so nothing is printed about it. A
  // *failed* collection does, since that's something the user may want to fix.
  const vercel: VercelContext = options.skipVercel
    ? { available: false }
    : await guardAsync(() => collectVercel(root), warnings, "Vercel", {
        available: false,
        unavailableReason: "Vercel checks could not be completed.",
      });

  return {
    project,
    envRefs,
    envLocal,
    git,
    buildLog: options.buildResult ? collectBuildLog(options.buildResult) : null,
    vercel,
    warnings,
  };
}

function guard<T>(fn: () => T, warnings: string[], label: string, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    warnings.push(`Couldn't read ${label}: ${message(error)}`);
    return fallback;
  }
}

async function guardAsync<T>(
  fn: () => Promise<T>,
  warnings: string[],
  label: string,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    warnings.push(`Couldn't read ${label}: ${message(error)}`);
    return fallback;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
