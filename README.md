# DeployDoctor

Wraps your build command, catches the failure, and tells you what broke and how to fix it.

Deploy failures are opaque. The log says `Error: supabaseUrl is required` and you're left guessing: missing variable? Wrong scope? `NEXT_PUBLIC_` mistake? Something in the last three commits? The answer needs three things nobody correlates by hand — what your code references, what's actually configured on Vercel, and what the build output says.

DeployDoctor correlates them.

---

## Before

```
$ npm run build

> build
> next build

  ▲ Next.js 14.2.5

Failed to compile.

./app/dashboard/page.tsx
Error: supabaseUrl is required.

> Build failed because of webpack errors
```

## After

*Illustrative — composed from the real output formats below, not a captured session. The deterministic findings block is exactly what the tool prints today; the "What broke / Why / How to fix it" section is the shape the model's diagnosis renders into.*

```
$ deploydoctor run npm run build

... (your build output, unchanged)

✗ npm run build failed with exit code 1
  Diagnosing…

✗ NEXT_PUBLIC_SUPABASE_URL is missing from the preview environment      error
  NEXT_PUBLIC_SUPABASE_URL is configured on Vercel for production, but not
  preview. Deploys targeting preview will see it as undefined — which is why
  this builds fine in Production and fails here.
  lib/supabase.ts:4, app/dashboard/page.tsx:12
  → In the Vercel dashboard, add NEXT_PUBLIC_SUPABASE_URL to the preview
    environment.
  env/scope-gap

────────────────────────────────────────────────────────────
1 error

What broke
  Your Supabase client got an undefined URL because the variable it reads
  isn't set for Preview deploys.

Why
  lib/supabase.ts calls createClient() with process.env.NEXT_PUBLIC_SUPABASE_URL
  at module scope, so it runs during the build rather than at request time.
  The variable exists on Vercel but only for the production target, and this
  is a preview deploy off branch `add-dashboard`. Supabase throws
  "supabaseUrl is required" when passed undefined.

How to fix it
  1. Add the variable to the Preview environment
     vercel env add NEXT_PUBLIC_SUPABASE_URL preview
  2. Redeploy
     git commit --allow-empty -m "redeploy" && git push

  confidence: high
```

---

## Install

```bash
npm install -g deploydoctor
```

## Setup

**You can skip this entirely to start.** `deploydoctor check` audits your environment variables with no credentials and no network:

```bash
cd your-project
deploydoctor check
```

That catches missing variables, `NEXT_PUBLIC_` mistakes, and secrets exposed to the browser. The two steps below add the rest.

### 1. Anthropic API key — for build log diagnosis

Needed to analyze *why* a build failed. Get a key at **https://console.anthropic.com/settings/keys**, then:

```bash
deploydoctor auth llm
```

Or set it in your environment, which takes precedence:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 2. Vercel token — for scope-aware env var checks

Needed to compare your code against what's actually configured on Vercel, per environment. This is the highest-value check in the tool and it's the one that catches "works in Production, fails in Preview."

There's no click-to-connect flow in v1 — you create the token yourself:

1. Go to **https://vercel.com/account/settings/tokens**
2. Click **Create Token**
3. Under **Scope**, pick the team that owns the project (not "Personal Account" unless the project is personal — a token scoped to the wrong team gets a 403)
4. Copy it and export it:

```bash
export VERCEL_TOKEN=...
```

Add that line to your `~/.zshrc` or `~/.bashrc` so it persists.

DeployDoctor finds your project from `.vercel/project.json`, which `vercel link` writes. If you haven't linked:

```bash
vercel link
```

Check what's configured at any time:

```bash
deploydoctor auth status
```

---

## Usage

```bash
# Wrap any build command. Exits with your command's exit code, so it's CI-safe.
deploydoctor run npm run build
deploydoctor run pnpm build
deploydoctor run next build

# Audit env vars without building. No credentials needed.
deploydoctor check

# Include Vercel's configured variables in the audit.
deploydoctor check --vercel

# See exactly what would be sent to the API, and send nothing.
deploydoctor check --dry-run
```

