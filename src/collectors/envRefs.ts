import fs from "node:fs";
import path from "node:path";
import type { EnvRef, RefContext } from "../types.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** Directories never worth walking. Cheaper than consulting .gitignore. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".vercel",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".cache",
]);

/** `process.env.FOO` */
const DOT_ACCESS = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
/** `process.env["FOO"]` / `process.env['FOO']` */
const BRACKET_ACCESS = /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g;
/** `const { FOO, BAR } = process.env` — captures the whole brace group. */
const DESTRUCTURE = /\{([^{}]*)\}\s*=\s*process\.env/g;

/**
 * Scans the project's source for env var references.
 *
 * This is regex-based by design: a TS AST pass would be far more code for a
 * marginal gain, since real code reaches for `process.env.FOO` the overwhelming
 * majority of the time. The documented cost is that fully dynamic access
 * (`process.env[key]`) and re-exported config objects are invisible to us.
 */
export function collectEnvRefs(root: string): EnvRef[] {
  const refs: EnvRef[] = [];
  for (const file of walk(root)) {
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue; // Unreadable file is not worth failing a diagnosis over.
    }
    const relative = path.relative(root, file);
    const { context, reason } = classifyFile(relative, source);
    for (const found of findInSource(source)) {
      refs.push({
        name: found.name,
        file: relative,
        line: found.line,
        context,
        contextReason: reason,
      });
    }
  }
  return refs;
}

interface RawRef {
  name: string;
  line: number;
}

/** Finds every env reference in one file's text, with line numbers. */
function findInSource(source: string): RawRef[] {
  const found: RawRef[] = [];
  const lines = source.split("\n");

  lines.forEach((text, index) => {
    const line = index + 1;

    // A line-level comment check. Crude, but it keeps commented-out config
    // blocks from producing phantom "missing variable" findings.
    if (/^\s*(\/\/|\*|\/\*)/.test(text)) return;

    for (const match of text.matchAll(DOT_ACCESS)) {
      found.push({ name: match[1]!, line });
    }
    for (const match of text.matchAll(BRACKET_ACCESS)) {
      found.push({ name: match[1]!, line });
    }
  });

  // Destructuring can span lines, so run it over the whole file and map the
  // match offset back to a line number.
  for (const match of source.matchAll(DESTRUCTURE)) {
    const line = lineAtOffset(source, match.index ?? 0);
    for (const name of parseDestructuredNames(match[1]!)) {
      found.push({ name, line });
    }
  }

  return found;
}

/**
 * Pulls variable names out of a destructuring brace group, handling renames
 * (`FOO: bar`) and defaults (`FOO = "x"`) by keeping only the env-side key.
 */
function parseDestructuredNames(group: string): string[] {
  return group
    .split(",")
    .map((part) => part.split(":")[0]!.split("=")[0]!.trim())
    .filter((name) => /^[A-Z_][A-Z0-9_]*$/i.test(name) && name.length > 0);
}

function lineAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

/**
 * Decides whether a file's code ends up in the browser bundle.
 *
 * Heuristic and openly so — the reason string travels with the finding so a
 * user can overrule us. Erring toward "server" keeps false NEXT_PUBLIC_
 * warnings down, which matter more than missed ones here.
 */
function classifyFile(
  relative: string,
  source: string,
): { context: RefContext; reason: string } {
  const normalized = relative.split(path.sep).join("/");
  const head = source.slice(0, 500);

  if (/^\s*["']use server["']/m.test(head)) {
    return { context: "server", reason: '"use server" directive' };
  }
  if (/^\s*["']use client["']/m.test(head)) {
    return { context: "client", reason: '"use client" directive' };
  }

  // API routes and server-only Next.js files never reach the browser.
  if (
    /(^|\/)(pages|app)\/api\//.test(normalized) ||
    /(^|\/)route\.(ts|js)$/.test(normalized) ||
    /(^|\/)middleware\.(ts|js)$/.test(normalized) ||
    /\.server\.(ts|tsx|js|jsx)$/.test(normalized)
  ) {
    return { context: "server", reason: "server-only file path" };
  }

  // Data-fetching exports mark a Pages Router file as server-side.
  if (/export\s+(async\s+)?(function|const)\s+(getServerSideProps|getStaticProps)/.test(source)) {
    return { context: "server", reason: "exports getServerSideProps/getStaticProps" };
  }

  // App Router server components are the default, so an app/ file without
  // "use client" is server-side.
  if (/(^|\/)app\//.test(normalized)) {
    return { context: "server", reason: "app/ directory defaults to server components" };
  }

  // Pages Router is the inverse: components ship to the browser by default.
  if (/(^|\/)pages\//.test(normalized)) {
    return { context: "client", reason: "pages/ component bundles to the browser" };
  }

  if (/(^|\/)(components|hooks)\//.test(normalized)) {
    return { context: "unknown", reason: "shared component — could be either" };
  }

  // Server-leaning conventions. These can be imported by a client component,
  // but defaulting them to "unknown" produced a warning on every data-access
  // file — noise that buried the real findings.
  if (/(^|\/)(lib|server|db|database|utils|services|actions)\//.test(normalized)) {
    return { context: "server", reason: "server-side module path" };
  }

  return { context: "unknown", reason: "no clear client/server signal" };
}

/** Recursively yields source file paths under `root`. */
function* walk(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      if (/\.(test|spec)\.[jt]sx?$/.test(entry.name)) continue;
      yield full;
    }
  }
}
