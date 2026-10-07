import fs from "node:fs";
import path from "node:path";
import type { EnvScope, VercelContext, VercelDeployment, VercelEnvKey } from "../types.js";

const API = "https://api.vercel.com";
export const TOKEN_URL = "https://vercel.com/account/settings/tokens";

/**
 * The message a user sees when no token is set.
 *
 * It names the URL inline on purpose: most people never open the README, and
 * this is the single most likely place setup stalls. The error message is the
 * real documentation.
 */
export const NO_TOKEN_MESSAGE =
  `VERCEL_TOKEN is not set, so Vercel checks were skipped. ` +
  `Create a token at ${TOKEN_URL} (scope it to the team that owns this project), then: export VERCEL_TOKEN=...`;

export const NO_PROJECT_MESSAGE =
  `Couldn't determine the Vercel project. Run \`vercel link\` in this directory ` +
  `(it writes .vercel/project.json), or set VERCEL_PROJECT_ID.`;

/**
 * Reads project, deployment, and env var metadata from Vercel.
 *
 * Returns `available: false` with a reason instead of throwing — a missing
 * token should degrade the diagnosis, never block it.
 */
export async function collectVercel(
  root: string,
  fetchImpl: FetchLike = fetch,
): Promise<VercelContext> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return { available: false, unavailableReason: NO_TOKEN_MESSAGE };
  }

  const identity = resolveProject(root);
  if (!identity) {
    return { available: false, unavailableReason: NO_PROJECT_MESSAGE };
  }

  const { projectId, teamId } = identity;
  const query = teamId ? `teamId=${encodeURIComponent(teamId)}` : "";

  try {
    const project = await request<any>(
      `${API}/v9/projects/${encodeURIComponent(projectId)}?${query}`,
      token,
      fetchImpl,
    );

    const deploymentsResponse = await request<any>(
      `${API}/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=5&${query}`,
      token,
      fetchImpl,
    );

    return {
      available: true,
      projectId,
      projectName: project?.name,
      framework: project?.framework ?? null,
      nodeVersion: project?.nodeVersion ?? null,
      envKeys: extractEnvKeys(project),
      deployments: extractDeployments(deploymentsResponse),
    };
  } catch (error) {
    return {
      available: false,
      unavailableReason: `Vercel API request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * Pulls env var keys and their target scopes out of the project response.
 *
 * The project endpoint returns env entries with `key` and `target` but, absent
 * `decrypt=true`, no usable value. We never ask for decryption, and any value
 * field that does arrive is dropped right here at the boundary rather than
 * being carried downstream where something might log it.
 */
export function extractEnvKeys(project: any): VercelEnvKey[] {
  const entries: any[] = Array.isArray(project?.env) ? project.env : [];
  const byName = new Map<string, { scopes: Set<EnvScope>; other: Set<string> }>();

  for (const entry of entries) {
    const name = entry?.key;
    if (typeof name !== "string") continue;

    const targets: string[] = Array.isArray(entry?.target)
      ? entry.target
      : typeof entry?.target === "string"
        ? [entry.target]
        : [];

    const record = byName.get(name) ?? { scopes: new Set<EnvScope>(), other: new Set<string>() };
    for (const target of targets) {
      if (target === "production" || target === "preview" || target === "development") {
        record.scopes.add(target);
      } else if (typeof target === "string") {
        // A Vercel custom environment. Kept so the scope rules can tell
        // "configured somewhere we don't model" from "not configured at all".
        record.other.add(target);
      }
    }
    byName.set(name, record);
  }

  return [...byName.entries()]
    .map(([name, record]) => ({
      name,
      scopes: [...record.scopes],
      otherTargets: [...record.other],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function extractDeployments(response: any): VercelDeployment[] {
  const list: any[] = Array.isArray(response?.deployments) ? response.deployments : [];
  return list.map((deployment) => ({
    id: deployment?.uid ?? deployment?.id ?? "",
    state: deployment?.state ?? deployment?.readyState ?? "unknown",
    target: deployment?.target ?? null,
    createdAt: deployment?.created ?? deployment?.createdAt ?? 0,
    commitSha: deployment?.meta?.githubCommitSha ?? null,
    commitMessage: deployment?.meta?.githubCommitMessage ?? null,
  }));
}

/**
 * Resolves project identity from `.vercel/project.json`, which `vercel link`
 * writes and most users already have. Env vars override it; nothing is
 * persisted by us.
 */
export function resolveProject(root: string): { projectId: string; teamId?: string } | null {
  if (process.env.VERCEL_PROJECT_ID) {
    return {
      projectId: process.env.VERCEL_PROJECT_ID,
      ...(process.env.VERCEL_ORG_ID ? { teamId: process.env.VERCEL_ORG_ID } : {}),
    };
  }

  try {
    const raw = fs.readFileSync(path.join(root, ".vercel", "project.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.projectId !== "string") return null;
    // orgId is a team id for team accounts and a user id for personal ones;
    // sending a user id as teamId is rejected, so only forward team ids.
    const orgId = typeof parsed?.orgId === "string" ? parsed.orgId : undefined;
    return {
      projectId: parsed.projectId,
      ...(orgId && orgId.startsWith("team_") ? { teamId: orgId } : {}),
    };
  } catch {
    return null;
  }
}

/** Narrowed to what this collector uses, so tests can supply a stub. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

async function request<T>(url: string, token: string, fetchImpl: FetchLike): Promise<T> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `${response.status} — token rejected. Check it's valid and scoped to the right team: ${TOKEN_URL}`,
      );
    }
    throw new Error(`${response.status} ${response.statusText} for ${new URL(url).pathname}`);
  }

  return (await response.json()) as T;
}
