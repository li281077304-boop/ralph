import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getChiefRunDir, getRoundDir } from "./rounds.js";
import { loadRunState, saveRunState, type RunState } from "./state.js";
import { writeJsonAtomic, writeJsonImmutable } from "./atomic-json.js";
import type { MachineGateResult } from "../machine-gate.js";
import { GitGuard, workspaceFingerprint } from "../git-guard.js";

export type V3CheckpointConfig = {
  remote?: string;
};

export type CheckpointResult = {
  runState: RunState;
  checkpoint: Record<string, unknown>;
};

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function gitBytes(root: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd: root }) as Buffer;
}
function gitWithEnv(
  root: string,
  args: string[],
  env: Record<string, string>
): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}
function maybeGit(root: string, args: string[]): string {
  try {
    return git(root, args);
  } catch {
    return "";
  }
}
function pathFor(root: string, runId: string): string {
  return join(getChiefRunDir(root, runId), "RUN_STATE.json");
}
function roundPath(
  root: string,
  runId: string,
  round: number,
  name: string
): string {
  return join(getRoundDir(getChiefRunDir(root, runId), round), name);
}
function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
async function readOptional(
  path: string
): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function branchName(root: string): string {
  return maybeGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
}
function remoteUrl(root: string, remote: string): string {
  return maybeGit(root, ["remote", "get-url", remote]);
}
function changedPaths(root: string): string[] {
  const result = new Set<string>();
  const tracked = maybeGit(root, ["diff", "--name-only", "HEAD"])
    .split(/\r?\n/)
    .filter(Boolean);
  for (const path of tracked) result.add(path);
  const status = maybeGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const value = line.slice(2).trim();
    if (value && !value.includes(" -> ")) result.add(value);
  }
  return [...result].sort();
}
function workingTreeDiffHash(root: string): string {
  const diff = maybeGit(root, ["diff", "--binary", "HEAD"]);
  return hash(`${diff}\n${changedPaths(root).join("\n")}`);
}
function committedDiffHash(root: string, base: string, head: string): string {
  return hash(gitBytes(root, ["diff", "--binary", base, head]));
}
function treeSha(root: string, ref: string): string {
  return git(root, ["rev-parse", `${ref}^{tree}`]);
}
function cleanWorktree(root: string): boolean {
  return (
    maybeGit(root, ["status", "--porcelain=v1", "--untracked-files=all"])
      .split("\n")
      .filter((line) => {
        const path = line.slice(2).trim().replaceAll("\\", "/");
        return path !== "devlog" && !path.startsWith("devlog/");
      })
      .join("\n") === ""
  );
}
async function expectedTreeSha(root: string, baseSha: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "ralph-v3-index-"));
  const indexPath = join(tempDir, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    gitWithEnv(root, ["read-tree", baseSha], env);
    gitWithEnv(root, ["add", "-A"], env);
    return gitWithEnv(root, ["write-tree"], env);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
function commitMessage(taskId: string, round: number, runId: string): string {
  return [
    `ralph(v3): ${taskId} round ${round}`,
    "",
    `Ralph-Run-ID: ${runId}`,
    `Ralph-Round: ${round}`,
    `Ralph-Task-ID: ${taskId}`,
  ].join("\n");
}
function commitMatches(
  root: string,
  intent: Record<string, unknown>
): string | undefined {
  const head = maybeGit(root, ["rev-parse", "HEAD"]);
  if (!head) return undefined;
  const parents = maybeGit(root, ["show", "-s", "--format=%P", head])
    .split(/\s+/)
    .filter(Boolean);
  const body = maybeGit(root, ["show", "-s", "--format=%B", head]);
  if (
    parents.length !== 1 ||
    parents[0] !== intent.base_sha ||
    !body.includes(`Ralph-Run-ID: ${intent.run_id}`) ||
    !body.includes(`Ralph-Round: ${intent.round}`) ||
    !body.includes(`Ralph-Task-ID: ${intent.task_id}`)
  )
    return undefined;
  return head;
}
function remoteHead(root: string, remote: string, branch: string): string {
  const output = maybeGit(root, ["ls-remote", "--heads", remote, branch]);
  return output.split(/\s+/)[0] || "";
}
function pushAndVerify(
  root: string,
  remote: string,
  branch: string,
  head: string
): void {
  const existing = remoteHead(root, remote, branch);
  if (existing !== head) git(root, ["push", remote, `HEAD:${branch}`]);
  if (remoteHead(root, remote, branch) !== head)
    throw new Error(
      "remote branch does not point to checkpoint HEAD after push"
    );
}

export async function runCheckpointPhase(options: {
  projectRoot: string;
  runId: string;
  config?: V3CheckpointConfig;
  gate?: MachineGateResult;
}): Promise<CheckpointResult> {
  const root = options.projectRoot;
  const runPath = pathFor(root, options.runId);
  const state = await loadRunState(runPath);
  if (state.phase !== "CHECKPOINT" || state.status !== "running")
    throw new Error("V3 checkpoint requires CHECKPOINT/running state");
  const branch = branchName(root);
  if (!branch) throw new Error("checkpoint requires a non-detached Git branch");
  if (["main", "master", "trunk"].includes(branch))
    throw new Error(`checkpoint refuses protected branch: ${branch}`);
  const remote = options.config?.remote ?? "origin";
  const roundDir = getRoundDir(
    getChiefRunDir(root, options.runId),
    state.round
  );
  await mkdir(roundDir, { recursive: true });
  const intentPath = roundPath(
    root,
    options.runId,
    state.round,
    "checkpoint_intent.json"
  );
  const checkpointPath = roundPath(
    root,
    options.runId,
    state.round,
    "checkpoint.json"
  );
  const gatePath = roundPath(
    root,
    options.runId,
    state.round,
    "machine_gate.json"
  );
  const gateBytes = await readFile(gatePath);
  const gateArtifactHash = hash(gateBytes);
  const gateArtifact = JSON.parse(gateBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  const gatedWorkspaceFingerprint = gateArtifact.after_workspace_fingerprint;
  const gateBeforeBranch = gateArtifact.before_branch;
  const gateAfterBranch = gateArtifact.after_branch;
  if (
    !gatedWorkspaceFingerprint ||
    typeof gateBeforeBranch !== "string" ||
    typeof gateAfterBranch !== "string" ||
    gateBeforeBranch !== gateAfterBranch ||
    gateAfterBranch !== branch
  ) {
    throw new Error("machine gate branch/workspace evidence is incomplete");
  }
  if (
    typeof gateArtifact.policy_passed !== "boolean" ||
    !Array.isArray(gateArtifact.policy_violations) ||
    gateArtifact.policy_violations.some((item) => typeof item !== "string")
  ) {
    throw new Error("machine_gate.json policy evidence is incomplete");
  }
  if (!gateArtifact.policy_passed) {
    throw new Error(
      `Machine Gate policy failure: ${(gateArtifact.policy_violations as string[]).join(", ")}`
    );
  }
  let intent = await readOptional(intentPath);
  const currentHead = git(root, ["rev-parse", "HEAD"]);
  if (!intent) {
    const taskId = state.current_task_id;
    if (!taskId) throw new Error("checkpoint requires current_task_id");
    const baseSha = state.head_evidence?.base ?? currentHead;
    if (currentHead !== baseSha) {
      throw new Error("HEAD changed before checkpoint intent was persisted");
    }
    const currentWorkspace = workspaceFingerprint(
      new GitGuard(root).snapshot()
    );
    if (
      JSON.stringify(currentWorkspace) !==
      JSON.stringify(gatedWorkspaceFingerprint)
    )
      throw new Error(
        "current workspace does not match the completed Machine Gate"
      );
    intent = {
      version: 1,
      run_id: options.runId,
      round: state.round,
      task_id: taskId,
      base_sha: baseSha,
      branch,
      remote,
      changed_paths: changedPaths(root),
      diff_hash: workingTreeDiffHash(root),
      gate_passed:
        options.gate?.passed ??
        (typeof gateArtifact.passed === "boolean"
          ? gateArtifact.passed
          : false),
      gated_workspace_fingerprint: gatedWorkspaceFingerprint,
      gate_artifact_hash: gateArtifactHash,
      expected_tree_sha: await expectedTreeSha(root, baseSha),
      commit_subject: `ralph(v3): ${taskId} round ${state.round}`,
      created_at: new Date().toISOString(),
    };
    await writeJsonImmutable(intentPath, intent);
  } else {
    if (
      intent.run_id !== options.runId ||
      intent.round !== state.round ||
      intent.branch !== branch ||
      intent.remote !== remote ||
      intent.gate_artifact_hash !== gateArtifactHash ||
      JSON.stringify(intent.gated_workspace_fingerprint) !==
        JSON.stringify(gatedWorkspaceFingerprint) ||
      typeof intent.expected_tree_sha !== "string"
    )
      throw new Error("checkpoint intent does not match current run");
  }
  const expectedBase = String(intent.base_sha);
  let head = git(root, ["rev-parse", "HEAD"]);
  if (head === expectedBase) {
    const currentWorkspace = workspaceFingerprint(
      new GitGuard(root).snapshot()
    );
    if (
      JSON.stringify(currentWorkspace) !==
      JSON.stringify(intent.gated_workspace_fingerprint)
    )
      throw new Error(
        "current workspace does not match the completed Machine Gate"
      );
    if (workingTreeDiffHash(root) !== String(intent.diff_hash))
      throw new Error("working tree no longer matches the checkpoint intent");
    git(root, ["add", "-A"]);
    if (git(root, ["write-tree"]) !== String(intent.expected_tree_sha))
      throw new Error("staged tree does not match the checkpoint intent");
    const paths = changedPaths(root);
    const args = ["commit"];
    if (paths.length === 0) args.push("--allow-empty");
    args.push(
      "-m",
      commitMessage(String(intent.task_id), state.round, options.runId)
    );
    git(root, args);
    head = git(root, ["rev-parse", "HEAD"]);
  } else {
    if (!commitMatches(root, intent)) {
      throw new Error(
        "HEAD is unrelated to the checkpoint intent; refusing to reset or create a duplicate"
      );
    }
    if (treeSha(root, head) !== String(intent.expected_tree_sha))
      throw new Error("existing checkpoint commit tree does not match intent");
  }
  if (head === expectedBase)
    throw new Error("checkpoint commit was not created");
  if (treeSha(root, head) !== String(intent.expected_tree_sha))
    throw new Error("checkpoint commit tree does not match intent");
  if (branchName(root) !== String(intent.branch))
    throw new Error("current branch no longer matches the gated branch");
  if (!cleanWorktree(root))
    throw new Error("checkpoint worktree is not clean before push");
  const expectedDiffHash = committedDiffHash(root, expectedBase, head);
  pushAndVerify(root, remote, branch, head);
  const checkpoint = {
    version: 1,
    run_id: options.runId,
    round: state.round,
    task_id: intent.task_id,
    base_sha: expectedBase,
    head_sha: head,
    branch,
    remote,
    remote_url: remoteUrl(root, remote),
    diff_hash: expectedDiffHash,
    gated_workspace_fingerprint: intent.gated_workspace_fingerprint,
    gate_artifact_hash: intent.gate_artifact_hash,
    expected_tree_sha: intent.expected_tree_sha,
    changed_paths: intent.changed_paths,
    gate_passed: intent.gate_passed,
    pushed: true,
    created_at: new Date().toISOString(),
  };
  await writeJsonAtomic(checkpointPath, checkpoint);
  const next: RunState = {
    ...state,
    phase: "CHIEF_REVIEW",
    status: "running",
    head_evidence: { base: expectedBase, head, diff_hash: expectedDiffHash },
    updated_at: new Date().toISOString(),
  };
  await saveRunState(runPath, next);
  return { runState: next, checkpoint };
}
