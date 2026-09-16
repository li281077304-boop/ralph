import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GitGuard,
  isControllerOwnedPath,
  getChiefRunDir,
  getRoundDir,
  runCheckpointPhase,
  saveRunState,
  workspaceFingerprint,
} from "../packages/core/dist/index.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "ralph-checkpoint-scope-"));
  git(root, ["init", "-q", "-b", "feature/test"]);
  git(root, ["config", "user.email", "ralph@example.test"]);
  git(root, ["config", "user.name", "Ralph Test"]);
  await writeFile(join(root, "README.md"), "base\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

test("controller-owned runtime paths are excluded from product fingerprints", async () => {
  assert.equal(isControllerOwnedPath(".ralph/RUN_STATE.json"), true);
  assert.equal(isControllerOwnedPath("devlog/001/context.md"), true);
  assert.equal(isControllerOwnedPath("src/product.ts"), false);

  const root = await repo();
  const guard = new GitGuard(root);
  const before = guard.snapshot();
  await mkdir(join(root, ".ralph"), { recursive: true });
  await mkdir(join(root, "devlog"), { recursive: true });
  await writeFile(join(root, ".ralph/RUN_STATE.json"), '{"phase":"WORKER"}\n');
  await writeFile(join(root, "devlog/001-context.md"), "runtime evidence\n");
  const runtimeOnly = guard.snapshot();
  assert.deepEqual(guard.changedPaths(before, runtimeOnly), []);
  assert.deepEqual(
    workspaceFingerprint(before),
    workspaceFingerprint(runtimeOnly)
  );

  await writeFile(join(root, "src-product.txt"), "product change\n");
  const productAndRuntime = guard.snapshot();
  assert.deepEqual(guard.changedPaths(before, productAndRuntime), [
    "src-product.txt",
  ]);
  assert.notDeepEqual(
    workspaceFingerprint(before),
    workspaceFingerprint(productAndRuntime)
  );
});

test("checkpoint commits product files but never .ralph or devlog runtime", async () => {
  const root = await repo();
  const remote = await mkdtemp(join(tmpdir(), "ralph-checkpoint-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-q", "-u", "origin", "feature/test"]);
  const runId = "scope-checkpoint";
  const runDir = getChiefRunDir(root, runId);
  const roundDir = getRoundDir(runDir, 1);
  await mkdir(roundDir, { recursive: true });
  const now = new Date().toISOString();
  const base = git(root, ["rev-parse", "HEAD"]);
  await saveRunState(join(runDir, "RUN_STATE.json"), {
    version: 1,
    run_id: runId,
    phase: "CHECKPOINT",
    status: "running",
    round: 1,
    current_task_id: "task-1",
    started_at: now,
    updated_at: now,
    head_evidence: { base, head: base },
  });
  await mkdir(join(root, ".ralph"), { recursive: true });
  await mkdir(join(root, "devlog"), { recursive: true });
  await writeFile(join(root, ".ralph/RUN_STATE.json"), "runtime\n");
  await writeFile(join(root, "devlog/context.md"), "runtime\n");
  await writeFile(join(root, "product.txt"), "product\n");
  const snapshot = new GitGuard(root).snapshot();
  const fingerprint = workspaceFingerprint(snapshot);
  await writeFile(
    join(roundDir, "worker_evidence.json"),
    `${JSON.stringify({
      completed: true,
      after_workspace_fingerprint: fingerprint,
      after_branch: snapshot.branch,
      changed_paths: ["product.txt"],
    })}\n`
  );
  await writeFile(
    join(roundDir, "machine_gate.json"),
    `${JSON.stringify({
      version: 1,
      passed: true,
      commands: [],
      before_workspace_fingerprint: fingerprint,
      after_workspace_fingerprint: fingerprint,
      before_branch: snapshot.branch,
      after_branch: snapshot.branch,
      policy_passed: true,
      policy_violations: [],
      required_gate_passed: true,
      required_gate_failures: [],
    })}\n`
  );
  const result = await runCheckpointPhase({
    projectRoot: root,
    runId,
    config: { remote: "origin" },
    gate: { passed: true, commands: [] },
  });
  assert.deepEqual(result.checkpoint.changed_paths, ["product.txt"]);
  assert.equal(
    git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).includes(".ralph/"),
    false
  );
  assert.equal(
    git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).includes("devlog/"),
    false
  );
  assert.equal(
    git(root, ["show", "--format=", "--name-only", "HEAD"]),
    "product.txt"
  );
});
