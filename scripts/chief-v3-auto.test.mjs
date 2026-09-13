import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getChiefRunDir,
  runV3UnattendedTask,
  saveProjectStateToProject,
  saveRunState,
} from "../packages/core/dist/index.js";
import { runV3ReviewTransport } from "../apps/cli/bin/ralph-chief-v3-review.js";
import {
  REVIEW_CLOSE_MARKER,
  REVIEW_OPEN_MARKER,
} from "../apps/cli/bin/ralph-chief-v3-review.js";

const NOW = "2026-09-13T00:00:00.000Z";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

class FakeGoalTransport {
  constructor(root) {
    this.root = root;
    this.calls = [];
    this.round = 0;
    this.objective = null;
  }
  async initialize() {
    this.calls.push("initialize");
  }
  async startThread() {
    this.round += 1;
    const threadId = `auto-thread-${this.round}`;
    this.calls.push(["thread/start", threadId]);
    return { threadId };
  }
  async resumeThread(threadId) {
    this.calls.push(["thread/resume", threadId]);
  }
  async setGoal(threadId, objective) {
    this.objective = objective;
    this.calls.push(["thread/goal/set", threadId]);
    return { threadId, objective, status: "active" };
  }
  async getGoal(threadId) {
    this.calls.push(["thread/goal/get", threadId]);
    return null;
  }
  async waitForGoal(threadId) {
    await writeFile(join(this.root, "app.txt"), `worker-${this.round}\n`);
    this.calls.push(["wait", threadId]);
    return {
      goal: { threadId, objective: this.objective, status: "complete" },
      activationSeen: false,
      text: "completed",
    };
  }
  async close() {}
}

function config() {
  return {
    worker: { agent: "codex", mode: "native_goal", model: "gpt-5.6-luna" },
    commands: ["test -f app.txt"],
    timeout_seconds: 10,
    gate_allowed_paths: ["app.txt"],
    required_clean_patterns: [],
    forbidden_paths: [],
    protected_paths: [],
    remote: "origin",
  };
}

