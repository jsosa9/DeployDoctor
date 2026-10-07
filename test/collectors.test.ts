import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectEnvRefs } from "../src/collectors/envRefs.js";
import { collectEnvLocal } from "../src/collectors/envLocal.js";
import { collectProject } from "../src/collectors/project.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, "fixtures", name);

describe("collectEnvRefs", () => {
  it("finds references and records their locations", () => {
    const refs = collectEnvRefs(fixture("missing-env"));
    const names = refs.map((ref) => ref.name);
    expect(names).toContain("DATABASE_URL");
    expect(names).toContain("UPSTASH_TOKEN");
    expect(names).toContain("NEXT_PUBLIC_SITE_NAME");

    const dbRef = refs.find((ref) => ref.name === "DATABASE_URL")!;
    expect(dbRef.file).toBe(path.join("lib", "db.ts"));
    expect(dbRef.line).toBe(1);
  });

  it("classifies a \"use client\" file as client code", () => {
    const refs = collectEnvRefs(fixture("public-secret"));
    const ref = refs.find((r) => r.name === "ANALYTICS_ID")!;
    expect(ref.context).toBe("client");
    expect(ref.contextReason).toMatch(/use client/);
  });

  it("classifies a pages/ component as client code", () => {
    const refs = collectEnvRefs(fixture("public-secret"));
    const ref = refs.find((r) => r.name === "STRIPE_SECRET_KEY")!;
    expect(ref.context).toBe("client");
  });

  it("classifies an app/ file as server code", () => {
    const refs = collectEnvRefs(fixture("clean"));
    const ref = refs.find((r) => r.name === "NEXT_PUBLIC_SITE_NAME")!;
    expect(ref.context).toBe("server");
  });

  it("finds destructured references", () => {
    // Covered here rather than in a fixture tree because the syntax, not the
    // file layout, is what's under test.
    const refs = collectEnvRefs(fixture("destructured"));
    const names = refs.map((r) => r.name);
    expect(names).toContain("API_URL");
    expect(names).toContain("API_SECRET");
  });

  it("finds bracket-notation references", () => {
    const refs = collectEnvRefs(fixture("destructured"));
    expect(refs.map((r) => r.name)).toContain("BRACKET_VAR");
  });

  it("ignores commented-out references", () => {
    const refs = collectEnvRefs(fixture("destructured"));
    expect(refs.map((r) => r.name)).not.toContain("COMMENTED_OUT");
  });
});

describe("collectEnvLocal", () => {
  it("returns names without ever returning values", () => {
    const keys = collectEnvLocal(fixture("public-secret"));
    const serialized = JSON.stringify(keys);
    expect(serialized).not.toContain("sk_live_");
    expect(serialized).not.toContain("eyJhbGci");
    expect(keys.map((k) => k.name)).toContain("STRIPE_SECRET_KEY");
  });

  it("marks credential-shaped values as secrets", () => {
    const keys = collectEnvLocal(fixture("public-secret"));
    expect(keys.find((k) => k.name === "STRIPE_SECRET_KEY")!.looksLikeSecret).toBe(true);
    expect(
      keys.find((k) => k.name === "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE")!.looksLikeSecret,
    ).toBe(true);
  });

  it("does not mark ordinary config as a secret", () => {
    const keys = collectEnvLocal(fixture("public-secret"));
    expect(keys.find((k) => k.name === "UNUSED_LEGACY_FLAG")!.looksLikeSecret).toBe(false);
  });

  it("records which file each key came from", () => {
    const keys = collectEnvLocal(fixture("missing-env"));
    expect(keys.find((k) => k.file === ".env.example")).toBeDefined();
    expect(keys.find((k) => k.file === ".env.local")).toBeDefined();
  });

  it("treats an empty value as empty", () => {
    const keys = collectEnvLocal(fixture("missing-env"));
    expect(keys.find((k) => k.name === "DATABASE_URL" && k.file === ".env.example")!.isEmpty).toBe(
      true,
    );
  });
});

describe("collectProject", () => {
  it("detects the App Router", () => {
    expect(collectProject(fixture("clean")).framework).toBe("next-app-router");
  });

  it("detects the Pages Router", () => {
    expect(collectProject(fixture("public-secret")).framework).toBe("next-pages-router");
  });

  it("reads the Next version and build script", () => {
    const project = collectProject(fixture("clean"));
    expect(project.nextVersion).toBe("14.2.5");
    expect(project.scripts.build).toBe("next build");
  });

  it("degrades to unknown rather than throwing on a missing project", () => {
    const project = collectProject(fixture("does-not-exist"));
    expect(project.framework).toBe("unknown");
    expect(project.dependencies).toEqual([]);
  });
});
