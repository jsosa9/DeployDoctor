import { simpleGit } from "simple-git";
import type { GitContext } from "../types.js";

const COMMIT_COUNT = 5;

/**
 * Collects recent history so a diagnosis can correlate a failure with what
 * just changed. Returns `isRepo: false` rather than throwing outside a repo.
 */
export async function collectGit(root: string): Promise<GitContext> {
  const empty: GitContext = {
    isRepo: false,
    branch: null,
    commits: [],
    changedFiles: [],
    diffStat: null,
    isDirty: false,
  };

  try {
    const git = simpleGit(root);
    if (!(await git.checkIsRepo())) return empty;

    const [log, status, branch] = await Promise.all([
      git.log({ maxCount: COMMIT_COUNT }),
      git.status(),
      git.revparse(["--abbrev-ref", "HEAD"]).catch(() => null),
    ]);

    // A shallow or brand-new repo may not have COMMIT_COUNT ancestors, so the
    // range diff is attempted separately and allowed to fail.
    const range = `HEAD~${Math.min(COMMIT_COUNT, Math.max(log.total - 1, 0))}`;
    const [changedFiles, diffStat] = await Promise.all([
      git.diff([range, "--name-only"]).then((s) => s.split("\n").filter(Boolean)).catch(() => []),
      git.diff([range, "--stat"]).catch(() => null),
    ]);

    return {
      isRepo: true,
      branch: branch?.trim() || null,
      commits: log.all.map((c) => ({
        hash: c.hash.slice(0, 8),
        subject: c.message,
        author: c.author_name,
        date: c.date,
      })),
      changedFiles,
      diffStat,
      isDirty: !status.isClean(),
    };
  } catch {
    return empty;
  }
}
