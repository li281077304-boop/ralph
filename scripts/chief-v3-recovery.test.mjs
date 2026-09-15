import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GitGuard,
  getChiefRunDir,
  applyChiefRecoveryDecision,
  parseChiefRecoveryDecision,
  prepareChiefRecovery,
  saveProjectStateToProject,
  saveRunState,
  workspaceFingerprint,
} from "../packages/core/dist/index.js";
import { runV3RecoveryTransport } from "../apps/cli/bin/ralph-chief-v3-recovery.js";

const NOW = "2026-09-15T00:00:00.000Z";
function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-recovery-"));
  git(root, ["init", "-q", "-b", "feature/recovery-test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Ralph Test"]);
  await writeFile(join(root, ".gitignore"), ".ralph/\n");
  await writeFile(join(root, "app.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const runId = "recovery-test";
  await saveProjectStateToProject(root, {
    version: 1,
    project_id: "recovery-test",
    goal: "recover technical worker failures",
    status: "active",
    current_milestone: "m1",
    current_task_id: "task-1",
    tasks: [
      {
        id: "task-1",
        title: "change app",
        goal: "change app",
        status: "in_progress",
        priority: 1,
        dependencies: [],
        acceptance: ["changed"],
        verification: ["gate"],
        evidence: ["app.txt"],
        source: "test",
        created_round: 1,
        updated_round: 1,
      },
    ],
    created_at: NOW,
    updated_at: NOW,
  });
  await saveRunState(join(getChiefRunDir(root, runId), "RUN_STATE.json"), {
    run_id: runId,
    version: 1,
    phase: "CHIEF_RECOVERY",
    status: "running",
    round: 1,
    current_task_id: "task-1",
    started_at: NOW,
    updated_at: NOW,
  });
  await writeFile(join(root, "app.txt"), "worker change\n");
  const snapshot = new GitGuard(root).snapshot();
  const block = {
    version: 1,
    run_id: runId,
    round: 1,
    task_id: "task-1",
    goal_status: "blocked",
    human_required: false,
    worker_error: "loopback unavailable",
    worker_text: "blocked",
    before: { head: snapshot.head },
    after: { head: snapshot.head },
    changed_paths: ["app.txt"],
    violations: [],
    before_branch: snapshot.branch,
    after_branch: snapshot.branch,
    before_workspace_fingerprint: workspaceFingerprint(snapshot),
    after_workspace_fingerprint: workspaceFingerprint(snapshot),
    previous_context: {},
    created_at: NOW,
  };
  const blockPath = join(
    getChiefRunDir(root, runId),
    "rounds/001/worker_block.json"
  );
  await mkdir(join(getChiefRunDir(root, runId), "rounds/001"), {
    recursive: true,
  });
  await writeFile(blockPath, JSON.stringify(block));
  return { root, runId, block, blockHash: hash(JSON.stringify(block)) };
}
function decision(f, action = "RETRY_WORKER", extra = {}) {
  return {
    action,
    summary: "technical recovery",
    technical_diagnosis: "environment limitation",
    worker_task:
      action === "RETRY_WORKER" ? "Use an in-process verification route." : "",
    verification_strategy: ["run the deterministic gate"],
    why_previous_approach_failed: "loopback unavailable",
    why_next_approach_should_work: "it avoids the unavailable route",
    human_question: "",
    human_options: [],
    human_required_reason: "",
    run_id: f.runId,
    round: 1,
    task_id: "task-1",
    worker_block_hash: f.blockHash,
    project_state_hash: f.projectHash,
    ...extra,
  };
}

test("Chief Recovery validates strict protocol and prepares durable handoff", async () => {
  const f = await fixture();
  const prep = await prepareChiefRecovery(f.root, f.runId);
  f.projectHash = prep.handoff.project_state_hash;
  assert.equal(prep.workerBlockHash, f.blockHash);
  assert.match(prep.handoffContent, /CHIEF_RECOVERY_JSON/);
  const persisted = JSON.parse(
    await readFile(prep.handoffPath.replace(/\.md$/, ".json"), "utf8")
  );
  assert.equal(persisted.worker_block_hash, f.blockHash);
});

test("RETRY_WORKER advances round and keeps the same task", async () => {
  const f = await fixture();
  const prep = await prepareChiefRecovery(f.root, f.runId);
  const applied = await applyChiefRecoveryDecision(
    f.root,
    f.runId,
    decision(f, "RETRY_WORKER", {
      project_state_hash: prep.handoff.project_state_hash,
    })
  );
  assert.equal(applied.runState.phase, "WORKER");
  assert.equal(applied.runState.round, 2);
  assert.equal(applied.runState.current_task_id, "task-1");
  assert.equal(
    (
      await readFile(
        join(
          getChiefRunDir(f.root, f.runId),
          "rounds/001/recovery_decision.json"
        ),
        "utf8"
      )
    ).length > 0,
    true
  );
  const resumed = await applyChiefRecoveryDecision(f.root, f.runId, undefined);
  assert.equal(resumed.runState.phase, "WORKER");
  assert.equal(resumed.runState.round, 2);
});

test("RUN_MACHINE_GATE is accepted only for safe non-empty changes", async () => {
  const f = await fixture();
  const prep = await prepareChiefRecovery(f.root, f.runId);
  const applied = await applyChiefRecoveryDecision(
    f.root,
    f.runId,
    decision(f, "RUN_MACHINE_GATE", {
      project_state_hash: prep.handoff.project_state_hash,
    })
  );
  assert.equal(applied.runState.phase, "MACHINE_GATE");
  const evidence = JSON.parse(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "rounds/001/worker_evidence.json"),
      "utf8"
    )
  );
  assert.equal(evidence.recovered_from_technical_block, true);
  assert.equal(evidence.worker_reported_complete, false);
});

