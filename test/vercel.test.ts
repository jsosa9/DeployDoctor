import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectVercel,
  extractEnvKeys,
  extractDeployments,
  resolveProject,
  NO_TOKEN_MESSAGE,
  TOKEN_URL,
} from "../src/collectors/vercel.js";
import { analyzeEnv } from "../src/analyze/envDiff.js";
import { vercelInspect } from "../src/commands/vercel.js";
import { buildPayload } from "../src/analyze/payload.js";
import { projectResponse, deploymentsResponse, recordedFetch } from "./fixtures/vercel-responses.js";
import type { CollectedContext } from "../src/types.js";

/**
 * These tests exercise the collector against hand-built responses matching the
 * documented API shape. They prove the parsing, the scope logic, and the
 * value-dropping guarantee. They do NOT prove the live endpoints return this
 * shape — that needs a real token and a linked project.
 */

/** Env vars the collector reads, saved and restored around each test. */
const MANAGED = ["VERCEL_TOKEN", "VERCEL_PROJECT_ID", "VERCEL_ORG_ID"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((key) => [key, process.env[key]]));
  for (const key of MANAGED) delete process.env[key];
});

afterEach(() => {
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("extractEnvKeys", () => {
  it("collects each key with its target scopes", () => {
    const keys = extractEnvKeys(projectResponse);
    const byName = new Map(keys.map((key) => [key.name, key.scopes]));

    expect(byName.get("DATABASE_URL")).toEqual(["production"]);
    expect(byName.get("NEXT_PUBLIC_SITE_URL")!.sort()).toEqual([
      "development",
      "preview",
      "production",
    ]);
    expect(byName.get("STRIPE_SECRET_KEY")!.sort()).toEqual(["preview", "production"]);
  });

  it("merges multiple entries for the same key", () => {
    // Vercel returns one entry per target; a key set for two environments
    // arrives as two rows that have to collapse into one finding.
    const keys = extractEnvKeys(projectResponse);
    const sentry = keys.filter((key) => key.name === "SENTRY_DSN");
    expect(sentry).toHaveLength(1);
    expect(sentry[0]!.scopes.sort()).toEqual(["preview", "production"]);
  });

  it("handles target arriving as a bare string", () => {
    const keys = extractEnvKeys(projectResponse);
    expect(keys.find((key) => key.name === "LEGACY_FLAG")!.scopes).toEqual(["development"]);
  });

  it("keeps custom-environment targets separate from standard scopes", () => {
    const keys = extractEnvKeys(projectResponse);
    const staging = keys.find((key) => key.name === "STAGING_ONLY")!;
    expect(staging.scopes).toEqual([]);
    expect(staging.otherTargets).toEqual(["custom-staging"]);
  });

  it("skips malformed entries without throwing", () => {
    expect(() => extractEnvKeys(projectResponse)).not.toThrow();
    expect(extractEnvKeys(projectResponse).every((key) => typeof key.name === "string")).toBe(true);
  });

  it("drops the value even when the API returns one", () => {
    // The privacy boundary. The fixture deliberately includes `value` fields;
    // none may survive into the collector's output.
    const serialized = JSON.stringify(extractEnvKeys(projectResponse));
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sk_live_");
    expect(serialized).not.toContain("value");
    expect(serialized).toContain("DATABASE_URL");
  });

  it("returns an empty list for a project with no env block", () => {
    expect(extractEnvKeys({ name: "x" })).toEqual([]);
    expect(extractEnvKeys(null)).toEqual([]);
  });
});

describe("extractDeployments", () => {
  it("reads state, target, and commit metadata", () => {
    const deployments = extractDeployments(deploymentsResponse);
    expect(deployments[0]).toMatchObject({
      id: "dpl_fail1",
      state: "ERROR",
      target: "preview",
      commitSha: "a1b2c3d4e5f6",
    });
  });

  it("falls back to readyState and tolerates missing git metadata", () => {
    const deployments = extractDeployments(deploymentsResponse);
    const bare = deployments.find((d) => d.id === "dpl_bare")!;
    expect(bare.state).toBe("READY");
    expect(bare.commitSha).toBeNull();
    expect(bare.target).toBeNull();
  });

  it("returns an empty list when the response has no deployments", () => {
    expect(extractDeployments({})).toEqual([]);
  });
});

describe("resolveProject", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-vercel-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeProjectJson = (contents: object) => {
    fs.mkdirSync(path.join(dir, ".vercel"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".vercel", "project.json"), JSON.stringify(contents));
  };

  it("reads projectId from .vercel/project.json", () => {
    writeProjectJson({ projectId: "prj_abc123", orgId: "team_xyz" });
    expect(resolveProject(dir)).toEqual({ projectId: "prj_abc123", teamId: "team_xyz" });
  });

  it("omits a personal-account orgId rather than sending it as a teamId", () => {
    // `orgId` is a team id for teams and a user id for personal accounts.
    // Sending a user id as teamId gets rejected, so it must be dropped.
    writeProjectJson({ projectId: "prj_abc123", orgId: "I9vQ8personalUser" });
    expect(resolveProject(dir)).toEqual({ projectId: "prj_abc123" });
  });

  it("returns null when the file is absent", () => {
    expect(resolveProject(dir)).toBeNull();
  });

  it("returns null when the file is malformed", () => {
    fs.mkdirSync(path.join(dir, ".vercel"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".vercel", "project.json"), "{not json");
    expect(resolveProject(dir)).toBeNull();
  });

  it("returns null when projectId is missing", () => {
    writeProjectJson({ orgId: "team_xyz" });
    expect(resolveProject(dir)).toBeNull();
  });

  it("lets VERCEL_PROJECT_ID override the file", () => {
    writeProjectJson({ projectId: "prj_from_file" });
    process.env.VERCEL_PROJECT_ID = "prj_from_env";
    expect(resolveProject(dir)!.projectId).toBe("prj_from_env");
  });
});

describe("collectVercel", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-collect-"));
    fs.mkdirSync(path.join(dir, ".vercel"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_abc123", orgId: "team_xyz" }),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("names the token URL inline when no token is set", async () => {
    // The error message is the real documentation — most users never open the
    // README, so the URL has to be in the message itself.
    const context = await collectVercel(dir);
    expect(context.available).toBe(false);
    expect(context.unavailableReason).toContain(TOKEN_URL);
    expect(NO_TOKEN_MESSAGE).toContain("export VERCEL_TOKEN=");
  });

  it("explains how to link when the project can't be resolved", async () => {
    process.env.VERCEL_TOKEN = "tok";
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dd-unlinked-"));
    const context = await collectVercel(empty, recordedFetch().impl);
    expect(context.available).toBe(false);
    expect(context.unavailableReason).toContain("vercel link");
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it("assembles a context from the recorded responses", async () => {
    process.env.VERCEL_TOKEN = "tok";
    const context = await collectVercel(dir, recordedFetch().impl);

    expect(context.available).toBe(true);
    expect(context.projectName).toBe("my-storefront");
    expect(context.nodeVersion).toBe("20.x");
    expect(context.envKeys!.length).toBeGreaterThan(0);
    expect(context.deployments![0]!.state).toBe("ERROR");
  });

  it("sends the token as a bearer header and never in the URL", async () => {
    process.env.VERCEL_TOKEN = "tok_secret_value";
    const recorder = recordedFetch();
    await collectVercel(dir, recorder.impl);
    expect(recorder.calls.length).toBeGreaterThan(0);
    for (const url of recorder.calls) {
      expect(url).not.toContain("tok_secret_value");
    }
  });

  it("never requests decrypted values", async () => {
    process.env.VERCEL_TOKEN = "tok";
    const recorder = recordedFetch();
    await collectVercel(dir, recorder.impl);
    for (const url of recorder.calls) {
      expect(url).not.toContain("decrypt");
    }
  });

  it("forwards the team id as a query parameter", async () => {
    process.env.VERCEL_TOKEN = "tok";
    const recorder = recordedFetch();
    await collectVercel(dir, recorder.impl);
    expect(recorder.calls.some((url) => url.includes("teamId=team_xyz"))).toBe(true);
  });

  it("points at the token page when the token is rejected", async () => {
    process.env.VERCEL_TOKEN = "bad";
    const context = await collectVercel(dir, recordedFetch({ status: 403 }).impl);
    expect(context.available).toBe(false);
    expect(context.unavailableReason).toContain(TOKEN_URL);
    expect(context.unavailableReason).toMatch(/scoped to the right team/);
  });

  it("degrades instead of throwing on a server error", async () => {
    process.env.VERCEL_TOKEN = "tok";
    const context = await collectVercel(
      dir,
      recordedFetch({ status: 500, statusText: "Internal Server Error" }).impl,
    );
    expect(context.available).toBe(false);
    expect(context.unavailableReason).toContain("500");
  });

  it("degrades instead of throwing when the network fails", async () => {
    process.env.VERCEL_TOKEN = "tok";
    const failing = async () => {
      throw new Error("ENOTFOUND api.vercel.com");
    };
    const context = await collectVercel(dir, failing as never);
    expect(context.available).toBe(false);
    expect(context.unavailableReason).toContain("ENOTFOUND");
  });
});

describe("scope-gap detection end to end", () => {
  /** Builds a context whose Vercel half came from the recorded response. */
  function contextFromRecorded(refNames: string[]): CollectedContext {
    return {
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
      envRefs: refNames.map((name) => ({
        name,
        file: "lib/db.ts",
        line: 1,
        context: "server" as const,
        contextReason: "server-side module path",
      })),
      envLocal: refNames.map((name) => ({
        name,
        file: ".env.local",
        looksLikeSecret: false,
        isEmpty: false,
      })),
      git: {
        isRepo: true,
        branch: "add-dashboard",
        commits: [],
        changedFiles: [],
        diffStat: null,
        isDirty: false,
      },
      buildLog: null,
      vercel: { available: true, envKeys: extractEnvKeys(projectResponse) },
      warnings: [],
    };
  }

  it("flags a production-only variable as missing from preview and development", () => {
    // The highest-value finding in the product: builds in Production, fails
    // in Preview.
    const findings = analyzeEnv(contextFromRecorded(["DATABASE_URL"]));
    const gap = findings.find((f) => f.rule === "env/scope-gap")!;
    expect(gap.severity).toBe("error");
    expect(gap.title).toMatch(/preview/);
    expect(gap.title).toMatch(/development/);
    expect(gap.fix).toMatch(/Vercel dashboard/);
  });

  it("flags only the one missing scope when two are covered", () => {
    const findings = analyzeEnv(contextFromRecorded(["STRIPE_SECRET_KEY"]));
    const gap = findings.find((f) => f.rule === "env/scope-gap")!;
    expect(gap.title).toMatch(/development/);
    expect(gap.title).not.toMatch(/preview/);
  });

  it("does not claim a custom-environment variable is missing everywhere", () => {
    // Parsing to zero standard scopes used to produce a confident
    // "missing from production, preview, and development" error.
    const findings = analyzeEnv(contextFromRecorded(["STAGING_ONLY"]));
    expect(findings.find((f) => f.rule === "env/scope-gap")).toBeUndefined();
    const note = findings.find((f) => f.rule === "env/custom-environment-only")!;
    expect(note.severity).toBe("info");
    expect(note.title).toMatch(/custom-staging/);
  });

  it("stays silent for a variable configured in all three scopes", () => {
    const findings = analyzeEnv(contextFromRecorded(["NEXT_PUBLIC_SITE_URL"]));
    expect(findings.find((f) => f.rule === "env/scope-gap")).toBeUndefined();
  });

  it("keeps Vercel values out of the outgoing payload", () => {
    const context = contextFromRecorded(["DATABASE_URL", "STRIPE_SECRET_KEY"]);
    const serialized = JSON.stringify(buildPayload(context, analyzeEnv(context)));
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("sk_live_");
    expect(serialized).toContain("DATABASE_URL");
  });
});

describe("vercel inspect command", () => {
  let dir: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dd-inspect-"));
    fs.mkdirSync(path.join(dir, ".vercel"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_abc123", orgId: "team_xyz" }),
    );
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const output = () => logs.join("\n");

  it("prints the project, deployments, and env var scopes", async () => {
    process.env.VERCEL_TOKEN = "tok";
    const code = await vercelInspect({ cwd: dir, fetchImpl: recordedFetch().impl });

    expect(code).toBe(0);
    expect(output()).toContain("my-storefront");
    expect(output()).toContain("DATABASE_URL");
    expect(output()).toContain("ERROR");
    expect(output()).toContain("add dashboard");
  });

  it("calls out variables set for only some environments", async () => {
    process.env.VERCEL_TOKEN = "tok";
    await vercelInspect({ cwd: dir, fetchImpl: recordedFetch().impl });
    expect(output()).toMatch(/set for some environments but not others/);
  });

  it("never prints a value, even though the fixture contains them", async () => {
    // The point of this command is manual comparison against the dashboard,
    // so its output has to be safe to paste anywhere.
    process.env.VERCEL_TOKEN = "tok";
    await vercelInspect({ cwd: dir, fetchImpl: recordedFetch().impl });
    expect(output()).not.toContain("hunter2");
    expect(output()).not.toContain("sk_live_");
    expect(output()).not.toContain("eyJ");
  });

  it("keeps values out of --json output too", async () => {
    process.env.VERCEL_TOKEN = "tok";
    await vercelInspect({ cwd: dir, json: true, fetchImpl: recordedFetch().impl });
    expect(output()).not.toContain("hunter2");
    expect(output()).not.toContain("sk_live_");
    expect(JSON.parse(output())).toHaveProperty("envKeys");
  });

  it("exits non-zero and explains why when the token is missing", async () => {
    delete process.env.VERCEL_TOKEN;
    const code = await vercelInspect({ cwd: dir, fetchImpl: recordedFetch().impl });
    expect(code).toBe(1);
    expect(output()).toContain(TOKEN_URL);
  });
});
