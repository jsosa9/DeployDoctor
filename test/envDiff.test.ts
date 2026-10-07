import { describe, it, expect } from "vitest";
import { analyzeEnv } from "../src/analyze/envDiff.js";
import type { CollectedContext, EnvLocalKey, EnvRef, VercelEnvKey } from "../src/types.js";

/** Minimal context so each test states only what it's about. */
function context(partial: {
  refs?: Array<Partial<EnvRef> & { name: string }>;
  local?: Array<Partial<EnvLocalKey> & { name: string }>;
  vercel?: Array<Partial<VercelEnvKey> & { name: string }>;
}): CollectedContext {
  return {
    project: {
      root: "/tmp/p",
      framework: "next-app-router",
      packageManager: "npm",
      nextVersion: "14.2.5",
      nodeEngine: null,
      scripts: {},
      dependencies: ["next"],
      devDependencies: [],
      hasNextConfig: false,
      hasTsconfig: true,
    },
    envRefs: (partial.refs ?? []).map((ref) => ({
      file: "lib/db.ts",
      line: 1,
      context: "server" as const,
      contextReason: "test",
      ...ref,
    })),
    envLocal: (partial.local ?? []).map((key) => ({
      file: ".env.local",
      looksLikeSecret: false,
      isEmpty: false,
      ...key,
    })),
    git: {
      isRepo: false,
      branch: null,
      commits: [],
      changedFiles: [],
      diffStat: null,
      isDirty: false,
    },
    buildLog: null,
    vercel: partial.vercel
      ? {
          available: true,
          envKeys: partial.vercel.map((key) => ({ scopes: [], otherTargets: [], ...key })),
        }
      : { available: false },
    warnings: [],
  };
}

const rules = (findings: ReturnType<typeof analyzeEnv>) => findings.map((f) => f.rule);

