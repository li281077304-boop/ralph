import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getChiefRunDir,
  saveProjectStateToProject,
  saveRunState,
} from "../packages/core/dist/index.js";
import { runV3BigLoop } from "../apps/cli/bin/ralph-chief-v3-loop.js";
import {
  SELECT_CLOSE_MARKER,
  SELECT_OPEN_MARKER,
  runV3SelectTransport,
} from "../apps/cli/bin/ralph-chief-v3-select.js";
import {
  createV3CodexChiefTransport,
  runV3CodexChiefRoundtrip,
} from "../apps/cli/bin/ralph-chief-v3-codex.js";

const now = "2026-09-15T00:00:00.000Z";

function project() {
  return {
    version: 1,
    project_id: "codex-chief-test",
    goal: "prove Codex Chief transport",
    status: "active",
    current_milestone: "m1",
    current_task_id: null,
    tasks: [
      {
        id: "task-1",
        title: "real task",
        goal: "complete the real task",
        status: "queued",
        priority: 1,
        dependencies: [],
        acceptance: ["done"],
        verification: ["gate"],
        evidence: ["fixture"],
        source: "test",
        created_round: 1,
        updated_round: 1,
      },
    ],
    created_at: now,
    updated_at: now,
  };
}

function selectState(runId) {
  return {
    run_id: runId,
    version: 1,
    phase: "SELECT",
    status: "running",
    round: 1,
    current_task_id: null,
    started_at: now,
    updated_at: now,
  };
}

async function seed() {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-codex-chief-"));
  const runId = "codex-chief-test";
  await saveProjectStateToProject(root, project());
  await saveRunState(
    join(getChiefRunDir(root, runId), "RUN_STATE.json"),
    selectState(runId)
  );
  return { root, runId };
}

function validSelectReply(message) {
  const value = (label) =>
    message.match(new RegExp(`${label}: ([^\\n]+)`))?.[1];
  return `${SELECT_OPEN_MARKER}\n${JSON.stringify({
    action: "CONTINUE_DEVELOPMENT",
    selected_task_id: "task-1",
    why_now: "only ready task",
    evidence: ["task is ready"],
    why_not_other_ready_tasks: "none",
    reference_check: {
      decision: "REUSE",
      evidence: "existing implementation",
      why_build_if_needed: "",
    },
    human_question: "",
    human_options: [],
    uat_scope: "",
    run_id: value("run_id"),
    round: Number(value("round")),
    handoff_hash: value("handoff_hash"),
    project_state_hash: value("project_state_hash"),
  })}\n${SELECT_CLOSE_MARKER}`;
}

function fakeChild(lines, { exitCode = 0, close = true, onKill } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    onKill?.();
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  queueMicrotask(() => {
    if (lines) child.stdout.write(lines.join("\n") + "\n");
    child.stdout.end();
    child.stderr.end();
    if (close) child.emit("close", exitCode, null);
  });
  return child;
}

function completedEvents(reply) {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: reply },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ];
}

test("Codex Chief uses host exec flags, never Docker, and logs raw JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-codex-roundtrip-"));
  const calls = [];
  const result = await runV3CodexChiefRoundtrip({
    projectRoot: root,
    runId: "roundtrip-test",
    round: 2,
    chiefConfig: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    request: { message: "review this", runId: "roundtrip-test", round: 2 },
    binary: "/fake/codex",
    spawn: (binary, args, options) => {
      calls.push({ binary, args, options });
      return fakeChild(completedEvents("strict chief response"));
    },
  });
  assert.equal(result.reply, "strict chief response");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, "/fake/codex");
  assert.deepEqual(calls[0].args.slice(0, 8), [
    "--ask-for-approval",
    "never",
    "--sandbox",
    "read-only",
    "exec",
    "--json",
    "--ephemeral",
    "-C",
  ]);
  assert.equal(calls[0].args.includes("docker"), false);
  assert.equal(calls[0].args.includes(root), true);
  assert.equal(calls[0].args.includes("--model"), true);
  assert.equal(calls[0].args.includes("gpt-5.6-sol"), true);
  const logPath = join(
    getChiefRunDir(root, "roundtrip-test"),
    "rounds/002/codex-chief.ndjson"
  );
  assert.match(await readFile(logPath, "utf8"), /turn\.completed/);
});

