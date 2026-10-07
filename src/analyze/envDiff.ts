import type {
  CollectedContext,
  EnvRef,
  EnvScope,
  Finding,
  VercelEnvKey,
} from "../types.js";

/** Vars Next.js/Vercel/Node provide themselves — absent from .env by design. */
const BUILTIN = new Set([
  "NODE_ENV",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_REGION",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_GIT_COMMIT_SHA",
  "VERCEL_GIT_COMMIT_REF",
  "VERCEL_GIT_COMMIT_MESSAGE",
  "VERCEL_GIT_REPO_SLUG",
  "VERCEL_GIT_REPO_OWNER",
  "VERCEL_GIT_PROVIDER",
  "CI",
  "PORT",
  "PWD",
  "HOME",
  "PATH",
  "TZ",
  "npm_lifecycle_event",
  "NEXT_RUNTIME",
  "ANALYZE",
]);

const PUBLIC_PREFIX = "NEXT_PUBLIC_";

/**
 * Names that must never be suggested for the public prefix.
 *
 * Telling someone to rename DATABASE_URL to NEXT_PUBLIC_DATABASE_URL would
 * inline their database credentials into the client bundle. For these, the
 * only correct advice is to move the code server-side.
 */
const NEVER_PUBLIC =
  /(SECRET|PASSWORD|PASSWD|PRIVATE_KEY|TOKEN|API_?KEY|CREDENTIAL|SERVICE_ROLE|ACCESS_KEY|CLIENT_SECRET|DATABASE_URL|CONNECTION_STRING|DSN|SESSION|SALT|WEBHOOK)/i;

/**
 * Compares what the code asks for against what's actually configured.
 *
 * A pure function over collected data — no I/O, no printing. That's what makes
 * every rule here testable from a plain object, and what lets the Vercel-aware
 * rules slot in without touching the local-only ones.
 */