describe("analyzeEnv", () => {
  it("flags a variable referenced in code but configured nowhere", () => {
    const findings = analyzeEnv(context({ refs: [{ name: "UPSTASH_TOKEN" }] }));
    expect(rules(findings)).toContain("env/missing");
    expect(findings[0]!.severity).toBe("error");
  });

  it("reports incomplete setup when it exists only in .env.example", () => {
    const findings = analyzeEnv(
      context({
        refs: [{ name: "DATABASE_URL" }],
        local: [{ name: "DATABASE_URL", file: ".env.example", isEmpty: true }],
      }),
    );
    expect(rules(findings)).toContain("env/setup-incomplete");
    expect(rules(findings)).not.toContain("env/missing");
  });

  it("stays silent when a variable is properly configured", () => {
    const findings = analyzeEnv(
      context({ refs: [{ name: "DATABASE_URL" }], local: [{ name: "DATABASE_URL" }] }),
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores variables the platform provides itself", () => {
    const findings = analyzeEnv(
      context({ refs: [{ name: "NODE_ENV" }, { name: "VERCEL_URL" }, { name: "CI" }] }),
    );
    expect(findings).toHaveLength(0);
  });

  it("flags a client-side reference missing the public prefix", () => {
    const findings = analyzeEnv(
      context({
        refs: [{ name: "ANALYTICS_ID", context: "client", contextReason: '"use client"' }],
        local: [{ name: "ANALYTICS_ID" }],
      }),
    );
    expect(rules(findings)).toContain("env/client-needs-public-prefix");
  });

  it("never suggests the public prefix for a credential-shaped name", () => {
    // Advising NEXT_PUBLIC_STRIPE_SECRET_KEY would publish the key to every
    // visitor — the fix text has to say the opposite.
    const findings = analyzeEnv(
      context({
        refs: [{ name: "STRIPE_SECRET_KEY", context: "client", contextReason: "pages/" }],
        local: [{ name: "STRIPE_SECRET_KEY" }],
      }),
    );
    const finding = findings.find((f) => f.rule === "env/client-needs-public-prefix")!;
    expect(finding.fix).not.toContain("NEXT_PUBLIC_STRIPE_SECRET_KEY");
    expect(finding.fix).toMatch(/server/i);
  });

  it("flags a secret exposed through the public prefix", () => {
    const findings = analyzeEnv(
      context({
        local: [{ name: "NEXT_PUBLIC_SERVICE_ROLE", looksLikeSecret: true }],
      }),
    );
    expect(rules(findings)).toContain("env/public-secret");
  });

  it("does not flag a key that is public by design", () => {
    const findings = analyzeEnv(
      context({
        local: [{ name: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", looksLikeSecret: true }],
      }),
    );
    expect(rules(findings)).not.toContain("env/public-secret");
  });

  it("notes a configured variable nothing reads", () => {
    const findings = analyzeEnv(context({ local: [{ name: "LEGACY_FLAG" }] }));
    const finding = findings.find((f) => f.rule === "env/unused")!;
    expect(finding.severity).toBe("info");
  });

  describe("with Vercel context", () => {
    it("flags a variable set locally but missing on Vercel", () => {
      const findings = analyzeEnv(
        context({
          refs: [{ name: "DATABASE_URL" }],
          local: [{ name: "DATABASE_URL" }],
          vercel: [{ name: "OTHER", scopes: ["production", "preview", "development"] }],
        }),
      );
      expect(rules(findings)).toContain("env/missing-on-vercel");
    });

    it("flags a scope gap and names the missing scope", () => {
      const findings = analyzeEnv(
        context({
          refs: [{ name: "DATABASE_URL" }],
          local: [{ name: "DATABASE_URL" }],
          vercel: [{ name: "DATABASE_URL", scopes: ["production"] }],
        }),
      );
      const finding = findings.find((f) => f.rule === "env/scope-gap")!;
      expect(finding.severity).toBe("error");
      expect(finding.title).toMatch(/preview/);
      expect(finding.title).toMatch(/development/);
    });

    it("stays silent when every scope is covered", () => {
      const findings = analyzeEnv(
        context({
          refs: [{ name: "DATABASE_URL" }],
          local: [{ name: "DATABASE_URL" }],
          vercel: [{ name: "DATABASE_URL", scopes: ["production", "preview", "development"] }],
        }),
      );
      expect(findings).toHaveLength(0);
    });
  });

  describe("redundant note suppression", () => {
    it("does not also report an exposed secret as unused", () => {
      // The bug this covers: NEXT_PUBLIC_STRIPE_SECRET_KEY was reported as a
      // security error and then again as "configured but never read" — true,
      // but noise sitting directly under the finding that actually matters.
      const findings = analyzeEnv(
        context({
          local: [{ name: "NEXT_PUBLIC_STRIPE_SECRET_KEY", looksLikeSecret: true }],
        }),
      );
      expect(rules(findings)).toContain("env/public-secret");
      expect(rules(findings)).not.toContain("env/unused");
      expect(findings).toHaveLength(1);
    });

    it("still reports an unused variable that has no other finding", () => {
      const findings = analyzeEnv(context({ local: [{ name: "OLD_FEATURE_FLAG" }] }));
      expect(rules(findings)).toEqual(["env/unused"]);
    });

    it("suppresses the note per-variable, not globally", () => {
      // One variable having an error must not silence notes about a different
      // variable.
      const findings = analyzeEnv(
        context({
          local: [
            { name: "NEXT_PUBLIC_SERVICE_ROLE", looksLikeSecret: true },
            { name: "OLD_FEATURE_FLAG" },
          ],
        }),
      );
      expect(rules(findings)).toContain("env/public-secret");
      const unused = findings.filter((f) => f.rule === "env/unused");
      expect(unused).toHaveLength(1);
      expect(unused[0]!.envVar).toBe("OLD_FEATURE_FLAG");
    });

    it("suppresses a context-unclear note when the variable is also missing", () => {
      // Generalizes beyond the public-secret case: any error outranks a note
      // about the same variable.
      const findings = analyzeEnv(
        context({
          refs: [{ name: "API_URL", context: "unknown", contextReason: "shared module" }],
        }),
      );
      expect(rules(findings)).toContain("env/missing");
      expect(rules(findings)).not.toContain("env/context-unclear");
    });

    it("tags every finding with the variable it concerns", () => {
      const findings = analyzeEnv(
        context({ refs: [{ name: "UPSTASH_TOKEN" }], local: [{ name: "LEGACY" }] }),
      );
      expect(findings.every((finding) => typeof finding.envVar === "string")).toBe(true);
    });
  });

  it("sorts errors ahead of notes", () => {
    const findings = analyzeEnv(
      context({ refs: [{ name: "MISSING_ONE" }], local: [{ name: "UNUSED_ONE" }] }),
    );
    expect(findings[0]!.severity).toBe("error");
    expect(findings.at(-1)!.severity).toBe("info");
  });
});