async function seed() {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-auto-"));
  const bare = await mkdtemp(join(tmpdir(), "ralph-v3-auto-remote-"));
  git(root, ["init", "-q", "-b", "feature/auto-test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Ralph Test"]);
  await writeFile(join(root, ".gitignore"), ".ralph/\n");
  await writeFile(join(root, "app.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  git(bare, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", bare]);
  git(root, ["push", "-q", "-u", "origin", "feature/auto-test"]);
  const runId = `auto-${Math.random().toString(16).slice(2)}`;
  await saveProjectStateToProject(root, {
    version: 1,
    project_id: "auto-test",
    goal: "run one unattended task",
    status: "active",
    current_milestone: "m1",
    current_task_id: "task-1",
    tasks: [
      {
        id: "task-1",
        title: "change app",
        goal: "change the fixture",
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
  return { root, bare, runId };
}

function reviewDecision(message, action) {
  const field = (name) => message.match(new RegExp(`${name}: ([^\\n]+)`))?.[1];
  return {
    action,
    summary: `auto ${action}`,
    repo_reviewed: true,
    reviewed_repo: "acme/ralph",
    reviewed_base_sha: field("base_sha"),
    reviewed_head_sha: field("head_sha"),
    findings: [],
    patch_instructions: action === "PATCH" ? ["apply the narrow fix"] : [],
    human_question:
      action === "HUMAN_REQUIRED" ? "need a business decision" : "",
    human_options: action === "HUMAN_REQUIRED" ? ["A", "B"] : [],
    run_id: field("run_id"),
    round: Number(field("round")),
    handoff_hash: field("handoff_hash"),
    project_state_hash: field("project_state_hash"),
    checkpoint_hash: field("checkpoint_hash"),
    gate_artifact_hash: field("gate_artifact_hash"),
  };
}

async function reviewRunnerFor(sequence, calls) {
  return async ({ projectRoot, runId }) => {
    await bindFixtureCheckpointToGithub(projectRoot, runId);
    return runV3ReviewTransport({
      projectRoot,
      runId,
      resolveRemoteUrl: () => "https://github.com/acme/ralph.git",
      transport: async ({ message }) => {
        calls.push(message);
        const messageRound = Number(message.match(/round: (\d+)/)?.[1]);
        const action = sequence[messageRound - 1] ?? "PASS";
        return {
          reply: `${REVIEW_OPEN_MARKER}\n${JSON.stringify(reviewDecision(message, action))}\n${REVIEW_CLOSE_MARKER}`,
        };
      },
    });
  };
}

async function bindFixtureCheckpointToGithub(projectRoot, runId) {
  const runState = JSON.parse(
    await readFile(
      join(getChiefRunDir(projectRoot, runId), "RUN_STATE.json"),
      "utf8"
    )
  );
  const checkpointPath = join(
    getChiefRunDir(projectRoot, runId),
    "rounds",
    String(Number(runState.round)).padStart(3, "0"),
    "checkpoint.json"
  );
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  // The disposable fixture uses a local bare remote. Bind the persisted
  // checkpoint to the same GitHub identity as the injected effective URL.
  checkpoint.remote_url = "https://github.com/acme/ralph.git";
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

test("unattended Worker → Gate → Checkpoint → Review PASS finishes the task", async () => {
  const f = await seed();
  const goal = new FakeGoalTransport(f.root);
  const reviews = [];
  const result = await runV3UnattendedTask({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    goalTransport: goal,
    reviewRunner: await reviewRunnerFor(["PASS"], reviews),
  });
  assert.equal(result.status, "TASK_PASS");
  assert.equal(result.patchRounds, 0);
  assert.equal(result.runState.phase, "DONE");
  assert.equal(reviews.length, 1);
  assert.equal(
    goal.calls.filter(([method]) => method === "thread/start").length,
    1
  );
});

test("Review PATCH automatically returns the same task to a second Goal round", async () => {
  const f = await seed();
  const goal = new FakeGoalTransport(f.root);
  const reviews = [];
  const result = await runV3UnattendedTask({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    goalTransport: goal,
    reviewRunner: await reviewRunnerFor(["PATCH", "PASS"], reviews),
  });
  assert.equal(result.status, "TASK_PASS");
  assert.equal(result.patchRounds, 1);
  assert.equal(result.runState.phase, "DONE");
  assert.equal(reviews.length, 2);
  assert.equal(
    goal.calls.filter(([method]) => method === "thread/start").length,
    2
  );
});

test("Review HUMAN_REQUIRED stops without starting another Goal", async () => {
  const f = await seed();
  const goal = new FakeGoalTransport(f.root);
  const reviews = [];
  const result = await runV3UnattendedTask({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    goalTransport: goal,
    reviewRunner: await reviewRunnerFor(["HUMAN_REQUIRED"], reviews),
  });
  assert.equal(result.status, "HUMAN_REQUIRED");
  assert.equal(result.runState.phase, "HUMAN_REQUIRED");
  assert.equal(
    goal.calls.filter(([method]) => method === "thread/start").length,
    1
  );
});

test("External Chief failure preserves WAITING_FOR_CHIEF and resumes the same handoff", async () => {
  const f = await seed();
  const goal = new FakeGoalTransport(f.root);
  const first = await runV3UnattendedTask({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    goalTransport: goal,
    reviewRunner: async ({ projectRoot, runId }) => (
      await bindFixtureCheckpointToGithub(projectRoot, runId),
      runV3ReviewTransport({
        projectRoot,
        runId,
        resolveRemoteUrl: () => "https://github.com/acme/ralph.git",
        transport: async () => {
          throw new Error("External Chief unavailable");
        },
      })
    ),
  });
  assert.equal(first.status, "WAITING_FOR_CHIEF");
  assert.equal(first.runState.phase, "WAITING_FOR_CHIEF");
  const commitsAfterFirst = git(f.root, ["rev-list", "--count", "HEAD"]);
  const reviews = [];
  const second = await runV3UnattendedTask({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    goalTransport: goal,
    reviewRunner: await reviewRunnerFor(["PASS"], reviews),
  });
  assert.equal(second.status, "TASK_PASS");
  assert.equal(reviews.length, 1);
  assert.equal(
    goal.calls.filter(([method]) => method === "thread/start").length,
    1
  );
  assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), commitsAfterFirst);
});
