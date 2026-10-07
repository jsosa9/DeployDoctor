import { spawn as nodeSpawn } from "node:child_process";

/** Max bytes retained per stream. Build logs routinely exceed this. */
const BUFFER_CAP = 2 * 1024 * 1024;

export interface RunResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Interleaved stdout+stderr in the order it was emitted. */
  combined: string;
  durationMs: number;
  truncated: boolean;
}

/**
 * A byte-capped append-only buffer.
 *
 * Keeps the *tail* rather than the head: when a build dies, the explanation is
 * at the end of the log, and webpack/tsc can emit megabytes of progress noise
 * before getting there.
 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > BUFFER_CAP && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.size -= dropped.length;
      this.truncated = true;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Runs the user's command, streaming its output through to the terminal
 * unchanged while retaining a copy for analysis.
 *
 * Transparency is the contract here: stdout stays on stdout, stderr stays on
 * stderr, the child's exit code is returned for the caller to re-exit with, and
 * signals are forwarded so Ctrl-C behaves as it would without the wrapper.
 * Anything less and people won't put this in front of their builds.
 */
export function run(argv: string[], cwd: string): Promise<RunResult> {
  const command = argv.join(" ");
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    // `shell: true` so `npm run build && next start` and friends work as typed.
    const child = nodeSpawn(command, {
      cwd,
      shell: true,
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });

    const out = new TailBuffer();
    const err = new TailBuffer();
    const both = new TailBuffer();

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      out.append(chunk);
      both.append(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      err.append(chunk);
      both.append(chunk);
    });

    // Forward termination signals to the child instead of dying and orphaning
    // it. The child's own exit then drives ours, preserving normal semantics.
    const forward = (signal: NodeJS.Signals) => () => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = forward("SIGINT");
    const onSigterm = forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      cleanup();
      resolve({
        command,
        exitCode,
        signal,
        stdout: out.toString(),
        stderr: err.toString(),
        combined: both.toString(),
        durationMs: Date.now() - startedAt,
        truncated: out.truncated || err.truncated,
      });
    });
  });
}
