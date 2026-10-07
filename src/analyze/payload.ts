import type { CollectedContext, Finding } from "../types.js";

/** Rough budget for the whole payload. ~4 chars/token is close enough. */
const MAX_PAYLOAD_CHARS = 100_000;
const MAX_ERROR_FRAME_LINES = 120;
const MAX_CHANGED_FILES = 40;
const MAX_DIFF_STAT_CHARS = 2_000;
const MAX_ENV_REFS = 200;

/**
 * The structured payload handed to the model.
 *
 * Note what isn't here: no env var values, no file contents, no raw full log.
 * Only names, locations, and the extracted error frame.
 */
export interface DiagnosisPayload {
  project: {
    framework: string;
    packageManager: string;
    nextVersion: string | null;
    nodeEngine: string | null;
    dependencies: string[];
    buildScript: string | null;
  };
  failure: {
    command: string;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    errorFrame: string[];
    logTruncated: boolean;
  } | null;
  env: {
    referenced: Array<{ name: string; context: string; locations: string[] }>;
    configuredLocally: string[];
    configuredOnVercel: Array<{ name: string; scopes: string[] }>;
  };
  git: {
    branch: string | null;
    isDirty: boolean;
    recentCommits: Array<{ hash: string; subject: string }>;
    changedFiles: string[];
    diffStat: string | null;
  };
  vercel: {
    available: boolean;
    projectName?: string;
    framework?: string | null;
    nodeVersion?: string | null;
    recentDeployments?: Array<{ state: string; target: string | null; commitSha: string | null }>;
  };
  deterministicFindings: Array<{ rule: string; severity: string; title: string }>;
}

/**
 * Assembles, redacts, and size-caps the payload.
 *
 * Collectors already drop env values, so the redaction pass here is
 * belt-and-braces — it catches secrets that leaked in through a channel we
 * don't control, chiefly build logs that echo their own configuration.
 */
export function buildPayload(
  context: CollectedContext,
  findings: Finding[],
): DiagnosisPayload {
  const payload: DiagnosisPayload = {
    project: {
      framework: context.project.framework,
      packageManager: context.project.packageManager,
      nextVersion: context.project.nextVersion,
      nodeEngine: context.project.nodeEngine,
      dependencies: context.project.dependencies,
      // package.json scripts occasionally inline a token for a private registry.
      buildScript: context.project.scripts.build
        ? redact(context.project.scripts.build)
        : null,
    },
    failure: context.buildLog
      ? {
          // The command itself can carry a secret — `DATABASE_URL=... npm run
          // build` is a normal thing to type — so it gets the same treatment
          // as the log.
          command: redact(context.buildLog.command),
          exitCode: context.buildLog.exitCode,
          signal: context.buildLog.signal,
          durationMs: context.buildLog.durationMs,
          errorFrame: redactLines(
            context.buildLog.errorFrame.slice(-MAX_ERROR_FRAME_LINES),
          ),
          logTruncated: context.buildLog.truncated,
        }
      : null,
    env: {
      referenced: summarizeRefs(context),
      configuredLocally: [...new Set(context.envLocal.map((key) => key.name))],
      configuredOnVercel: (context.vercel.envKeys ?? []).map((key) => ({
        name: key.name,
        scopes: key.scopes,
      })),
    },
    git: {
      branch: context.git.branch,
      isDirty: context.git.isDirty,
      recentCommits: context.git.commits.map((commit) => ({
        hash: commit.hash,
        subject: redact(commit.subject),
      })),
      changedFiles: context.git.changedFiles.slice(0, MAX_CHANGED_FILES),
      diffStat: context.git.diffStat
        ? context.git.diffStat.slice(0, MAX_DIFF_STAT_CHARS)
        : null,
    },
    vercel: {
      available: context.vercel.available,
      ...(context.vercel.projectName ? { projectName: context.vercel.projectName } : {}),
      ...(context.vercel.framework !== undefined ? { framework: context.vercel.framework } : {}),
      ...(context.vercel.nodeVersion !== undefined
        ? { nodeVersion: context.vercel.nodeVersion }
        : {}),
      ...(context.vercel.deployments
        ? {
            recentDeployments: context.vercel.deployments.map((d) => ({
              state: d.state,
              target: d.target,
              commitSha: d.commitSha,
            })),
          }
        : {}),
    },
    deterministicFindings: findings.map((finding) => ({
      rule: finding.rule,
      severity: finding.severity,
      title: finding.title,
    })),
  };

  return enforceBudget(payload);
}

function summarizeRefs(context: CollectedContext): DiagnosisPayload["env"]["referenced"] {
  const grouped = new Map<string, { context: string; locations: string[] }>();
  for (const ref of context.envRefs) {
    const existing = grouped.get(ref.name);
    const location = `${ref.file}:${ref.line}`;
    if (existing) {
      if (existing.locations.length < 5) existing.locations.push(location);
    } else {
      grouped.set(ref.name, { context: ref.context, locations: [location] });
    }
  }
  return [...grouped.entries()]
    .slice(0, MAX_ENV_REFS)
    .map(([name, value]) => ({ name, ...value }));
}

/**
 * Patterns for credential-shaped substrings.
 *
 * Matching on *shape* rather than on a list of known key names is what lets
 * this catch a secret echoed by a build tool we've never heard of.
 */
const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  // Known credential prefixes followed by a long opaque body.
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, "[redacted:stripe-key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted:api-key]"],
  [/\b(ghp|ghs|gho|ghu)_[A-Za-z0-9]{20,}/g, "[redacted:github-token]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted:github-token]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[redacted:slack-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted:aws-key-id]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted:google-api-key]"],
  [/\bdop_v1_[a-f0-9]{60,}/g, "[redacted:digitalocean-token]"],
  [/\bshpat_[a-fA-F0-9]{30,}/g, "[redacted:shopify-token]"],
  // JWTs — Supabase service_role keys are the common leak here.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted:jwt]"],
  // Credentials embedded in connection strings.
  [/\b([a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:[^\s@]+@/gi, "$1://[redacted:credentials]@"],
  // `KEY=value` / `KEY: value` where the name implies a secret.
  [
    /\b([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|API_?KEY|CREDENTIAL|PRIVATE_KEY|SERVICE_ROLE)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"',}]{6,})/g,
    '$1=[redacted]',
  ],
  // Bearer tokens in echoed request logs.
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/g, "Bearer [redacted]"],
];

/** Replaces credential-shaped substrings. Exported for direct testing. */
export function redact(text: string): string {
  let output = text;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function redactLines(lines: string[]): string[] {
  return lines.map(redact);
}

/**
 * Trims the payload if it's still over budget after per-field caps.
 *
 * Drops in order of expendability — full dependency list, then diff stat, then
 * the head of the error frame, since a failure's cause is usually at the end.
 */
function enforceBudget(payload: DiagnosisPayload): DiagnosisPayload {
  const size = () => JSON.stringify(payload).length;
  if (size() <= MAX_PAYLOAD_CHARS) return payload;

  if (payload.project.dependencies.length > 50) {
    payload.project.dependencies = payload.project.dependencies.slice(0, 50);
  }
  if (size() <= MAX_PAYLOAD_CHARS) return payload;

  payload.git.diffStat = null;
  if (size() <= MAX_PAYLOAD_CHARS) return payload;

  while (payload.failure && payload.failure.errorFrame.length > 20 && size() > MAX_PAYLOAD_CHARS) {
    payload.failure.errorFrame = payload.failure.errorFrame.slice(
      Math.ceil(payload.failure.errorFrame.length / 4),
    );
  }

  return payload;
}
