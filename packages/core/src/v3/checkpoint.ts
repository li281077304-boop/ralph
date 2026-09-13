import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { getChiefRunDir, getRoundDir } from "./rounds.js";
import { loadRunState, saveRunState, type RunState } from "./state.js";
import { writeJsonAtomic, writeJsonImmutable } from "./atomic-json.js";
import type { MachineGateResult } from "../machine-gate.js";

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
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
    const value = line.slice(3).trim();
    if (value && !value.includes(" -> ")) result.add(value);
  }
  return [...result].sort();
}
function diffHash(root: string): string {
  const diff = maybeGit(root, ["diff", "--binary", "HEAD"]);
  return hash(`${diff}\n${changedPaths(root).join("\n")}`);
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
  let intent = await readOptional(intentPath);
  const currentHead = git(root, ["rev-parse", "HEAD"]);
  if (!intent) {
    const taskId = state.current_task_id;
    if (!taskId) throw new Error("checkpoint requires current_task_id");
    const baseSha = state.head_evidence?.base ?? currentHead;
    if (currentHead !== baseSha) {
      throw new Error("HEAD changed before checkpoint intent was persisted");
    }
    intent = {
      version: 1,
      run_id: options.runId,
      round: state.round,
      task_id: taskId,
      base_sha: baseSha,
      branch,
      remote,
      changed_paths: changedPaths(root),
      diff_hash: diffHash(root),
      gate_passed: options.gate?.passed ?? false,
      commit_subject: `ralph(v3): ${taskId} round ${state.round}`,
      created_at: new Date().toISOString(),
    };
    await writeJsonImmutable(intentPath, intent);
  } else {
    if (
      intent.run_id !== options.runId ||
      intent.round !== state.round ||
      intent.branch !== branch ||
      intent.remote !== remote
    )
      throw new Error("checkpoint intent does not match current run");
  }
  const expectedBase = String(intent.base_sha);
  let head = git(root, ["rev-parse", "HEAD"]);
  if (head === expectedBase) {
    if (diffHash(root) !== String(intent.diff_hash))
      throw new Error("working tree no longer matches the checkpoint intent");
    git(root, ["add", "-A"]);
    const paths = changedPaths(root);
    const args = ["commit"];
    if (paths.length === 0) args.push("--allow-empty");
    args.push(
      "-m",
      commitMessage(String(intent.task_id), state.round, options.runId)
    );
    git(root, args);
    head = git(root, ["rev-parse", "HEAD"]);
  } else if (!commitMatches(root, intent)) {
    throw new Error(
      "HEAD is unrelated to the checkpoint intent; refusing to reset or create a duplicate"
    );
  }
  const expectedDiffHash = String(intent.diff_hash);
  if (head === expectedBase)
    throw new Error("checkpoint commit was not created");
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
