/**
 * Drives every failure scenario through the built CLI and reports what came
 * back.
 *
 * This is deliberately not a vitest file. The unit suite covers the pieces in
 * isolation with injected seams; what this checks is the thing a user actually
 * invokes — `dist/cli.js`, a real child process, real streams, real exit codes
 * — which is exactly where the bugs the unit tests can't see have turned up.
 *
 *   npm run harness
 *   npm run harness -- --verbose
 *   npm run harness -- --scenario missing-env
 *   npm run harness -- --payload missing-env
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "dist", "cli.js");
const project = path.join(repoRoot, "test", "fixtures", "failing-build");
const simulator = path.join(here, "build-sim.mjs");

const PAYLOAD_SENTINEL = "===DEPLOYDOCTOR_PAYLOAD===";

/** What each scenario must demonstrate, beyond simply failing. */
const EXPECTATIONS = {
  "missing-env": { exitCode: 1, signal: /supabaseUrl is required/ },
  "type-error": { exitCode: 1, signal: /Type error: Property 'emailAddress'/ },
  "module-not-found": { exitCode: 1, signal: /Module not found/ },
  oom: { exitCode: 137, signal: /JavaScript heap out of memory/ },
  // Values the redaction pass must remove before anything leaves the process.
  //
  // `mustRedact` guards against the check going vacuous: if the error frame
  // never captures these lines, the absence of the secrets proves nothing, so
  // a redaction marker is required as evidence the pass actually ran.
  "leaky-log": {
    exitCode: 1,
    signal: /Failed to fetch CMS schema/,
    mustNotLeak: ["SYNTHETIC_FIXTURE_VALUE_NOT_REAL", "fixturepw"],
    mustRedact: ["[redacted:credentials]", "[redacted]"],
  },
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

if (!fs.existsSync(cli)) {
  console.error(`harness: ${path.relative(repoRoot, cli)} is missing — run \`npm run build\` first.`);
  process.exit(2);
}

const available = spawnSync(process.execPath, [simulator], {
  env: { ...process.env, SCENARIO: "list" },
  encoding: "utf8",
}).stdout.trim().split("\n");

const only = value("scenario") ?? value("payload");
const scenarios = only ? available.filter((s) => s === only) : available;

if (!scenarios.length) {
  console.error(`harness: unknown scenario "${only}". Known: ${available.join(", ")}`);
  process.exit(2);
}

/** Runs one scenario through the CLI exactly as a user would invoke it. */
function runScenario(name, { dryRun }) {
  const cliArgs = ["run", "npm", "run", "build", "--cwd", project];
  if (dryRun) cliArgs.push("--dry-run");

  const result = spawnSync(process.execPath, [cli, ...cliArgs], {
    env: { ...process.env, SCENARIO: name },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** Pulls the fenced JSON payload out of a --dry-run run. */
function extractPayload(stdout) {
  const index = stdout.indexOf(PAYLOAD_SENTINEL);
  if (index === -1) return null;
  const json = stdout.slice(index + PAYLOAD_SENTINEL.length);
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// `--payload <name>` is an inspection mode, not a check: print the exact
// payload and stop, so the privacy boundary can be read directly.
if (value("payload")) {
  const name = value("payload");
  const payload = extractPayload(runScenario(name, { dryRun: true }).stdout);
  if (!payload) {
    console.error(`harness: no payload recovered for "${name}".`);
    process.exit(1);
  }
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log(`\nDeployDoctor failure-scenario harness`);
console.log(`  cli:     ${path.relative(repoRoot, cli)}`);
console.log(`  project: ${path.relative(repoRoot, project)}\n`);

const rows = [];
let failures = 0;

for (const name of scenarios) {
  const expected = EXPECTATIONS[name] ?? {};
  const live = runScenario(name, { dryRun: false });
  const dry = runScenario(name, { dryRun: true });
  const payload = extractPayload(dry.stdout);

  const problems = [];

  if (expected.exitCode !== undefined && live.exitCode !== expected.exitCode) {
    problems.push(`exit ${live.exitCode} ≠ expected ${expected.exitCode}`);
  }

  const frame = payload?.failure?.errorFrame ?? [];
  if (!frame.length) {
    problems.push("error frame empty");
  } else if (expected.signal && !expected.signal.test(frame.join("\n"))) {
    problems.push(`frame missing ${expected.signal}`);
  }

  // The redaction check runs against the whole payload, not just the log: a
  // value can reach it through the command line or a commit subject too.
  const serialized = payload ? JSON.stringify(payload) : "";
  const leaked = (expected.mustNotLeak ?? []).filter((s) => serialized.includes(s));
  if (leaked.length) problems.push(`LEAKED ${leaked.join(", ")}`);

  // Absence alone is not evidence: the lines may simply never have been
  // captured. Require proof the redaction pass touched them.
  const missingMarkers = (expected.mustRedact ?? []).filter((m) => !serialized.includes(m));
  if (missingMarkers.length) {
    problems.push(`no redaction marker ${missingMarkers.join(", ")} — check is vacuous`);
  }

  const findings = payload?.deterministicFindings ?? [];

  rows.push({
    name,
    exitCode: live.exitCode,
    frameLines: frame.length,
    findings: findings.length,
    redaction: expected.mustNotLeak ? (leaked.length ? "LEAK" : "clean") : "—",
    status: problems.length ? "FAIL" : "ok",
    problems,
  });

  if (problems.length) failures++;

  if (flag("verbose")) {
    console.log(`${"─".repeat(72)}\n▸ ${name}\n`);
    console.log(live.combined.trimEnd());
    console.log("");
  }
}

const width = Math.max(...rows.map((r) => r.name.length), 8);
console.log(
  `  ${"scenario".padEnd(width)}  exit  frame  findings  redaction  status`,
);
for (const row of rows) {
  console.log(
    `  ${row.name.padEnd(width)}  ${String(row.exitCode).padEnd(4)}  ` +
      `${String(row.frameLines).padEnd(5)}  ${String(row.findings).padEnd(8)}  ` +
      `${row.redaction.padEnd(9)}  ${row.status}`,
  );
  for (const problem of row.problems) console.log(`  ${" ".repeat(width)}    → ${problem}`);
}

const diagnosed = process.env.ANTHROPIC_API_KEY ? "set" : "not set";
console.log(
  `\n  ${rows.length - failures}/${rows.length} scenarios ok` +
    `   ·   ANTHROPIC_API_KEY ${diagnosed}` +
    (process.env.ANTHROPIC_API_KEY
      ? ""
      : "  (log diagnosis not exercised — the LLM path stays unverified)"),
);
console.log(`  --verbose for full output, --payload <scenario> to read what would be sent\n`);

process.exit(failures ? 1 : 0);
