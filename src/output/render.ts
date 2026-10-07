import pc from "picocolors";
import type { CollectedContext, Finding, Severity } from "../types.js";

const MARKS: Record<Severity, string> = {
  error: pc.red("✗"),
  warning: pc.yellow("!"),
  info: pc.blue("i"),
};

const LABELS: Record<Severity, string> = {
  error: pc.red("error"),
  warning: pc.yellow("warning"),
  info: pc.blue("info"),
};

export function renderFindings(findings: Finding[], context: CollectedContext): void {
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  const infos = findings.filter((f) => f.severity === "info");

  if (findings.length === 0) {
    console.log(`\n${pc.green("✓")} No environment variable problems found.\n`);
    renderWarnings(context);
    return;
  }

  console.log("");
  for (const finding of [...errors, ...warnings, ...infos]) {
    renderFinding(finding);
  }

  const parts: string[] = [];
  if (errors.length) parts.push(pc.red(`${errors.length} error${plural(errors.length)}`));
  if (warnings.length) parts.push(pc.yellow(`${warnings.length} warning${plural(warnings.length)}`));
  if (infos.length) parts.push(pc.blue(`${infos.length} note${plural(infos.length)}`));
  console.log(pc.dim("─".repeat(60)));
  console.log(`${parts.join(pc.dim(" · "))}\n`);

  renderWarnings(context);
}

function renderFinding(finding: Finding): void {
  console.log(`${MARKS[finding.severity]} ${pc.bold(finding.title)}  ${LABELS[finding.severity]}`);
  console.log(`  ${wrap(finding.detail, 76, "  ")}`);
  if (finding.locations.length) {
    console.log(`  ${pc.dim(finding.locations.join(pc.dim(", ")))}`);
  }
  console.log(`  ${pc.green("→")} ${wrap(finding.fix, 76, "    ")}`);
  console.log(`  ${pc.dim(finding.rule)}`);
  console.log("");
}

function renderWarnings(context: CollectedContext): void {
  if (!context.warnings.length) return;
  for (const warning of context.warnings) {
    console.log(pc.dim(`  note: ${warning}`));
  }
  console.log("");
}

export function renderContextSummary(context: CollectedContext): void {
  const { project, envRefs, envLocal, vercel } = context;
  const unique = new Set(envRefs.map((ref) => ref.name)).size;
  const bits = [
    `${project.framework}`,
    `${unique} env var${plural(unique)} referenced`,
    `${new Set(envLocal.map((k) => k.name)).size} configured locally`,
  ];
  if (vercel.available && vercel.envKeys) {
    bits.push(`${vercel.envKeys.length} on Vercel`);
  }
  console.log(pc.dim(`  ${bits.join(" · ")}`));
}

/** Wraps text to a width, indenting continuation lines. */
function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width && line.length > 0) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
