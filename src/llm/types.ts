import * as z from "zod/v4";
import type { DiagnosisPayload } from "../analyze/payload.js";

export const FixStepSchema = z.object({
  description: z.string().describe("What to do, in one imperative sentence."),
  command: z
    .string()
    .nullable()
    .describe("The exact shell command to run, or null if this step isn't a command."),
  file: z
    .string()
    .nullable()
    .describe("The file to edit, as path or path:line, or null if not a file edit."),
});

export const DiagnosisSchema = z.object({
  summary: z.string().describe("One sentence a tired developer can act on."),
  rootCause: z
    .string()
    .describe("What actually broke and why, in plain English. No jargon unless it's in their log."),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("How certain the diagnosis is given the available context."),
  fixSteps: z.array(FixStepSchema).describe("Ordered steps to fix it."),
  relatedFindings: z
    .array(z.string())
    .describe("Other issues noticed in passing that aren't the root cause."),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type FixStep = z.infer<typeof FixStepSchema>;

/**
 * One method, one implementation.
 *
 * This exists as a seam, not an abstraction — it keeps the call site from
 * importing the SDK directly, so adding a provider later is additive. No
 * second provider is anticipated.
 */
export interface LlmProvider {
  diagnose(payload: DiagnosisPayload): Promise<Diagnosis>;
}
