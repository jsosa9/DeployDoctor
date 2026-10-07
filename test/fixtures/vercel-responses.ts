/**
 * Synthetic Vercel API responses.
 *
 * Shapes follow the documented `/v9/projects/{id}` and `/v6/deployments`
 * payloads, trimmed to the fields the collector reads. These are hand-built,
 * not captured from a live account — so they prove the collector parses the
 * documented shape correctly, not that the live endpoint matches it.
 */

/**
 * Note `value` on each env entry. The real API omits it unless `decrypt=true`,
 * which we never pass — but it's included here on purpose so the tests can
 * prove the collector drops it even when present.
 */
export const projectResponse = {
  id: "prj_abc123",
  name: "my-storefront",
  framework: "nextjs",
  nodeVersion: "20.x",
  env: [
    {
      id: "env_1",
      key: "DATABASE_URL",
      target: ["production"],
      type: "encrypted",
      value: "postgres://admin:hunter2@db.example.com:5432/prod",
    },
    {
      id: "env_2",
      key: "NEXT_PUBLIC_SITE_URL",
      target: ["production", "preview", "development"],
      type: "plain",
      value: "https://example.com",
    },
    {
      id: "env_3",
      key: "STRIPE_SECRET_KEY",
      target: ["production", "preview"],
      type: "encrypted",
      value: "sk_live_51H8xQ2abcdefghijklmnop",
    },
    // The same key can appear as several entries, one per target.
    { id: "env_4", key: "SENTRY_DSN", target: ["production"], type: "encrypted" },
    { id: "env_5", key: "SENTRY_DSN", target: ["preview"], type: "encrypted" },
    // `target` sometimes arrives as a bare string rather than an array.
    { id: "env_6", key: "LEGACY_FLAG", target: "development", type: "plain" },
    // Custom environments appear as targets we don't model; they're ignored.
    { id: "env_7", key: "STAGING_ONLY", target: ["custom-staging"], type: "plain" },
    // Malformed entries must not crash the parser.
    { id: "env_8", type: "plain" },
  ],
};

export const deploymentsResponse = {
  deployments: [
    {
      uid: "dpl_fail1",
      state: "ERROR",
      target: "preview",
      created: 1_730_000_000_000,
      meta: {
        githubCommitSha: "a1b2c3d4e5f6",
        githubCommitMessage: "add dashboard",
      },
    },
    {
      uid: "dpl_ok1",
      state: "READY",
      target: "production",
      created: 1_729_000_000_000,
      meta: { githubCommitSha: "999888777666", githubCommitMessage: "bump deps" },
    },
    // Not every deployment carries git metadata (CLI deploys, for instance).
    { uid: "dpl_bare", readyState: "READY", created: 1_728_000_000_000 },
  ],
};

/** Builds a FetchLike that serves the recorded responses by URL path. */
export function recordedFetch(
  overrides: { status?: number; statusText?: string } = {},
) {
  const calls: string[] = [];

  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(url);

    if (overrides.status && overrides.status >= 400) {
      return {
        ok: false,
        status: overrides.status,
        statusText: overrides.statusText ?? "Error",
        json: async () => ({}),
      };
    }

    const body = url.includes("/v6/deployments") ? deploymentsResponse : projectResponse;
    return { ok: true, status: 200, statusText: "OK", json: async () => body };
  };

  return { impl, calls, headersSeen: [] as Array<Record<string, string> | undefined> };
}
