import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  getChiefRunDir,
  buildWorkerPrompt,
  loadProjectStateFromProject,
  loadRunState,
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
    this.objective = null;
    this.persistedObjective = null;
    this.returnNullGoal = false;
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
    this.objective = objective;
    return { threadId, objective, status: "active" };
  }
  async getGoal(threadId) {
    this.calls.push(["thread/goal/get", threadId]);
    if (this.returnNullGoal) return null;
    return {
      threadId,
      objective: this.objective ?? this.persistedObjective ?? "persisted",
      status: this.status,
    };
  }
  async waitForGoal(threadId) {
    this.calls.push(["wait", threadId]);
    await Promise.resolve();
    if (this.status === "complete")
      await writeFile(join(this.root, "app.txt"), "goal\n");
    return {
      goal: {
        threadId,
        objective: this.objective ?? this.persistedObjective ?? "goal",
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

async function seedThreadStartedArtifact(
  f,
  prompt,
  threadId = "thread-test-1"
) {
  const path = join(
    getChiefRunDir(f.root, f.runId),
    "rounds/001/goal_worker.json"
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      run_id: f.runId,
      round: 1,
      task_id: "task-1",
      thread_id: threadId,
      objective_hash: createHash("sha256").update(prompt, "utf8").digest("hex"),
      started_at: NOW,
      updated_at: NOW,
      lifecycle: "thread_started",
      latest_goal_status: "active",
    })
  );
}

async function phasePrompt(f) {
  const project = await loadProjectStateFromProject(f.root);
  const run = await loadRunState(
    join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json")
  );
  return buildWorkerPrompt(project, run, project.tasks[0]);
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
  assert.equal(artifact.activation_evidence.method, "thread/goal/set");
  assert.equal(artifact.lifecycle, "terminal");
});
test("missing native Goal activation evidence fails closed", async () => {
  const f = await fixture();
  const transport = new FakeGoalTransport(f.root);
  transport.setGoal = async (threadId, objective) => ({
    threadId,
    objective,
    status: "complete",
  });
  const result = await runWorkerPhase({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    goalTransport: transport,
  });
  assert.equal(result.runState.phase, "FAILED");
  assert.match(result.runState.failure_reason, /activate|activation evidence/);
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
  second.persistedObjective = prompt;
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

test("crash after thread/start is recovered by setting one Goal on the same thread", async () => {
  const f = await fixture();
  const prompt = "crash before goal set";
  const first = new FakeGoalTransport(f.root);
  first.setGoal = async (threadId, objective) => {
    first.calls.push(["thread/goal/set", threadId, objective]);
    throw new Error("simulated crash before goal set");
  };
  const crashed = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    transport: first,
  });
  assert.match(crashed.error, /GOAL_RUNTIME_UNAVAILABLE/);
  const artifactPath = join(
    getChiefRunDir(f.root, f.runId),
    "rounds/001/goal_worker.json"
  );
  const inFlight = JSON.parse(await readFile(artifactPath, "utf8"));
  assert.equal(inFlight.lifecycle, "thread_started");
  const second = new FakeGoalTransport(f.root);
  second.returnNullGoal = true;
  const recovered = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    transport: second,
  });
  assert.equal(recovered.error, undefined);
  assert.equal(
    second.calls.filter(([method]) => method === "thread/start").length,
    0
  );
  assert.equal(
    second.calls.filter(([method]) => method === "thread/goal/set").length,
    1
  );
});

test("crash while Goal is active resumes the same Goal without a new activation", async () => {
  const f = await fixture();
  const prompt = "crash while active";
  const first = new FakeGoalTransport(f.root);
  first.waitForGoal = async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    throw new Error("simulated crash before terminal evidence");
  };
  const crashed = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    transport: first,
  });
  assert.match(crashed.error, /GOAL_RUNTIME_UNAVAILABLE/);
  const second = new FakeGoalTransport(f.root, "active");
  second.persistedObjective = prompt;
  second.waitForGoal = async (threadId) => ({
    goal: { threadId, objective: prompt, status: "complete" },
    activationSeen: false,
    text: "recovered",
  });
  const recovered = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    transport: second,
  });
  assert.equal(recovered.error, undefined);
  assert.equal(
    second.calls.filter(([method]) => method === "thread/goal/set").length,
    0
  );
  assert.equal(
    second.calls.filter(([method]) => method === "thread/goal/get").length,
    1
  );
});

