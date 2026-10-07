import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiagnosisSchema } from "../src/llm/types.js";
import { SYSTEM_PROMPT, buildUserMessage } from "../src/llm/prompt.js";
import { buildPayload } from "../src/analyze/payload.js";
import { analyzeEnv } from "../src/analyze/envDiff.js";
import { run } from "../src/commands/run.js";
import type { Diagnosis, LlmProvider } from "../src/llm/types.js";
import type { CollectedContext } from "../src/types.js";
import type { DiagnosisPayload } from "../src/analyze/payload.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Run against a fixture so findings don't depend on this repo's own source. */
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "clean",
);

/**
 * The adapter's real network call is unverified — these cover the contract
 * around it: that a well-formed response parses, that a malformed one is
 * rejected rather than half-rendered, and that the command degrades when the
 * call fails.
 */

const validDiagnosis: Diagnosis = {
  summary: "Your Supabase client got an undefined URL.",
  rootCause:
    "lib/supabase.ts reads NEXT_PUBLIC_SUPABASE_URL at module scope, so it runs during the build. The variable is configured for production but not preview.",
  confidence: "high",
  fixSteps: [
    {
      description: "Add the variable to the Preview environment",
      command: "vercel env add NEXT_PUBLIC_SUPABASE_URL preview",
      file: null,
    },
    { description: "Move the client creation inside a function", command: null, file: "lib/supabase.ts:4" },
  ],
  relatedFindings: ["SENTRY_DSN is also missing from development"],
};

describe("DiagnosisSchema", () => {
  it("accepts a well-formed diagnosis", () => {
    expect(DiagnosisSchema.parse(validDiagnosis)).toEqual(validDiagnosis);
  });

  it("accepts null command and file on a fix step", () => {
    // Not every step is a command — some are an edit, some are neither.
    const parsed = DiagnosisSchema.parse({
      ...validDiagnosis,
      fixSteps: [{ description: "Rotate the leaked key", command: null, file: null }],
    });
    expect(parsed.fixSteps[0]!.command).toBeNull();
  });

  it("accepts an empty fixSteps list", () => {
    // A low-confidence diagnosis may legitimately have no concrete steps.
    expect(() =>
      DiagnosisSchema.parse({ ...validDiagnosis, fixSteps: [], confidence: "low" }),
    ).not.toThrow();
  });

  it("rejects a confidence value outside the enum", () => {
    expect(() => DiagnosisSchema.parse({ ...validDiagnosis, confidence: "certain" })).toThrow();
  });

  it("rejects a missing rootCause", () => {
    const { rootCause, ...rest } = validDiagnosis;
    expect(() => DiagnosisSchema.parse(rest)).toThrow();
  });

  it("rejects a fix step missing its description", () => {
    expect(() =>
      DiagnosisSchema.parse({
        ...validDiagnosis,
        fixSteps: [{ command: "npm install", file: null }],
      }),
    ).toThrow();
  });
});