### What gets sent

`--dry-run` prints the full payload so you can read it yourself. In short:

**Sent:** env var *names* and the `file:line` where each is referenced, the extracted error frame from your build log, recent commit subjects and changed filenames, your dependency list, framework and Node version.

**Never sent:** environment variable *values*. Not from `.env` files, not from Vercel — the Vercel API is never asked to decrypt them. File contents are never sent either, only paths.

On top of that, everything passes a redaction filter before leaving the process, because build tools sometimes echo their own configuration — and because the command you type can itself contain a secret (`DATABASE_URL=... npm run build`). Connection strings, JWTs, bearer tokens, and provider-prefixed keys (`sk_live_`, `ghp_`, `AKIA…`, and others) get replaced with `[redacted]`. Sixteen tests cover the filter directly, plus an end-to-end check that a secret echoed by a build never reaches the payload.

For `deploydoctor run --dry-run`, your build's output shares stdout, so the payload is fenced with a sentinel:

```bash
deploydoctor run npm run build --dry-run \
  | sed -n '/^===DEPLOYDOCTOR_PAYLOAD===$/,$p' | tail -n +2 | jq .
```

---

## What it checks without an API key

| Check | Catches |
|---|---|
| `env/missing` | Referenced in code, configured nowhere |
| `env/setup-incomplete` | In `.env.example` but never actually set |
| `env/missing-on-vercel` | Set locally, absent on Vercel — the classic "works on my machine" |
| `env/scope-gap` | Set for one environment but not the one you're deploying to |
| `env/client-needs-public-prefix` | Read in browser code without `NEXT_PUBLIC_`, so it'll be `undefined` |
| `env/public-secret` | A credential-shaped value exposed to the client bundle |
| `env/unused` | Configured but nothing reads it |

Build *log* diagnosis — the "Why" section above — requires the Anthropic key.

---

## Scope

**Supported:** Next.js (App and Pages Router) and Node projects deploying to Vercel.

**Read-only.** Both API integrations use read scopes only. Nothing can modify your project, your variables, or your deployments. There is no auto-fix and no auto-redeploy — you get a diagnosis and you apply it.

### Verification status

Being straight about what's actually been proven, since it affects how much to trust the output:

| Area | Status |
|---|---|
| Command wrapping, exit codes, log extraction | Verified against real processes |
| Env var scanning, `.env` parsing, all finding rules | Verified against fixture projects |
| Redaction | Verified — 16 pattern tests plus end-to-end |
| Vercel collector | **Tested against synthetic responses matching the documented API shape — never against a live account.** Parsing, scope logic, auth-failure messages, and value-dropping are covered; that the live endpoints return this shape is not. |
| Anthropic adapter | **Tested with a stubbed provider — the real network call has never run.** Schema validation, prompt stability, and failure handling are covered; the live request is not. |

101 tests, `npm test`.

If you hit a mismatch against the real Vercel API, that's the most likely place a bug lives — please open an issue.

### Known limitations

- Env var scanning is regex-based, so fully dynamic access (`process.env[someKey]`) and re-exported config objects are invisible to it.
- Client/server classification is heuristic. `"use client"`, `app/` vs `pages/`, API routes, and server-side data fetching are all detected, but a shared module imported from both sides can be misjudged. Every finding states the reason it was classified that way so you can overrule it.
- No monorepo or workspace handling yet.
- Vercel's API exposes variable names and scopes, not values — so "set, but to the wrong value" is undiagnosable by design.
- A variable scoped only to a Vercel *custom environment* is reported as a note rather than an error, since there's no way to tell which deploys it covers.
- Vercel auth is a manually created token rather than OAuth. Rougher than it should be; see Setup step 2.

## License

MIT