test("terminal recovery accepts a matching Goal after activation evidence was not persisted", async () => {
  const f = await fixture();
  const prompt = "terminal recovery objective";
  await seedThreadStartedArtifact(f, prompt);
  const transport = new FakeGoalTransport(f.root, "complete");
  transport.persistedObjective = prompt;
  const result = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    transport,
  });
  assert.equal(result.error, undefined);
  assert.equal(
    transport.calls.filter(([method]) => method === "thread/start").length,
    0
  );
  assert.equal(
    transport.calls.filter(([method]) => method === "thread/goal/set").length,
    0
  );
  const artifact = JSON.parse(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "rounds/001/goal_worker.json"),
      "utf8"
    )
  );
  assert.equal(artifact.lifecycle, "terminal");
  assert.equal(artifact.recovery_evidence.method, "thread/goal/get");
  assert.equal(artifact.recovery_evidence.status, "complete");
});

for (const status of ["blocked", "usageLimited", "budgetLimited"]) {
  test(`terminal ${status} recovery preserves the existing mapping`, async () => {
    const f = await fixture();
    const prompt = await phasePrompt(f);
    await seedThreadStartedArtifact(f, prompt);
    const transport = new FakeGoalTransport(f.root, status);
    transport.persistedObjective = prompt;
    const result = await runWorkerPhase({
      projectRoot: f.root,
      runId: f.runId,
      config: config(),
      goalTransport: transport,
    });
    assert.equal(
      result.runState.phase,
      status === "blocked" ? "HUMAN_REQUIRED" : "FAILED"
    );
    assert.equal(
      transport.calls.filter(([method]) => method === "thread/goal/set").length,
      0
    );
  });
}

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

test("recovered Goal objective mismatch fails closed", async () => {
  const f = await fixture();
  const prompt = "bound objective";
  await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    transport: new FakeGoalTransport(f.root),
  });
  const transport = new FakeGoalTransport(f.root);
  transport.persistedObjective = "edited objective";
  const result = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    transport,
  });
  assert.match(result.error, /objective identity mismatch/);
  assert.equal(
    transport.calls.filter(([m]) => m === "thread/goal/set").length,
    0
  );
});

test("recovered Goal thread mismatch fails closed", async () => {
  const f = await fixture();
  const prompt = "bound thread";
  await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    transport: new FakeGoalTransport(f.root),
  });
  const transport = new FakeGoalTransport(f.root);
  transport.getGoal = async () => ({
    threadId: "wrong-thread",
    objective: prompt,
    status: "complete",
  });
  const result = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    transport,
  });
  assert.match(result.error, /thread identity mismatch/);
});

test("terminal Goal objective mismatch fails closed", async () => {
  const f = await fixture();
  const prompt = "terminal binding";
  const transport = new FakeGoalTransport(f.root);
  transport.waitForGoal = async (threadId) => ({
    goal: {
      threadId,
      objective: "edited terminal objective",
      status: "complete",
    },
    activationSeen: false,
    text: "edited",
  });
  const result = await runNativeGoalWorker({
    projectRoot: f.root,
    runId: f.runId,
    round: 1,
    taskId: "task-1",
    prompt,
    transport,
  });
  assert.match(result.error, /objective identity mismatch/);
});

test("Goal commit is rejected by existing Worker Git policy", async () => {
  const f = await fixture();
  const transport = new FakeGoalTransport(f.root);
  transport.waitForGoal = async (threadId) => {
    await Promise.resolve();
    await writeFile(join(f.root, "app.txt"), "goal\n");
    git(f.root, ["add", "app.txt"]);
    git(f.root, ["commit", "-qm", "forbidden goal commit"]);
    return {
      goal: {
        threadId,
        objective: transport.objective ?? "goal",
        status: "complete",
      },
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