test("HUMAN_REQUIRED only accepts explicit user-only reason categories", () => {
  assert.throws(
    () =>
      parseChiefRecoveryDecision({
        action: "HUMAN_REQUIRED",
        summary: "",
        technical_diagnosis: "",
        worker_task: "",
        verification_strategy: [],
        why_previous_approach_failed: "",
        why_next_approach_should_work: "",
        human_question: "fix environment",
        human_options: [],
        human_required_reason: "ENVIRONMENT_LIMITATION",
        run_id: "r",
        round: 1,
        task_id: "t",
        worker_block_hash: "0".repeat(64),
        project_state_hash: "0".repeat(64),
      }),
    /not user-only/
  );
});

test("HUMAN_REQUIRED with BUSINESS_DECISION is accepted", () => {
  const parsed = parseChiefRecoveryDecision({
    action: "HUMAN_REQUIRED",
    summary: "decision needed",
    technical_diagnosis: "policy ambiguous",
    worker_task: "",
    verification_strategy: [],
    why_previous_approach_failed: "",
    why_next_approach_should_work: "",
    human_question: "Which policy applies?",
    human_options: ["A", "B"],
    human_required_reason: "BUSINESS_DECISION: policy",
    run_id: "r",
    round: 1,
    task_id: "t",
    worker_block_hash: "0".repeat(64),
    project_state_hash: "0".repeat(64),
  });
  assert.equal(parsed.action, "HUMAN_REQUIRED");
});

test("malformed, mismatched and empty recovery decisions fail closed", async () => {
  const f = await fixture();
  const prep = await prepareChiefRecovery(f.root, f.runId);
  const base = decision(f, "RETRY_WORKER", {
    project_state_hash: prep.handoff.project_state_hash,
  });
  await assert.rejects(
    applyChiefRecoveryDecision(f.root, f.runId, { ...base, task_id: "other" }),
    /identity\/hash mismatch/
  );
  await assert.rejects(
    applyChiefRecoveryDecision(f.root, f.runId, { ...base, worker_task: "" }),
    /RETRY_WORKER requires/
  );
});

test("host Chief Recovery RETRY response applies without GUI", async () => {
  const f = await fixture();
  const prep = await prepareChiefRecovery(f.root, f.runId);
  const response = {
    action: "RETRY_WORKER",
    summary: "retry with in-process verification",
    technical_diagnosis: "loopback is unavailable",
    worker_task: "use the repository's in-process test client",
    verification_strategy: ["run the deterministic gate"],
    why_previous_approach_failed: "it required a bound localhost port",
    why_next_approach_should_work: "it does not bind a port",
    human_question: "",
    human_options: [],
    human_required_reason: "",
    run_id: f.runId,
    round: 1,
    task_id: "task-1",
    worker_block_hash: prep.workerBlockHash,
    project_state_hash: prep.handoff.project_state_hash,
  };
  let calls = 0;
  const result = await runV3RecoveryTransport({
    projectRoot: f.root,
    runId: f.runId,
    transport: async () => {
      calls += 1;
      return {
        reply: `<<<CHIEF_RECOVERY_JSON>>>${JSON.stringify(response)}<<<END_CHIEF_RECOVERY_JSON>>>`,
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.runState.phase, "WORKER");
  assert.equal(result.runState.round, 2);
});
