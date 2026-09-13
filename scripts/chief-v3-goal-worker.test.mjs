import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getChiefRunDir,
  runNativeGoalWorker,
  runWorkerPhase,
  saveProjectStateToProject,
  saveRunState,
} from "../packages/core/dist/index.js";

const NOW = "2026-09-13T00:00:00.000Z";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

class FakeGoalTransport {
  constructor(root, status = "complete", activationSeen = true) {
    this.root = root;
    this.status = status;
    this.activationSeen = activationSeen;
    this.calls = [];
    this.closed = false;
  }
  async initialize() {
    this.calls.push(["initialize"]);
  }
  async startThread(params) {
    this.calls.push(["thread/start", params]);
    return { threadId: "thread-test-1" };
  }
  async resumeThread(threadId) {
    this.calls.push(["thread/resume", threadId]);
  }
  async setGoal(threadId, objective) {
    this.calls.push(["thread/goal/set", threadId, objective]);
    return { threadId, objective, status: "active" };
  }
  async getGoal(threadId) {
    this.calls.push(["thread/goal/get", threadId]);
    return {
      threadId,
      objective: "persisted",
      status: this.status,
    };
  }
  async waitForGoal(threadId) {
    this.calls.push(["wait", threadId]);
    if (this.status === "complete")
      await writeFile(join(this.root, "app.txt"), "goal\n");
    return {
      goal: {
        threadId,
        objective: "goal",
        status: this.status,
        tokensUsed: 17,
        timeUsedSeconds: 2,
      },
      activationSeen: this.activationSeen,
      text: "goal finished",
    };
  }
  async close() {
    this.closed = true;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ralph-goal-worker-"));
  git(root, ["init", "-q", "-b", "feature/goal-test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Ralph Test"]);
  await writeFile(join(root, ".gitignore"), ".ralph/\n");
  await writeFile(join(root, "app.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const runId = `goal-${Math.random().toString(16).slice(2)}`;
  await saveProjectStateToProject(root, {
    version: 1,
    project_id: "goal-test",
    goal: "native goal fixture",
    status: "active",
    current_milestone: "m1",
    current_task_id: "task-1",
    tasks: [
      {
        id: "task-1",
        title: "change fixture",
        goal: "make the fixture change",
        status: "in_progress",
        priority: 1,
        dependencies: [],
        acceptance: ["app changes"],
        verification: ["gate"],
        evidence: ["fixture"],
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
    phase: "WORKER",
    status: "running",
    round: 1,
    current_task_id: "task-1",
    started_at: NOW,
    updated_at: NOW,
  });
  return { root, runId };
}

function config() {
  return {
    worker: { agent: "codex", mode: "native_goal", model: "gpt-5.6-luna" },
    forbidden_paths: [],
    protected_paths: [],
    max_diff_bytes: 100_000,
    max_changed_paths: 10,
  };
}

test("complete native Goal reaches MACHINE_GATE with activation evidence", async () => {
  const f = await fixture();
  const transport = new FakeGoalTransport(f.root);
  const result = await runWorkerPhase({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    goalTransport: transport,
  });
  assert.equal(result.runState.phase, "MACHINE_GATE");
  assert.equal(
    transport.calls.some(([method]) => method === "thread/goal/set"),
    true
  );
  const artifact = JSON.parse(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "rounds/001/goal_worker.json"),
      "utf8"
    )
  );
  assert.equal(artifact.latest_goal_status, "complete");
  assert.equal(artifact.activation_evidence.method, "thread/goal/updated");
});
test("missing native Goal activation evidence fails closed", async () => {
  const f = await fixture();
  const result = await runWorkerPhase({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    goalTransport: new FakeGoalTransport(f.root, "complete", false),
  });
  assert.equal(result.runState.phase, "FAILED");
  assert.match(result.runState.failure_reason, /activation evidence/);
});

for (const status of ["paused", "usageLimited", "budgetLimited"]) {
  test(`Goal ${status} fails closed without entering Gate`, async () => {
    const f = await fixture();
    const result = await runWorkerPhase({
      projectRoot: f.root,
      runId: f.runId,
      config: config(),
      goalTransport: new FakeGoalTransport(f.root, status),
    });
    assert.equal(result.runState.phase, "FAILED");
    assert.match(
      result.runState.failure_reason,
      new RegExp(`GOAL_STATUS:${status}`)
    );
  });
}

test("Goal blocked maps to HUMAN_REQUIRED and does not enter Gate", async () => {
  const f = await fixture();
  const result = await runWorkerPhase({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    goalTransport: new FakeGoalTransport(f.root, "blocked"),
  });
  assert.equal(result.runState.phase, "HUMAN_REQUIRED");
  assert.equal(result.runState.status, "waiting");
});

test("recovery reuses the persisted thread and never sets a replacement Goal", async () => {
  const f = await fixture();
  const first = new FakeGoalTransport(f.root);
  const prompt = "same durable objective";
  const initial = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    model: "gpt-5.6-luna",
    transport: first,
  });
  assert.equal(initial.error, undefined);
  const second = new FakeGoalTransport(f.root);
  const recovered = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    model: "gpt-5.6-luna",
    transport: second,
  });
  assert.equal(recovered.error, undefined);
  assert.equal(
    second.calls.some(([method]) => method === "thread/start"),
    false
  );
  assert.equal(
    second.calls.some(([method]) => method === "thread/goal/set"),
    false
  );
  assert.equal(
    second.calls.some(([method]) => method === "thread/resume"),
    true
  );
});

test("objective mismatch cannot recover an existing Goal", async () => {
  const f = await fixture();
  await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt: "objective-a",
    transport: new FakeGoalTransport(f.root),
  });
  const transport = new FakeGoalTransport(f.root);
  const result = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt: "objective-b",
    transport,
  });
  assert.match(result.error, /identity mismatch/);
  assert.equal(transport.calls.length, 0);
});

test("Goal commit is rejected by existing Worker Git policy", async () => {
  const f = await fixture();
  const transport = new FakeGoalTransport(f.root);
  transport.waitForGoal = async (threadId) => {
    await writeFile(join(f.root, "app.txt"), "goal\n");
    git(f.root, ["add", "app.txt"]);
    git(f.root, ["commit", "-qm", "forbidden goal commit"]);
    return {
      goal: { threadId, objective: "goal", status: "complete" },
      activationSeen: true,
      text: "committed",
    };
  };
  const result = await runWorkerPhase({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    goalTransport: transport,
  });
  assert.equal(result.runState.phase, "FAILED");
  assert.match(result.runState.failure_reason, /Worker policy violation/);
});
