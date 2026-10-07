import readline from "node:readline/promises";
import pc from "picocolors";
import {
  clearAnthropicKey,
  keySource,
  setAnthropicKey,
  storePath,
} from "../config/store.js";

const CONSOLE_URL = "https://console.anthropic.com/settings/keys";
const VERCEL_TOKEN_URL = "https://vercel.com/account/settings/tokens";

/** Stores an Anthropic key locally. The only credential this tool manages. */
export async function authLlm(): Promise<number> {
  console.log(`\nGet a key at ${pc.cyan(CONSOLE_URL)}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const key = (await rl.question("Anthropic API key: ")).trim();
  rl.close();

  if (!key) {
    console.log(pc.yellow("\nNothing entered — no key saved.\n"));
    return 1;
  }
  if (!key.startsWith("sk-")) {
    console.log(pc.yellow(`\nThat doesn't look like an Anthropic key (expected it to start with "sk-"). Saving anyway.\n`));
  }

  setAnthropicKey(key);
  console.log(pc.green(`\n✓ Key saved to ${pc.dim(storePath)}\n`));
  return 0;
}

export function authStatus(): number {
  const source = keySource();
  console.log("");

  switch (source) {
    case "env":
      console.log(`${pc.green("✓")} Anthropic key: set via ${pc.bold("ANTHROPIC_API_KEY")}`);
      break;
    case "stored":
      console.log(`${pc.green("✓")} Anthropic key: stored locally ${pc.dim(`(${storePath})`)}`);
      break;
    case "none":
      console.log(
        `${pc.yellow("!")} Anthropic key: not set — run ${pc.bold("deploydoctor auth llm")}`,
      );
      break;
  }

  if (process.env.VERCEL_TOKEN) {
    console.log(`${pc.green("✓")} Vercel token: set via ${pc.bold("VERCEL_TOKEN")}`);
  } else {
    console.log(
      `${pc.yellow("!")} Vercel token: not set — create one at ${pc.cyan(VERCEL_TOKEN_URL)} and ${pc.bold("export VERCEL_TOKEN=...")}`,
    );
  }

  console.log(pc.dim(`\n  Env-var checks work without either credential: deploydoctor check\n`));
  return 0;
}

export function authLogout(): number {
  clearAnthropicKey();
  console.log(pc.green("\n✓ Stored Anthropic key removed.\n"));
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(
      pc.dim("  Note: ANTHROPIC_API_KEY is still set in your environment and takes precedence.\n"),
    );
  }
  return 0;
}
