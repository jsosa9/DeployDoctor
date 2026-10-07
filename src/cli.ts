import { Command } from "commander";
import { run } from "./commands/run.js";
import { check } from "./commands/check.js";
import { authLlm, authStatus, authLogout } from "./commands/auth.js";
import { vercelInspect } from "./commands/vercel.js";

const program = new Command();

program
  .name("deploydoctor")
  .description("Catches build failures and explains what broke and how to fix it.")
  .version("0.1.0");

program
  .command("run")
  .description("Run a build command and diagnose it if it fails")
  .argument("<command...>", "the command to run, e.g. npm run build")
  .option("--dry-run", "print the payload that would be analyzed, and send nothing")
  .option("--no-vercel", "skip Vercel API checks")
  .action(async (command: string[], options) => {
    process.exitCode = await run(command, {
      dryRun: options.dryRun,
      vercel: options.vercel,
    });
  });

program
  .command("check")
  .description("Audit environment variables without running a build")
  .option("--dry-run", "print the payload that would be analyzed, and send nothing")
  .option("--vercel", "also compare against Vercel's configured variables")
  .action(async (options) => {
    process.exitCode = await check({
      dryRun: options.dryRun,
      vercel: options.vercel,
    });
  });

program
  .command("vercel")
  .description("Show what the Vercel collector sees — no analysis, no LLM call")
  .option("--json", "print the raw collected object instead of a table")
  .action(async (options) => {
    process.exitCode = await vercelInspect({ json: options.json });
  });

const auth = program.command("auth").description("Manage credentials");
auth
  .command("llm")
  .description("Store your Anthropic API key")
  .action(async () => {
    process.exitCode = await authLlm();
  });
auth
  .command("status")
  .description("Show which credentials are configured")
  .action(() => {
    process.exitCode = authStatus();
  });
auth
  .command("logout")
  .description("Remove the stored Anthropic API key")
  .action(() => {
    process.exitCode = authLogout();
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
