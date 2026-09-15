import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyChiefRecoveryDecision,
  getChiefRunDir,
  persistWorkerBlock,
  prepareChiefRecovery,
  saveProjectStateToProject,
  saveRunState,
  stableFailureSignature,
} from "../packages/core/dist/index.js";

const now = "2026-09-15T00:00:00.000Z";
const task = (id, status = "in_progress") => ({
  id,
  title: id,
  goal: id,
  status,
  priority: 1,
  dependencies: [],
  acceptance: ["done"],
  verification: ["test"],
  evidence: [],
  source: "test",
  created_round: 1,
  updated_round: 1,
});

async function fixture(withQueued = true) {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-recovery-"));
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  await writeFile(join(root, "app.txt"), "base\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);
  const runId = "recovery-test";
  await saveProjectStateToProject(root, {
    version: 1,
    project_id: "p",
    goal: "g",
    status: "active",
    current_milestone: "m",
    current_task_id: "task-a",
    tasks: [task("task-a"), ...(withQueued ? [task("task-b", "queued")] : [])],
    created_at: now,
    updated_at: now,
  });
  await saveRunState(join(getChiefRunDir(root, runId), "RUN_STATE.json"), {
    run_id: runId,
    version: 1,
    phase: "CHIEF_RECOVERY",
    status: "running",
    round: 1,
    current_task_id: "task-a",
    started_at: now,
    updated_at: now,
  });
  const head = git(["rev-parse", "HEAD"]);
  const snapshot = {
    branch: "main",
    head,
    status: "",
    diff_hash: "",
    staged_diff_hash: "",
    untracked_hash: "",
    fingerprint: "fingerprint",
  };
  await persistWorkerBlock(root, {
    run_id: runId,
    round: 1,
    task_id: "task-a",
    goal_status: "blocked",
    human_required: false,
    failure_kind: "technical",
    worker_error: "test command failed",
    worker_text: "blocked",
    before: snapshot,
    after: snapshot,
    changed_paths: ["app.txt"],
    violations: [],
    before_branch: "main",
    after_branch: "main",
    before_workspace_fingerprint: {},
    after_workspace_fingerprint: {},
    previous_context: {},
  });
  return { root, runId, snapshot };
}

function decision(preparation, overrides = {}) {
  return {
    action: "RETRY_WORKER",
    summary: "retry",
    technical_diagnosis: "command failed",
    worker_task: "use project runner",
    verification_strategy: ["run gate"],
    why_previous_approach_failed: "wrong command",
    why_next_approach_should_work: "project runner exists",
    human_question: "",
    human_options: [],
    human_required_reason: "",
    human_category: "",
    run_id: preparation.runState.run_id,
    round: preparation.runState.round,
    task_id: preparation.runState.current_task_id,
    worker_block_hash: preparation.workerBlockHash,
    project_state_hash: preparation.handoff.project_state_hash,
    ...overrides,
  };
}

test("technical worker block creates an identity-bound recovery and fresh Worker round", async () => {
  const f = await fixture();
  try {
    const preparation = await prepareChiefRecovery(f.root, f.runId);
    const applied = await applyChiefRecoveryDecision(
      f.root,
      f.runId,
      decision(preparation)
    );
    assert.equal(applied.runState.phase, "WORKER");
    assert.equal(applied.runState.round, 2);
    assert.equal(applied.runState.current_task_id, "task-a");
    const context = JSON.parse(
      await readFile(
        join(
          getChiefRunDir(f.root, f.runId),
          "rounds/002/recovery_resume_context.json"
        ),
        "utf8"
      )
    );
    assert.equal(context.worker_task, "use project runner");
    assert.equal(
      context.failure_signature,
      stableFailureSignature("test command failed")
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("technical block cannot be converted into a Human Backlog item", async () => {
  const f = await fixture();
  try {
    const preparation = await prepareChiefRecovery(f.root, f.runId);
    await assert.rejects(
      applyChiefRecoveryDecision(
        f.root,
        f.runId,
        decision(preparation, {
          action: "HUMAN_BLOCK",
          summary: "need help",
          human_question: "choose",
          human_required_reason: "ENVIRONMENT_LIMITATION: no port",
          human_category: "BUSINESS_DECISION",
        })
      ),
      /technical worker failures cannot HUMAN_BLOCK/
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
