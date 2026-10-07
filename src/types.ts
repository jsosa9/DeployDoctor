/**
 * Shared domain types.
 *
 * Collectors produce these; analyzers consume them. Nothing here imports from
 * `output/` or performs I/O, so the whole analysis layer stays testable with
 * plain object fixtures.
 */

export type EnvScope = "development" | "preview" | "production";

/** Where in the bundle a reference will end up. Drives the NEXT_PUBLIC_ rules. */
export type RefContext = "server" | "client" | "unknown";

/** One `process.env.X` reference found in the user's source. */
export interface EnvRef {
  name: string;
  file: string;
  line: number;
  context: RefContext;
  /** Why we classified it that way — surfaced in output so users can judge it. */
  contextReason: string;
}

/**
 * An env var key found in a local `.env*` file.
 *
 * Deliberately carries no value. `looksLikeSecret` is the only thing derived
 * from the value, and the value itself never leaves the parser.
 */
export interface EnvLocalKey {
  name: string;
  file: string;
  looksLikeSecret: boolean;
  /** True when the value is empty — often an unfinished `.env.example` copy. */
  isEmpty: boolean;
}

/** An env var configured on Vercel. Keys and scopes only — never values. */
export interface VercelEnvKey {
  name: string;
  scopes: EnvScope[];
  /**
   * Targets that aren't one of the three standard scopes — Vercel custom
   * environments. Tracked so a var scoped only to a custom environment isn't
   * reported as missing everywhere.
   */
  otherTargets: string[];
}

export type Framework =
  | "next-app-router"
  | "next-pages-router"
  | "next-mixed"
  | "node"
  | "unknown";

export interface ProjectContext {
  root: string;
  framework: Framework;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  nextVersion: string | null;
  nodeEngine: string | null;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  hasNextConfig: boolean;
  hasTsconfig: boolean;
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitContext {
  isRepo: boolean;
  branch: string | null;
  commits: GitCommit[];
  changedFiles: string[];
  diffStat: string | null;
  isDirty: boolean;
}

/** Normalized build output with the interesting part extracted. */
export interface BuildLogContext {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  command: string;
  /** Full captured output, ANSI-stripped. Capped by the ring buffer. */
  full: string;
  /** The lines most likely to explain the failure. */
  errorFrame: string[];
  truncated: boolean;
}

export interface VercelContext {
  available: boolean;
  /** Why it's unavailable, when it is — shown to the user verbatim. */
  unavailableReason?: string;
  projectId?: string;
  projectName?: string;
  framework?: string | null;
  nodeVersion?: string | null;
  envKeys?: VercelEnvKey[];
  deployments?: VercelDeployment[];
  failingDeploymentLog?: string[];
}

export interface VercelDeployment {
  id: string;
  state: string;
  target: string | null;
  createdAt: number;
  commitSha: string | null;
  commitMessage: string | null;
}

/** Everything the collectors gathered. The single input to analysis. */
export interface CollectedContext {
  project: ProjectContext;
  envRefs: EnvRef[];
  envLocal: EnvLocalKey[];
  git: GitContext;
  buildLog: BuildLogContext | null;
  vercel: VercelContext;
  /** Non-fatal collector failures, for display and debugging. */
  warnings: string[];
}

export type Severity = "error" | "warning" | "info";

export interface Finding {
  /** Stable id so findings can be suppressed or tested by name. */
  rule: string;
  /**
   * The env var this finding is about.
   *
   * Lets lower-severity notes be suppressed when the same variable already has
   * a real problem reported against it.
   */
  envVar?: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Concrete next action. Shown verbatim, so write it as a command or edit. */
  fix: string;
  /** `file:line` locations backing this finding. */
  locations: string[];
}
