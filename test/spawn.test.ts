import { describe, it, expect } from "vitest";
import { run } from "../src/runner/spawn.js";
import { collectBuildLog } from "../src/collectors/buildLog.js";

/**
 * The wrapper's contract is transparency: whatever the bare command would have
 * done, `deploydoctor run` must do. If that breaks, nobody puts this in front
 * of their build.
 */
describe("run", () => {
  it("captures stdout and reports success", async () => {
    const result = await run(["echo", "hello"], process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("forwards a non-zero exit code verbatim", async () => {
    const result = await run(["exit", "42"], process.cwd());
    expect(result.exitCode).toBe(42);
  });

  it("keeps stdout and stderr separate", async () => {
    const result = await run(["echo out; echo err >&2"], process.cwd());
    expect(result.stdout).toContain("out");
    expect(result.stdout).not.toContain("err");
    expect(result.stderr).toContain("err");
  });

  it("captures both streams in the combined log", async () => {
    const result = await run(["echo out; echo err >&2"], process.cwd());
    expect(result.combined).toContain("out");
    expect(result.combined).toContain("err");
  });

  it("measures duration", async () => {
    const result = await run(["echo hi"], process.cwd());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("collectBuildLog", () => {
  it("strips ANSI escape codes", async () => {
    // Build tools colorize their output; the model should see the text, not
    // the escape sequences.
    const esc = String.fromCharCode(27);
    const result = await run([`printf '${esc}[31mred error${esc}[0m\\n'`], process.cwd());
    const log = collectBuildLog(result);
    expect(log.full).toContain("red error");
    expect(log.full).not.toContain("[31m");
  });

  it("extracts the error frame around a signal line", async () => {
    const result = await run(
      ['echo a; echo b; echo c; echo "Error: the real problem"; echo d; exit 1'],
      process.cwd(),
    );
    const log = collectBuildLog(result);
    const frame = log.errorFrame.join("\n");
    expect(frame).toContain("Error: the real problem");
    expect(frame).toContain("d");
  });

  it("falls back to the tail when nothing matches a signal", async () => {
    const result = await run(["echo just some output; exit 1"], process.cwd());
    const log = collectBuildLog(result);
    expect(log.errorFrame.join("\n")).toContain("just some output");
  });

  it("recognizes a TypeScript error as a signal", async () => {
    const result = await run(
      ["echo 'src/a.ts(3,10): error TS2345: bad arg'; exit 2"],
      process.cwd(),
    );
    const log = collectBuildLog(result);
    expect(log.errorFrame.join("\n")).toContain("TS2345");
    expect(log.exitCode).toBe(2);
  });

  it("recognizes a missing module as a signal", async () => {
    const result = await run(
      ["echo \"Module not found: Can't resolve 'next/navigation'\"; exit 1"],
      process.cwd(),
    );
    const log = collectBuildLog(result);
    expect(log.errorFrame.join("\n")).toContain("Module not found");
  });
});
