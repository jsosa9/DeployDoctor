import pc from "picocolors";
import type { Diagnosis } from "../llm/types.js";

const CONFIDENCE_COLORS = {
  high: pc.green,
  medium: pc.yellow,
  low: pc.red,
} as const;

export function renderDiagnosis(diagnosis: Diagnosis): void {
  const color = CONFIDENCE_COLORS[diagnosis.confidence];

  console.log(`\n${pc.bold(pc.cyan("What broke"))}`);
  console.log(`  ${pc.bold(diagnosis.summary)}\n`);

  console.log(`${pc.bold(pc.cyan("Why"))}`);
  console.log(`  ${indent(diagnosis.rootCause)}\n`);

  if (diagnosis.fixSteps.length) {
    console.log(`${pc.bold(pc.cyan("How to fix it"))}`);
    diagnosis.fixSteps.forEach((step, index) => {
      console.log(`  ${pc.bold(`${index + 1}.`)} ${indent(step.description, 5)}`);
      if (step.command) console.log(`     ${pc.green("$")} ${pc.bold(step.command)}`);
      if (step.file) console.log(`     ${pc.dim(step.file)}`);
    });
    console.log("");
  }

  if (diagnosis.relatedFindings.length) {
    console.log(`${pc.bold(pc.cyan("Also noticed"))}`);
    for (const finding of diagnosis.relatedFindings) {
      console.log(`  ${pc.dim("·")} ${indent(finding, 4)}`);
    }
    console.log("");
  }

  console.log(pc.dim(`  confidence: `) + color(diagnosis.confidence) + "\n");
}

function indent(text: string, width = 2): string {
  return text.split("\n").join(`\n${" ".repeat(width)}`);
}
