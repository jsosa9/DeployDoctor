import type { BuildLogContext } from "../types.js";
import type { RunResult } from "../runner/spawn.js";

/* eslint-disable no-control-regex */
const ANSI = /\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07/g;

/**
 * Lines that mark the start of something worth reading. Used to locate the
 * error frame, not to interpret it — interpretation is the model's job.
 */
const SIGNALS = [
  /^.*\bError:/,
  /^.*\bTypeError:/,
  /^.*\bReferenceError:/,
  /Module not found/,
  /Type error:/,
  /Failed to compile/,
  /Build error occurred/,
  /ELIFECYCLE/,
  /ERR_PNPM/,
  /npm ERR!/,
  /error TS\d+/,
  /Cannot find module/,
  /^\s*✘/,
  /^\s*× /,
  /FATAL/,
];

/** Lines kept before and after each signal hit. */
const CONTEXT_BEFORE = 3;
const CONTEXT_AFTER = 12;
/** Tail kept when no signal matches at all. */
const FALLBACK_TAIL = 40;

/**
 * Normalizes captured output and extracts the lines most likely to explain the
 * failure.
 *
 * Pure extraction, no diagnosis: the goal is to hand the LLM a small, dense
 * window instead of two megabytes of webpack progress bars.
 */
export function collectBuildLog(result: RunResult): BuildLogContext {
  const full = result.combined.replace(ANSI, "");
  const lines = full.split("\n");

  const hits: number[] = [];
  lines.forEach((line, index) => {
    if (SIGNALS.some((signal) => signal.test(line))) hits.push(index);
  });

  const errorFrame = hits.length
    ? sliceAround(lines, hits)
    : lines.slice(-FALLBACK_TAIL).filter((l) => l.trim().length > 0);

  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    command: result.command,
    full,
    errorFrame,
    truncated: result.truncated,
  };
}

/**
 * Collects context windows around each signal line, merging overlaps and
 * marking gaps so the model can tell non-adjacent excerpts apart.
 */
function sliceAround(lines: string[], hits: number[]): string[] {
  const keep = new Set<number>();
  for (const hit of hits) {
    const start = Math.max(0, hit - CONTEXT_BEFORE);
    const end = Math.min(lines.length - 1, hit + CONTEXT_AFTER);
    for (let i = start; i <= end; i++) keep.add(i);
  }

  const ordered = [...keep].sort((a, b) => a - b);
  const output: string[] = [];
  let previous = -1;
  for (const index of ordered) {
    if (previous !== -1 && index > previous + 1) output.push("…");
    output.push(lines[index] ?? "");
    previous = index;
  }
  return output;
}
