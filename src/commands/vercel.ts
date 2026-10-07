import pc from "picocolors";
import { collectVercel, type FetchLike } from "../collectors/vercel.js";
import type { EnvScope, VercelContext } from "../types.js";

export interface VercelCommandOptions {
  json?: boolean;
  cwd?: string;
  /** Overrides the HTTP client. Used by tests; unset in normal operation. */
  fetchImpl?: FetchLike;
}

const ALL_SCOPES: EnvScope[] = ["production", "preview", "development"];

/**
 * Runs only the Vercel collector and prints exactly what it got back.
 *
 * Exists for verification: the collector has been tested against synthetic
 * responses, so this is how its output gets compared against what the Vercel
 * dashboard actually shows. It performs no analysis and makes no LLM call.
 */
export async function vercelInspect(options: VercelCommandOptions): Promise<number> {
  const root = options.cwd ?? process.cwd();
  const context = await collectVercel(root, options.fetchImpl ?? fetch);

  if (options.json) {
    console.log(JSON.stringify(context, null, 2));
    return context.available ? 0 : 1;
  }

  if (!context.available) {
    console.log(`\n${pc.red("✗")} Vercel context unavailable.\n`);
    console.log(`  ${context.unavailableReason ?? "No reason given."}\n`);
    return 1;
  }

  renderProject(context);
  renderDeployments(context);
  renderEnvKeys(context);

  console.log(
    pc.dim(
      "  Values are never requested or stored — only names and target scopes.\n" +
        "  Compare the table above against your Vercel dashboard.\n",
    ),
  );

  return 0;
}

function renderProject(context: VercelContext): void {
  console.log(`\n${pc.bold(pc.cyan("Project"))}`);
  row("name", context.projectName ?? pc.dim("—"));
  row("id", context.projectId ?? pc.dim("—"));
  row("framework", context.framework ?? pc.dim("—"));
  row("node", context.nodeVersion ?? pc.dim("—"));
}

function renderDeployments(context: VercelContext): void {
  const deployments = context.deployments ?? [];
  console.log(`\n${pc.bold(pc.cyan(`Recent deployments (${deployments.length})`))}`);

  if (!deployments.length) {
    console.log(pc.dim("  none returned"));
    return;
  }

  for (const deployment of deployments) {
    const state =
      deployment.state === "ERROR"
        ? pc.red(deployment.state)
        : deployment.state === "READY"
          ? pc.green(deployment.state)
          : pc.yellow(deployment.state);

    const when = deployment.createdAt
      ? new Date(deployment.createdAt).toISOString().slice(0, 16).replace("T", " ")
      : "—";

    console.log(
      `  ${state.padEnd(18)} ${pc.dim((deployment.target ?? "—").padEnd(11))} ` +
        `${pc.dim(when)}  ${deployment.commitSha?.slice(0, 8) ?? pc.dim("no commit")}`,
    );
    if (deployment.commitMessage) {
      console.log(`  ${pc.dim(`  "${truncate(deployment.commitMessage, 60)}"`)}`);
    }
  }
}

function renderEnvKeys(context: VercelContext): void {
  const keys = context.envKeys ?? [];
  console.log(`\n${pc.bold(pc.cyan(`Environment variables (${keys.length})`))}`);

  if (!keys.length) {
    console.log(pc.dim("  none returned"));
    return;
  }

  const width = Math.min(Math.max(...keys.map((key) => key.name.length)), 44);
  console.log(
    `  ${pc.dim("name".padEnd(width))}  ${pc.dim("prod")} ${pc.dim("prev")} ${pc.dim("dev")}  ${pc.dim("other")}`,
  );

  for (const key of keys) {
    const marks = ALL_SCOPES.map((scope) =>
      key.scopes.includes(scope) ? pc.green(" ✓  ") : pc.red(" ·  "),
    ).join("");
    const other = key.otherTargets.length ? pc.yellow(key.otherTargets.join(",")) : "";
    console.log(`  ${key.name.padEnd(width)}  ${marks} ${other}`);
  }

  const partial = keys.filter(
    (key) => key.scopes.length > 0 && key.scopes.length < ALL_SCOPES.length,
  );
  if (partial.length) {
    console.log(
      `\n  ${pc.yellow("!")} ${partial.length} variable${partial.length === 1 ? "" : "s"} ` +
        `set for some environments but not others — these are what env/scope-gap reports.`,
    );
  }
}

function row(label: string, value: string): void {
  console.log(`  ${pc.dim(label.padEnd(11))} ${value}`);
}

function truncate(text: string, max: number): string {
  const single = text.split("\n")[0] ?? "";
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
