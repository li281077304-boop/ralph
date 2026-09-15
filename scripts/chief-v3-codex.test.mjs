import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("Codex Chief uses a fresh read-only, socket-free runStage and logs raw output", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-codex-roundtrip-"));
  const calls = [];
  const result = await runV3CodexChiefRoundtrip({
    projectRoot: root,
    runId: "roundtrip-test",
    round: 2,
    chiefConfig: {
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    },
    request: { message: "review this", runId: "roundtrip-test", round: 2 },
    runStage: async (...args) => {
      calls.push(args);
      return { text: "strict chief response", meta: { inputTokens: 7 } };
    },
  });
  assert.equal(result.reply, "strict chief response");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].agent, "codex");
  assert.equal(calls[0][0].model, "gpt-5.6-sol");
  assert.equal(calls[0][0].reasoningEffort, "high");
  assert.equal(calls[0][6].readOnlyWorkspace, true);
  assert.equal(calls[0][6].dockerSocket, "off");
  assert.equal(calls[0][6].codexUserConfig, false);
  assert.match(result.chief_log_path, /codex-chief\.ndjson$/);
});

test("Codex SELECT applies the strict existing decision protocol without GUI", async () => {
  const fixture = await seed();
  let invocationCount = 0;
  const transport = createV3CodexChiefTransport({
    projectRoot: fixture.root,
    runId: fixture.runId,
    chiefConfig: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    logName: "codex-chief-select.ndjson",
    runStage: async (_stage, message, _root, _round, _spill, logPath) => {
      invocationCount += 1;
      await writeFile(logPath, '{"type":"turn.completed"}\n');
      return { text: validSelectReply(message), meta: {} };
    },
  });
  const result = await runV3SelectTransport({
    projectRoot: fixture.root,
    runId: fixture.runId,
    transport,
  });
  assert.equal(invocationCount, 1);
  assert.equal(result.runState.phase, "WORKER");
  assert.equal(result.guiCalls, 1);
  const logPath = join(
    getChiefRunDir(fixture.root, fixture.runId),
    "rounds/001/codex-chief-select.ndjson"
  );
  assert.match(await readFile(logPath, "utf8"), /turn\.completed/);
});

test("malformed Codex Chief output fails closed through SELECT parsing", async () => {
  const fixture = await seed();
  const transport = createV3CodexChiefTransport({
    projectRoot: fixture.root,
    runId: fixture.runId,
    runStage: async () => ({ text: "not strict JSON", meta: {} }),
  });
  await assert.rejects(
    runV3SelectTransport({
      projectRoot: fixture.root,
      runId: fixture.runId,
      transport,
    })
  );
  const state = JSON.parse(
    await readFile(
      join(getChiefRunDir(fixture.root, fixture.runId), "RUN_STATE.json"),
      "utf8"
    )
  );
  assert.equal(state.phase, "WAITING_FOR_CHIEF");
  assert.equal(state.waiting_handoff.kind, "select");
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
    config: {
      chief_mode: "codex",
      max_iterations: 3,
      timeout_seconds: 60,
    },
  });
  assert.equal(result.status, "TASK_PASS");
});