describe("prompt", () => {
  it("contains nothing volatile, so it stays cacheable", () => {
    // A timestamp or project name here would invalidate the cache breakpoint
    // on every single invocation.
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(SYSTEM_PROMPT).not.toMatch(/\d{10,}/);
  });

  it("is byte-identical across reads", () => {
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT);
  });

  it("instructs the model that it never sees values", () => {
    // The model must not invent a value it was never given.
    expect(SYSTEM_PROMPT).toMatch(/never see|only names/i);
  });

  it("embeds the payload as parseable JSON", () => {
    const message = buildUserMessage(samplePayload());
    const json = message.slice(message.indexOf("{"), message.lastIndexOf("}") + 1);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe("run with a stubbed provider", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const output = () => logs.join("\n");

  it("skips the provider entirely when the command succeeds", async () => {
    const diagnose = vi.fn();
    const exitCode = await run(["echo ok"], {
      cwd: FIXTURE,
      vercel: false,
      provider: { diagnose } as LlmProvider,
    });
    expect(exitCode).toBe(0);
    expect(diagnose).not.toHaveBeenCalled();
  });

  it("renders the diagnosis when the command fails", async () => {
    const provider: LlmProvider = { diagnose: async () => validDiagnosis };
    const exitCode = await run(['echo "Error: boom" >&2; exit 3'], {
      cwd: FIXTURE,
      vercel: false,
      provider,
    });

    expect(exitCode).toBe(3);
    expect(output()).toContain("Your Supabase client got an undefined URL");
    expect(output()).toContain("vercel env add NEXT_PUBLIC_SUPABASE_URL preview");
    expect(output()).toContain("lib/supabase.ts:4");
    expect(output()).toContain("SENTRY_DSN is also missing");
  });

  it("passes a redacted payload to the provider", async () => {
    let received: DiagnosisPayload | null = null;
    const provider: LlmProvider = {
      diagnose: async (payload) => {
        received = payload;
        return validDiagnosis;
      },
    };

    await run(
      ['echo "DB=postgres://admin:hunter2@h:5432/d"; echo "Error: boom"; exit 1'],
      { cwd: FIXTURE, vercel: false, provider },
    );

    expect(received).not.toBeNull();
    const serialized = JSON.stringify(received);
    // The secret appears in two places: the log line and the command string
    // itself. Both have to be scrubbed.
    expect(serialized).not.toContain("hunter2");
    expect(received!.failure!.command).not.toContain("hunter2");
    expect(received!.failure!.errorFrame.join("\n")).not.toContain("hunter2");
    expect(serialized).toContain("boom");
  });

  it("still reports the build failure when the provider throws", async () => {
    // A failed analysis must not swallow the exit code or the deterministic
    // findings — the user came here because their build broke.
    const provider: LlmProvider = {
      diagnose: async () => {
        throw new Error("401 authentication_error");
      },
    };
    const exitCode = await run(['echo "Error: boom"; exit 7'], {
      cwd: FIXTURE,
      vercel: false,
      provider,
    });

    expect(exitCode).toBe(7);
    expect(output()).toContain("401 authentication_error");
    expect(output()).toContain("failed with exit code 7");
  });

  it("prints a setup hint and still exits correctly with no provider", async () => {
    const exitCode = await run(['echo "Error: boom"; exit 1'], {
      cwd: FIXTURE,
      vercel: false,
      provider: null,
    });
    expect(exitCode).toBe(1);
    expect(output()).toMatch(/ANTHROPIC_API_KEY|auth llm/);
  });

  it("sends nothing in dry-run mode", async () => {
    const diagnose = vi.fn();
    await run(['echo "Error: boom"; exit 1'], {
      cwd: FIXTURE,
      vercel: false,
      dryRun: true,
      provider: { diagnose } as LlmProvider,
    });
    expect(diagnose).not.toHaveBeenCalled();
    expect(output()).toContain("===DEPLOYDOCTOR_PAYLOAD===");
  });
});

/** A minimal payload for prompt-shape assertions. */
function samplePayload(): DiagnosisPayload {
  const context: CollectedContext = {
    project: {
      root: "/tmp/p",
      framework: "next-app-router",
      packageManager: "npm",
      nextVersion: "14.2.5",
      nodeEngine: null,
      scripts: { build: "next build" },
      dependencies: ["next"],
      devDependencies: [],
      hasNextConfig: false,
      hasTsconfig: true,
    },
    envRefs: [
      {
        name: "DATABASE_URL",
        file: "lib/db.ts",
        line: 1,
        context: "server",
        contextReason: "server-side module path",
      },
    ],
    envLocal: [],
    git: {
      isRepo: false,
      branch: null,
      commits: [],
      changedFiles: [],
      diffStat: null,
      isDirty: false,
    },
    buildLog: null,
    vercel: { available: false },
    warnings: [],
  };
  return buildPayload(context, analyzeEnv(context));
}
