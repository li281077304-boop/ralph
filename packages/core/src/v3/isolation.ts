import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

/** Create a Ralph-owned detached worktree without touching the user's checkout. */
export async function createIsolatedWorktree(options: {
  projectRoot: string;
  runId: string;
  baseCommit?: string;
  worktreePath?: string;
}): Promise<{ worktreePath: string; baseCommit: string; branch: string }> {
  const baseCommit = options.baseCommit ?? "HEAD";
  const target =
    options.worktreePath ??
    join(tmpdir(), "ralph-worktrees", `${options.runId}-${Date.now()}`);
  await mkdir(join(target, ".."), { recursive: true });
  const branch = `ralph/${options.runId}`;
  await execFileAsync(
    "git",
    ["worktree", "add", "-b", branch, target, baseCommit],
    {
      cwd: options.projectRoot,
    }
  );
  const base = String(
    (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: target })).stdout
  ).trim();
  await mkdir(
    join(options.projectRoot, ".ralph", "chief-runs", options.runId),
    {
      recursive: true,
    }
  );
  await writeFile(
    join(
      options.projectRoot,
      ".ralph",
      "chief-runs",
      options.runId,
      "isolation.json"
    ),
    `${JSON.stringify({ version: 1, run_id: options.runId, worktree_path: target, base_commit: base, branch, created_at: new Date().toISOString() }, null, 2)}\n`,
    { flag: "wx" }
  ).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  return { worktreePath: target, baseCommit: base, branch };
}
