/**
 * Replays real Next.js build failures.
 *
 * A genuine `next build` needs an installed toolchain and a minute of
 * wall-clock time per run, which makes it useless for iterating on the parts
 * this tool actually owns: capture, error-frame extraction, redaction, and the
 * diagnosis prompt. What those parts consume is a process that writes a
 * realistic log to the realistic stream and exits with a realistic code — so
 * that is exactly what this is.
 *
 * The logs are transcribed from Next.js 14.2.5 output, including the leading
 * blank lines and the stray indentation, because the error-frame extractor
 * keys off that shape and tidied-up logs would test something easier than
 * reality.
 *
 *   SCENARIO=missing-env node build-sim.mjs
 *
 * Scenario names are listed in SCENARIOS; `list` prints them.
 */

const BANNER = ["", "> build", "> next build", "", "   ▲ Next.js 14.2.5", ""];

/**
 * Each scenario returns the lines to emit, which stream to use, and the exit
 * code. `stderr` matters: a collector that only read stdout would look correct
 * against half of these and lose the error on the other half.
 */
const SCENARIOS = {
  /**
   * The flagship case: a client constructed at module scope, so it runs during
   * the build rather than per-request, and an unset variable becomes a hard
   * build failure instead of a runtime 500.
   */
  "missing-env": {
    stream: "stderr",
    exitCode: 1,
    lines: [
      ...BANNER,
      "   Creating an optimized production build ...",
      " ✓ Compiled successfully",
      "   Linting and checking validity of types ...",
      "   Collecting page data ...",
      "Error: supabaseUrl is required.",
      "    at new SupabaseClient (/vercel/path0/node_modules/@supabase/supabase-js/dist/main/SupabaseClient.js:52:19)",
      "    at createClient (/vercel/path0/node_modules/@supabase/supabase-js/dist/main/index.js:38:12)",
      "    at 2347 (/vercel/path0/.next/server/app/dashboard/page.js:1:1194)",
      "    at t (/vercel/path0/.next/server/webpack-runtime.js:1:143)",
      "",
      "> Build error occurred",
      "Error: Failed to collect page data for /dashboard",
      "    at /vercel/path0/node_modules/next/dist/build/utils.js:1269:15",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5) {",
      "  type: 'Error'",
      "}",
      "",
    ],
  },

  "type-error": {
    stream: "stdout",
    exitCode: 1,
    lines: [
      ...BANNER,
      "   Creating an optimized production build ...",
      " ✓ Compiled successfully",
      "   Linting and checking validity of types ...",
      "Failed to compile.",
      "",
      "./app/dashboard/page.tsx:24:31",
      "Type error: Property 'emailAddress' does not exist on type 'User'. Did you mean 'email'?",
      "",
      "  22 |   const user = await getUser();",
      "  23 |   return (",
      "> 24 |     <span className=\"muted\">{user.emailAddress}</span>",
      "     |                               ^",
      "  25 |   );",
      "  26 | }",
      "",
    ],
  },

  "module-not-found": {
    stream: "stdout",
    exitCode: 1,
    lines: [
      ...BANNER,
      "   Creating an optimized production build ...",
      "Failed to compile.",
      "",
      "./app/dashboard/page.tsx",
      "Module not found: Can't resolve '@/lib/analytics'",
      "",
      "https://nextjs.org/docs/messages/module-not-found",
      "",
      "Import trace for requested module:",
      "./app/dashboard/page.tsx",
      "",
      "> Build failed because of webpack errors",
      "",
    ],
  },

  /**
   * Dies on a signal rather than an exit code, which is the one shape that
   * exercises the `signal` branch instead of `exitCode`. Exit 137 is what a
   * container reports when the kernel's OOM killer takes the process.
   */
  oom: {
    stream: "stderr",
    exitCode: 137,
    lines: [
      ...BANNER,
      "   Creating an optimized production build ...",
      "",
      "<--- Last few GCs --->",
      "[1234:0x7f8] 48213 ms: Mark-Compact 2041.3 (2082.5) -> 2040.8 (2083.0) MB, 1842.19 / 0.00 ms",
      "",
      "<--- JS stacktrace --->",
      "",
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      " 1: 0xb8a0e0 node::Abort() [node]",
      " 2: 0xa8a3f5 node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]",
      "",
    ],
  },

  /**
   * A build tool echoing its own configuration — the exact channel the
   * redaction pass exists for, since collectors can only drop values they are
   * the ones reading. The token here is synthetic and deliberately shaped to
   * be caught by shape rather than by name.
   */
  "leaky-log": {
    stream: "stdout",
    exitCode: 1,
    lines: [
      ...BANNER,
      "   Creating an optimized production build ...",
      "[cms-sync] resolved configuration:",
      "[cms-sync]   endpoint=https://cms.internal.example.com/graphql",
      "[cms-sync]   CMS_API_TOKEN=tok_" + "SYNTHETIC_FIXTURE_VALUE_NOT_REAL",
      "[cms-sync]   database=postgres://cms_user:" + "fixturepw" + "@db.internal:5432/cms",
      // The signal line sits directly after the echoed config so both secrets
      // fall inside the extractor's 3-line lookback. Further away, they are
      // dropped from the frame and never reach the payload — which makes a
      // redaction assertion against them pass while testing nothing.
      "[cms-sync] Error: 401 Unauthorized from https://cms.internal.example.com/graphql",
      "",
      "> Build error occurred",
      "Error: Failed to fetch CMS schema",
      "",
    ],
  },
};

const requested = process.env.SCENARIO ?? "missing-env";

if (requested === "list") {
  console.log(Object.keys(SCENARIOS).join("\n"));
  process.exit(0);
}

const scenario = SCENARIOS[requested];
if (!scenario) {
  console.error(
    `build-sim: unknown SCENARIO "${requested}". Known: ${Object.keys(SCENARIOS).join(", ")}`,
  );
  process.exit(2);
}

const target = scenario.stream === "stderr" ? process.stderr : process.stdout;
target.write(scenario.lines.join("\n") + "\n");
process.exit(scenario.exitCode);