test("Codex SELECT applies strict protocol without GUI and honors RALPH_CODEX_BIN", async () => {
  const fixture = await seed();
  let invocationCount = 0;
  const transport = createV3CodexChiefTransport({
    projectRoot: fixture.root,
    runId: fixture.runId,
    chiefConfig: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    logName: "codex-chief-select.ndjson",
    binary: "/fake/codex",
    spawn: (binary, args) => {
      invocationCount += 1;
      assert.equal(binary, "/fake/codex");
      assert.equal(args.includes("--sandbox"), true);
      return fakeChild(completedEvents(validSelectReply(args.at(-1))));
    },
  });
  const result = await runV3SelectTransport({
    projectRoot: fixture.root,
    runId: fixture.runId,
    transport,
  });
  assert.equal(invocationCount, 1);
  assert.equal(result.runState.phase, "WORKER");
  const logPath = join(
    getChiefRunDir(fixture.root, fixture.runId),
    "rounds/001/codex-chief-select.ndjson"
  );
  assert.match(await readFile(logPath, "utf8"), /turn\.completed/);
});

test("turn.failed fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-codex-failed-"));
  await assert.rejects(
    runV3CodexChiefRoundtrip({
      projectRoot: root,
      runId: "failed",
      round: 1,
      request: { message: "review" },
      spawn: () =>
        fakeChild([
          JSON.stringify({ type: "turn.failed", message: "provider down" }),
        ]),
    }),
    (error) => error.code === "CODEX_CHIEF_TURN_FAILED"
  );
});

test("non-zero exit and missing terminal events fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-codex-exit-"));
  await assert.rejects(
    runV3CodexChiefRoundtrip({
      projectRoot: root,
      runId: "exit",
      round: 1,
      request: { message: "review" },
      spawn: () => fakeChild([], { exitCode: 2 }),
    }),
    (error) => error.code === "CODEX_CHIEF_PROCESS_FAILED"
  );
  await assert.rejects(
    runV3CodexChiefRoundtrip({
      projectRoot: root,
      runId: "no-turn",
      round: 1,
      request: { message: "review" },
      spawn: () =>
        fakeChild([
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "reply" },
          }),
        ]),
    }),
    (error) => error.code === "CODEX_CHIEF_NO_TURN_COMPLETED"
  );
  await assert.rejects(
    runV3CodexChiefRoundtrip({
      projectRoot: root,
      runId: "no-message",
      round: 1,
      request: { message: "review" },
      spawn: () => fakeChild([JSON.stringify({ type: "turn.completed" })]),
    }),
    (error) => error.code === "CODEX_CHIEF_NO_FINAL_AGENT_MESSAGE"
  );
});

test("timeout kills the host Codex process", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-codex-timeout-"));
  let killed = false;
  await assert.rejects(
    runV3CodexChiefRoundtrip({
      projectRoot: root,
      runId: "timeout",
      round: 1,
      timeoutMs: 5,
      request: { message: "review" },
      spawn: () =>
        fakeChild(null, { close: false, onKill: () => (killed = true) }),
    }),
    (error) => error.code === "CODEX_CHIEF_TIMEOUT"
  );
  assert.equal(killed, true);
});

test("workspace mutation fails closed before a verdict can be applied", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-codex-mutation-"));
  const target = join(root, ".ralph", "foreign-state.json");
  await assert.rejects(
    runV3CodexChiefRoundtrip({
      projectRoot: root,
      runId: "mutation",
      round: 1,
      request: { message: "review" },
      spawn: () => {
        writeFileSync(target, "mutated\n");
        writeFileSync(target, "after\n");
        return fakeChild(completedEvents("reply"));
      },
    }).then(async (result) => {
      assert.equal(result.reply, "reply");
    }),
    (error) => error.code === "CODEX_CHIEF_MODIFIED_WORKSPACE"
  );
});

test("spawn ENOENT is classified as HOST_CODEX_NOT_FOUND", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-codex-missing-"));
  const spawnError = Object.assign(new Error("not found"), { code: "ENOENT" });
  await assert.rejects(
    runV3CodexChiefRoundtrip({
      projectRoot: root,
      runId: "missing",
      round: 1,
      request: { message: "review" },
      spawn: () => {
        const child = fakeChild(null, { close: false });
        queueMicrotask(() => child.emit("error", spawnError));
        queueMicrotask(() => child.emit("close", -1, null));
        return child;
      },
    }),
    (error) => error.code === "HOST_CODEX_NOT_FOUND"
  );
});

test("chief_mode=codex Big Loop starts without GUI configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-codex-loop-"));
  const runId = "codex-loop-done";
  await saveRunState(join(getChiefRunDir(root, runId), "RUN_STATE.json"), {
    run_id: runId,
    version: 1,
    phase: "DONE",
    status: "done",
    round: 1,
    current_task_id: null,
    started_at: now,
    updated_at: now,
  });
  const result = await runV3BigLoop({
    projectRoot: root,
    runId,
    config: { chief_mode: "codex", max_iterations: 3, timeout_seconds: 60 },
  });
  assert.equal(result.status, "TASK_PASS");
});
