import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCwd } from "../src/resolveCwd.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

/**
 * The failure these cases guard against is silent: collectors degrade rather
 * than throw, so an unusable --cwd would otherwise reach the user as a clean
 * bill of health for a directory that was never read.
 */
describe("resolveCwd", () => {
  it("falls back to the process directory when the flag is absent", () => {
    expect(resolveCwd(undefined)).toBe(process.cwd());
  });

  it("resolves a relative path to an absolute one", () => {
    const resolved = resolveCwd("test/fixtures/clean");
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(path.join(process.cwd(), "test/fixtures/clean"));
  });

  it("accepts an absolute path unchanged", () => {
    const absolute = path.join(repoRoot, "test", "fixtures", "clean");
    expect(resolveCwd(absolute)).toBe(absolute);
  });

  it("throws rather than silently analyzing nothing when the path is missing", () => {
    expect(() => resolveCwd("test/fixtures/does-not-exist")).toThrow(
      /--cwd: no such directory/,
    );
  });

  it("names the resolved path in the error, so a typo is obvious", () => {
    expect(() => resolveCwd("test/fixtures/typoo")).toThrow(/typoo/);
  });

  it("rejects a file where a directory is required", () => {
    expect(() => resolveCwd("package.json")).toThrow(/--cwd: not a directory/);
  });
});
