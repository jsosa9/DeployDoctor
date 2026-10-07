import fs from "node:fs";
import path from "node:path";
import type { Framework, ProjectContext } from "../types.js";

/** Reads static project metadata. Never throws — missing files degrade to nulls. */
export function collectProject(root: string): ProjectContext {
  const pkg = readJson(path.join(root, "package.json"));
  const dependencies = Object.keys(pkg?.dependencies ?? {});
  const devDependencies = Object.keys(pkg?.devDependencies ?? {});

  return {
    root,
    framework: detectFramework(root, dependencies),
    packageManager: detectPackageManager(root),
    nextVersion: pkg?.dependencies?.next ?? pkg?.devDependencies?.next ?? null,
    nodeEngine: pkg?.engines?.node ?? null,
    scripts: pkg?.scripts ?? {},
    dependencies,
    devDependencies,
    hasNextConfig: ["next.config.js", "next.config.mjs", "next.config.ts"].some((f) =>
      fs.existsSync(path.join(root, f)),
    ),
    hasTsconfig: fs.existsSync(path.join(root, "tsconfig.json")),
  };
}

function detectFramework(root: string, dependencies: string[]): Framework {
  if (!dependencies.includes("next")) return dependencies.length ? "node" : "unknown";

  // Next.js supports both routers at once, and which one a file lives under
  // changes whether its env refs reach the browser — so the distinction matters.
  const hasApp = exists(root, "app") || exists(root, "src/app");
  const hasPages = exists(root, "pages") || exists(root, "src/pages");

  if (hasApp && hasPages) return "next-mixed";
  if (hasApp) return "next-app-router";
  if (hasPages) return "next-pages-router";
  return "next-app-router";
}

function detectPackageManager(root: string): ProjectContext["packageManager"] {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(root, "package-lock.json"))) return "npm";
  return "unknown";
}

function exists(root: string, relative: string): boolean {
  return fs.existsSync(path.join(root, relative));
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
