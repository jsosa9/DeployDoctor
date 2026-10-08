import { describe, it, expect } from "vitest";
import { run, formatCommand } from "../src/runner/spawn.js";
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

/**
 * argv arrives with the caller's shell quoting already stripped, and the
 * command then goes back through a shell. Without re-quoting, that second
 * parse re-splits arguments and the failure output disappears — leaving the
 * diagnosis with an empty error frame and nothing to explain.
 */
describe("formatCommand", () => {
  it("passes a lone command string through untouched", () => {
    expect(formatCommand(["npm run build && next start"])).toBe(
      "npm run build && next start",
    );
  });

  it("leaves ordinary words unquoted, so the echo reads like what was typed", () => {
    expect(formatCommand(["npm", "run", "build"])).toBe("npm run build");
  });

  it("leaves a build command's own flags unquoted", () => {
    expect(formatCommand(["next", "build", "--debug"])).toBe("next build --debug");
    expect(formatCommand(["tsc", "-p", "tsconfig.build.json"])).toBe(
      "tsc -p tsconfig.build.json",
    );
  });

  it("quotes an argument containing spaces", () => {
    expect(formatCommand(["sh", "-c", "echo hi; exit 1"])).toBe("sh -c 'echo hi; exit 1'");
  });

  it("escapes an embedded single quote", () => {
    expect(formatCommand(["sh", "-c", "echo 'hi'"])).toBe(`sh -c 'echo '\\''hi'\\'''`);
  });

  it("handles empty argv", () => {
    expect(formatCommand([])).toBe("");
  });
});

describe("quoting survives the shell round trip", () => {
  it("keeps a multi-argument command's error output intact", async () => {
    // This is the regression: joined raw, the shell ran `sh -c echo` and the
    // error never appeared, so collectBuildLog had nothing to extract.
    const result = await run(["sh", "-c", 'echo "Error: boom"; exit 1'], process.cwd());
    expect(result.exitCode).toBe(1);
    expect(result.combined).toContain("Error: boom");
    expect(collectBuildLog(result).errorFrame.join("\n")).toContain("Error: boom");
  });

  it("preserves a value containing spaces", async () => {
    const result = await run(["echo", "a b c"], process.cwd());
    expect(result.stdout.trim()).toBe("a b c");
  });

  it("still honors shell operators in a single-argument command", async () => {
    const result = await run(["echo one && echo two"], process.cwd());
    expect(result.stdout).toContain("one");
    expect(result.stdout).toContain("two");
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
