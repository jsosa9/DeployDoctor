import { getAnthropicKey } from "../config/store.js";
import { AnthropicProvider } from "./anthropic.js";
import type { LlmProvider } from "./types.js";

export const NO_KEY_MESSAGE =
  `No Anthropic API key found, so the build log wasn't analyzed. ` +
  `Set one with \`deploydoctor auth llm\`, or export ANTHROPIC_API_KEY. ` +
  `Keys are at https://console.anthropic.com/settings/keys`;

/**
 * Returns a provider, or null when no key is configured.
 *
 * Null is a normal outcome, not an error: env var diagnosis works without a
 * key, and the tool must never hard-fail for lack of one.
 */
export function resolveProvider(): LlmProvider | null {
  const key = getAnthropicKey();
  return key ? new AnthropicProvider(key) : null;
}
