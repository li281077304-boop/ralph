import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getChiefRunDir,
  hashProjectState,
  prepareSelectHandoff,
  saveProjectStateToProject,
  saveRunState,
} from "../packages/core/dist/index.js";
import {
  SELECT_CLOSE_MARKER,
  SELECT_OPEN_MARKER,
  runV3SelectTransport,
} from "../apps/cli/bin/ralph-chief-v3-select.js";

const now = "2026-09-13T00:00:00.000Z";
function project() {
  return {
    version: 1,
    project_id: "select-smoke",
    goal: "prove V3 SELECT transport",
    status: "active",
    current_milestone: "m1",
    current_task_id: null,
    tasks: [
      {
        id: "smoke-next-task",
        title: "V3 SELECT target",
        goal: "select a durable READY task",
        status: "queued",
        priority: 1,
        dependencies: [],
        acceptance: ["selected"],
        verification: ["transport smoke only"],
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
function run(runId) {
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
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-gui-select-"));
  const state = project();
  const runId = `run-${Math.random().toString(16).slice(2)}`;
  await saveProjectStateToProject(root, state);
  await saveRunState(
    join(getChiefRunDir(root, runId), "RUN_STATE.json"),
    run(runId)
  );
  return { root, runId, state };
}
function decisionFromPrompt(message, overrides = {}) {
  const value = (label) =>
    message.match(new RegExp(`${label}: ([^\\n]+)`))?.[1];
  return {
    action: "CONTINUE_DEVELOPMENT",
    selected_task_id: "smoke-next-task",
    why_now: "only ready task",
    evidence: ["fixture task is queued with no dependencies"],
    why_not_other_ready_tasks: "none",
    reference_check: {
      decision: "NOT_APPLICABLE",
      evidence: "transport test",
      why_build_if_needed: "",
    },
    human_question: "",
    human_options: [],
    uat_scope: "",
    run_id: value("run_id"),
    round: Number(value("round")),
    handoff_hash: value("handoff_hash"),
    project_state_hash: value("project_state_hash"),
    ...overrides,
  };
}
function validTransport(calls) {
  return async ({ message }) => {
    calls.count += 1;
    const decision = decisionFromPrompt(message);
    return {
      reply: `${SELECT_OPEN_MARKER}\n${JSON.stringify(decision)}\n${SELECT_CLOSE_MARKER}`,
    };
  };
}

test("V3 SELECT sends a dedicated prompt and transitions READY task to WORKER", async () => {
  const fixture = await seed();
  const calls = { count: 0 };
  const result = await runV3SelectTransport({
    projectRoot: fixture.root,
    runId: fixture.runId,
    transport: validTransport(calls),
  });
  assert.equal(result.runState.phase, "WORKER");
  assert.equal(result.projectState.tasks[0].status, "in_progress");
  assert.equal(calls.count, 1);
  assert.equal(result.guiCalls, 1);
  const roundDir = join(
    getChiefRunDir(fixture.root, fixture.runId),
    "rounds",
    "001"
  );
  assert.match(
    await readFile(join(roundDir, "select_decision.json"), "utf8"),
    /CONTINUE_DEVELOPMENT/
  );
  assert.match(
    await readFile(join(roundDir, "select_transition.json"), "utf8"),
    /decision_hash/
  );
});

test("waiting handoff is reused and accepted recovery skips GUI", async () => {
  const fixture = await seed();
  const calls = { count: 0 };
  await runV3SelectTransport({
    projectRoot: fixture.root,
    runId: fixture.runId,
    transport: validTransport(calls),
  });
  assert.equal(calls.count, 1);
  const recovered = await runV3SelectTransport({
    projectRoot: fixture.root,
    runId: fixture.runId,
    transport: async () => {
      throw new Error("GUI must not be called during recovery");
    },
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.guiCalls, 0);
});

test("an existing WAITING SELECT handoff is reused byte-for-byte", async () => {
  const fixture = await seed();
  const prepared = await prepareSelectHandoff(fixture.root, fixture.runId);
  const before = await readFile(prepared.handoff.path, "utf8");
  const calls = { count: 0 };
  await runV3SelectTransport({
    projectRoot: fixture.root,
    runId: fixture.runId,
    transport: validTransport(calls),
  });
  assert.equal(calls.count, 1);
  assert.equal(await readFile(prepared.handoff.path, "utf8"), before);
  assert.equal(prepared.handoff.handoff_hash.length, 64);
});

test("GUI and protocol failures preserve WAITING_FOR_CHIEF", async () => {
  for (const mode of [
    "timeout",
    "malformed",
    "invalid",
    "wrong-handoff",
    "wrong-project",
  ]) {
    const fixture = await seed();
    await assert.rejects(
      runV3SelectTransport({
        projectRoot: fixture.root,
        runId: fixture.runId,
        transport: async ({ message }) => {
          if (mode === "timeout") throw new Error("ASSISTANT_REPLY_TIMEOUT");
          if (mode === "malformed") return { reply: "no marker" };
          const overrides =
            mode === "wrong-handoff"
              ? { handoff_hash: "0".repeat(64) }
              : mode === "wrong-project"
                ? { project_state_hash: "0".repeat(64) }
                : { action: "CONTINUE_DEVELOPMENT", selected_task_id: null };
          return {
            reply: `${SELECT_OPEN_MARKER}\n${JSON.stringify(decisionFromPrompt(message, overrides))}\n${SELECT_CLOSE_MARKER}`,
          };
        },
      })
    );
    const persisted = JSON.parse(
      await readFile(
        join(getChiefRunDir(fixture.root, fixture.runId), "RUN_STATE.json"),
        "utf8"
      )
    );
    assert.equal(persisted.phase, "WAITING_FOR_CHIEF");
    assert.equal(persisted.waiting_handoff.kind, "select");
  }
});

test("V3 SELECT prompt binds the authoritative project hash", async () => {
  const fixture = await seed();
  const calls = { count: 0 };
  await assert.rejects(
    runV3SelectTransport({
      projectRoot: fixture.root,
      runId: fixture.runId,
      transport: async ({ message }) => {
        calls.count += 1;
        const decision = decisionFromPrompt(message, {
          project_state_hash: hashProjectState({
            ...fixture.state,
            goal: "changed",
          }),
        });
        return {
          reply: `${SELECT_OPEN_MARKER}\n${JSON.stringify(decision)}\n${SELECT_CLOSE_MARKER}`,
        };
      },
    })
  );
  assert.equal(calls.count, 1);
});