export function analyzeEnv(context: CollectedContext): Finding[] {
  const findings: Finding[] = [];
  const { envRefs, envLocal, vercel } = context;

  const localNames = new Set(envLocal.map((key) => key.name));
  const exampleNames = new Set(
    envLocal.filter((key) => /\.example$|\.sample$/.test(key.file)).map((k) => k.name),
  );
  const realNames = new Set(
    envLocal.filter((key) => !/\.example$|\.sample$/.test(key.file)).map((k) => k.name),
  );

  const vercelKeys = vercel.envKeys ?? [];
  const vercelByName = new Map(vercelKeys.map((key) => [key.name, key]));
  const vercelConfigured = vercelKeys.length > 0;

  const referenced = groupRefs(envRefs);

  for (const [name, refs] of referenced) {
    if (BUILTIN.has(name)) continue;

    const inLocal = realNames.has(name);
    const inVercel = vercelByName.has(name);

    // --- Missing entirely -------------------------------------------------
    if (!inLocal && !inVercel) {
      const onlyInExample = exampleNames.has(name);
      findings.push({
        envVar: name,
        rule: onlyInExample ? "env/setup-incomplete" : "env/missing",
        severity: "error",
        title: onlyInExample
          ? `${name} is in .env.example but never set`
          : `${name} is used in code but not configured anywhere`,
        detail: onlyInExample
          ? `The code reads ${name}, and .env.example lists it, but it isn't set in .env.local${vercelConfigured ? " or on Vercel" : ""}. This usually means setup was never finished.`
          : `The code reads ${name}, but it isn't in any local .env file${vercelConfigured ? " or configured on Vercel" : ""}. At build time it will be undefined.`,
        fix: `Add ${name} to .env.local for local builds${vercelConfigured ? `, and to your Vercel project's environment variables for deploys` : ""}.`,
        locations: locationsOf(refs),
      });
    }

    // --- Configured on Vercel but not locally, or vice versa --------------
    if (vercelConfigured && inLocal && !inVercel) {
      findings.push({
        envVar: name,
        rule: "env/missing-on-vercel",
        severity: "error",
        title: `${name} is set locally but not on Vercel`,
        detail: `${name} exists in your local .env, so local builds pass — but it isn't configured on Vercel, so the deployed build will see it as undefined. This is the classic "works on my machine" deploy failure.`,
        fix: `Add ${name} to your Vercel project's environment variables.`,
        locations: locationsOf(refs),
      });
    }

    // --- Scope gaps: the highest-value finding in the product -------------
    if (inVercel) {
      const key = vercelByName.get(name)!;
      const missingScopes = missingFrom(key);

      // Configured only for a custom environment. We can't tell which deploys
      // that covers, so claiming it's missing from all three standard scopes
      // would be confidently wrong.
      if (key.scopes.length === 0 && key.otherTargets.length > 0) {
        findings.push({
          envVar: name,
          rule: "env/custom-environment-only",
          severity: "info",
          title: `${name} is only configured for the ${formatList(key.otherTargets)} environment`,
          detail: `${name} is set on Vercel, but only for ${formatList(key.otherTargets)} — not for production, preview, or development. Whether that's a problem depends on which environment you're deploying to.`,
          fix: `If this deploy targets production, preview, or development, add ${name} to that environment in the Vercel dashboard.`,
          locations: locationsOf(refs),
        });
      } else if (missingScopes.length > 0) {
        findings.push({
          envVar: name,
          rule: "env/scope-gap",
          severity: "error",
          title: `${name} is missing from the ${formatList(missingScopes)} environment${missingScopes.length > 1 ? "s" : ""}`,
          detail: `${name} is configured on Vercel for ${formatList(key.scopes)}, but not ${formatList(missingScopes)}. Deploys targeting ${formatList(missingScopes)} will see it as undefined — which is why a change can build fine in Production and fail in Preview.`,
          fix: `In the Vercel dashboard, add ${name} to the ${formatList(missingScopes)} environment${missingScopes.length > 1 ? "s" : ""}.`,
          locations: locationsOf(refs),
        });
      }
    }

    // --- Client-side reference without the public prefix ------------------
    const clientRefs = refs.filter((ref) => ref.context === "client");
    if (clientRefs.length > 0 && !name.startsWith(PUBLIC_PREFIX)) {
      findings.push({
        envVar: name,
        rule: "env/client-needs-public-prefix",
        severity: "error",
        title: `${name} is read in browser code but lacks the ${PUBLIC_PREFIX} prefix`,
        detail: `Next.js only inlines variables prefixed with ${PUBLIC_PREFIX} into the client bundle. ${name} will be undefined in the browser no matter how it's configured. (Detected as client code because: ${clientRefs[0]!.contextReason}.)`,
        fix: NEVER_PUBLIC.test(name)
          ? `Do not add the ${PUBLIC_PREFIX} prefix — that would publish this credential to every visitor. Move the code that reads ${name} into a server component, server action, or API route instead.`
          : `Rename it to ${PUBLIC_PREFIX}${name} and update the references — or, if it's a secret, move the code that reads it to the server.`,
        locations: locationsOf(clientRefs),
      });
    }

    // --- Ambiguous context, non-public prefix: worth a nudge, not an error -
    const unknownRefs = refs.filter((ref) => ref.context === "unknown");
    // Skipped for credential-shaped names: the only fix we could suggest here
    // is the public prefix, which is exactly wrong for a secret.
    if (
      unknownRefs.length > 0 &&
      clientRefs.length === 0 &&
      !name.startsWith(PUBLIC_PREFIX) &&
      !NEVER_PUBLIC.test(name)
    ) {
      findings.push({
        envVar: name,
        rule: "env/context-unclear",
        severity: "info",
        title: `${name} is read in a file that may run in the browser`,
        detail: `Couldn't tell whether this file is server or client code (${unknownRefs[0]!.contextReason}). If it ends up in the browser bundle, ${name} will be undefined without the ${PUBLIC_PREFIX} prefix.`,
        fix: `Confirm this file is server-only, or add "use client" and rename the variable to ${PUBLIC_PREFIX}${name}.`,
        locations: locationsOf(unknownRefs),
      });
    }
  }

  // --- Secrets exposed to the client bundle -------------------------------
  for (const key of envLocal) {
    if (!key.name.startsWith(PUBLIC_PREFIX)) continue;
    if (!key.looksLikeSecret) continue;
    // Stripe's publishable key is public on purpose; don't cry wolf.
    if (/PUBLISHABLE|^NEXT_PUBLIC_PK_/.test(key.name)) continue;

    findings.push({
      envVar: key.name,
      rule: "env/public-secret",
      severity: "error",
      title: `${key.name} looks like a secret but is exposed to the browser`,
      detail: `Anything prefixed with ${PUBLIC_PREFIX} is inlined into the client bundle and readable by anyone who loads your site. The value of ${key.name} has the shape of a credential.`,
      fix: `Drop the ${PUBLIC_PREFIX} prefix, move the code that uses it server-side, and rotate the credential — assume it's already public if this has shipped.`,
      locations: [key.file],
    });
  }

  // --- Configured but never referenced ------------------------------------
  for (const name of realNames) {
    if (BUILTIN.has(name) || referenced.has(name)) continue;
    findings.push({
      envVar: name,
      rule: "env/unused",
      severity: "info",
      title: `${name} is configured but never read`,
      detail: `${name} is set in your .env files, but no code reads it. Usually harmless — either leftover config or accessed in a way static scanning can't see.`,
      fix: `Remove it if it's dead config.`,
      locations: [...new Set(envLocal.filter((k) => k.name === name).map((k) => k.file))],
    });
  }

  return sortBySeverity(suppressRedundantNotes(findings));
}

/**
 * Drops informational notes about a variable that already has a real problem
 * reported against it.
 *
 * Without this, a secret exposed through NEXT_PUBLIC_ gets flagged as a
 * security error and then, immediately below, as "configured but never read" —
 * true, but useless next to the error, and it dilutes the thing that matters.
 */
function suppressRedundantNotes(findings: Finding[]): Finding[] {
  const flagged = new Set(
    findings
      .filter((finding) => finding.severity !== "info" && finding.envVar)
      .map((finding) => finding.envVar!),
  );

  return findings.filter(
    (finding) =>
      finding.severity !== "info" || !finding.envVar || !flagged.has(finding.envVar),
  );
}

/** Scopes a Vercel-configured var is absent from. */
function missingFrom(key: VercelEnvKey): EnvScope[] {
  const all: EnvScope[] = ["production", "preview", "development"];
  return all.filter((scope) => !key.scopes.includes(scope));
}

function groupRefs(refs: EnvRef[]): Map<string, EnvRef[]> {
  const grouped = new Map<string, EnvRef[]>();
  for (const ref of refs) {
    const existing = grouped.get(ref.name);
    if (existing) existing.push(ref);
    else grouped.set(ref.name, [ref]);
  }
  return grouped;
}

/** `file:line` strings, deduped and capped so output stays readable. */
function locationsOf(refs: EnvRef[]): string[] {
  const unique = [...new Set(refs.map((ref) => `${ref.file}:${ref.line}`))];
  return unique.length > 5 ? [...unique.slice(0, 5), `…and ${unique.length - 5} more`] : unique;
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

function sortBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.title.localeCompare(b.title),
  );
}
