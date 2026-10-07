import Conf from "conf";

/**
 * Local credential storage.
 *
 * Holds the Anthropic key and nothing else — Vercel auth is an env var and
 * project identity comes from `.vercel/project.json`, so there's no state here
 * worth growing a schema for.
 */
const store = new Conf<{ anthropicApiKey?: string }>({
  projectName: "deploydoctor",
});

/** Env var wins over the stored key, so CI and one-off overrides work. */
export function getAnthropicKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || store.get("anthropicApiKey");
}

export function setAnthropicKey(key: string): void {
  store.set("anthropicApiKey", key);
}

export function clearAnthropicKey(): void {
  store.delete("anthropicApiKey");
}

export function keySource(): "env" | "stored" | "none" {
  if (process.env.ANTHROPIC_API_KEY) return "env";
  if (store.get("anthropicApiKey")) return "stored";
  return "none";
}

export const storePath = store.path;
