import fs from "node:fs";
import path from "node:path";
import type { EnvLocalKey } from "../types.js";

/** Checked in precedence-ish order; all that exist are read. */
const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.example",
  ".env.sample",
];

/**
 * Reads env var *names* from local `.env*` files.
 *
 * The privacy boundary of this tool starts here. Values are read into a local
 * variable, reduced to a single boolean, and dropped — no value is ever
 * returned, logged, or stored. `looksLikeSecret` is the only thing that
 * survives contact with a value.
 */
export function collectEnvLocal(root: string): EnvLocalKey[] {
  const keys: EnvLocalKey[] = [];

  for (const filename of ENV_FILES) {
    const full = path.join(root, filename);
    let contents: string;
    try {
      contents = fs.readFileSync(full, "utf8");
    } catch {
      continue; // Absent file is the normal case, not an error.
    }

    for (const line of contents.split("\n")) {
      const parsed = parseLine(line);
      if (!parsed) continue;
      keys.push({
        name: parsed.name,
        file: filename,
        looksLikeSecret: looksLikeSecret(parsed.name, parsed.value),
        isEmpty: parsed.value.length === 0,
      });
      // `parsed.value` goes out of scope here and is never referenced again.
    }
  }

  return keys;
}

function parseLine(line: string): { name: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const withoutExport = trimmed.replace(/^export\s+/, "");
  const eq = withoutExport.indexOf("=");
  if (eq <= 0) return null;

  const name = withoutExport.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;

  let value = withoutExport.slice(eq + 1).trim();
  // Strip matching quotes so `FOO=""` is correctly seen as empty.
  if (value.length >= 2 && /^(["']).*\1$/s.test(value)) {
    value = value.slice(1, -1);
  }

  return { name, value };
}

/** Known credential prefixes, checked before the generic entropy heuristic. */
const SECRET_PREFIXES = [
  "sk-", // OpenAI / Anthropic style
  "sk_live_",
  "sk_test_",
  "rk_live_",
  "pk_live_", // Stripe publishable — safe to expose, but worth knowing
  "ghp_",
  "ghs_",
  "github_pat_",
  "eyJ", // base64url JWT header — Supabase service keys, etc.
  "AIza", // Google API keys
  "AKIA", // AWS access key ids
  "xoxb-",
  "xoxp-",
  "dop_v1_",
  "shpat_",
];

/** Name fragments that imply a credential regardless of value shape. */
const SECRET_NAME_HINTS =
  /(SECRET|PASSWORD|PASSWD|PRIVATE_KEY|TOKEN|API_KEY|APIKEY|CREDENTIAL|SERVICE_ROLE|ACCESS_KEY|CLIENT_SECRET|DSN|CONNECTION_STRING|DATABASE_URL)/i;

/**
 * Judges whether a value is credential-shaped.
 *
 * Takes the value only to inspect its shape and never retains it. Intentionally
 * generous: a false positive on an exposed-secret warning costs the user a
 * glance, while a false negative costs them a leaked key.
 */
function looksLikeSecret(name: string, value: string): boolean {
  if (SECRET_NAME_HINTS.test(name)) return true;
  if (!value) return false;
  if (SECRET_PREFIXES.some((prefix) => value.startsWith(prefix))) return true;

  // A long, high-entropy, URL-ish-free string is probably a credential.
  if (value.length >= 32 && !value.includes(" ")) {
    const distinct = new Set(value).size;
    const hasMixedClasses =
      /[a-z]/.test(value) && /[A-Z0-9]/.test(value);
    if (distinct >= 16 && hasMixedClasses) return true;
  }

  return false;
}
