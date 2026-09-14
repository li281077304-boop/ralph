import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getChiefRunDir,
  loadRunState,
  runIntegrationUatPhase,
  saveProjectStateToProject,
  saveRunState,
} from "../packages/core/dist/index.js";

const now = "2026-09-13T00:00:00.000Z";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-uat-"));
  const runId = "uat-test";
  await saveProjectStateToProject(root, {
    version: 1,
    project_id: "uat-project",
    goal: "test UAT",
    status: "active",
    current_milestone: "m1",
    current_task_id: "task-1",
    tasks: [
      {
        id: "task-1",
        title: "task",
        goal: "goal",
        status: "in_progress",
        priority: 1,
        dependencies: [],
        acceptance: ["ok"],
        verification: ["test"],
        evidence: [],
        source: "test",
        created_round: 1,
        updated_round: 1,
      },
    ],
    created_at: now,
    updated_at: now,
  });
  await saveRunState(join(getChiefRunDir(root, runId), "RUN_STATE.json"), {
    run_id: runId,
    version: 1,
    phase: "INTEGRATION_UAT",
    status: "running",
    round: 1,
    current_task_id: "task-1",
    started_at: now,
    updated_at: now,
  });
  return { root, runId };
}

test("UAT PASS routes to FINAL_REVIEW and persists evidence", async () => {
  const f = await fixture();
  const result = await runIntegrationUatPhase({
    projectRoot: f.root,
    runId: f.runId,
    runUat: async () => ({ action: "PASS", findings: [] }),
  });
  assert.equal(result.runState.phase, "FINAL_REVIEW");
  assert.equal(
    JSON.parse(
      await readFile(
        join(getChiefRunDir(f.root, f.runId), "rounds/001/integration_uat.json")
      )
    ).action,
    "PASS"
  );
});

test("UAT PATCH returns the same task to WORKER with durable findings", async () => {
  const f = await fixture();
  const result = await runIntegrationUatPhase({
    projectRoot: f.root,
    runId: f.runId,
    runUat: async () => ({ action: "PATCH", findings: ["fix x"] }),
  });
  assert.equal(result.runState.phase, "WORKER");
  assert.equal(result.runState.round, 2);
  const artifact = JSON.parse(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "rounds/001/integration_uat.json")
    )
  );
  assert.deepEqual(artifact.findings, ["fix x"]);
});

test("UAT HUMAN_REQUIRED pauses and technical failure is FAILED", async () => {
  const human = await fixture();
  const humanResult = await runIntegrationUatPhase({
    projectRoot: human.root,
    runId: human.runId,
    runUat: async () => ({
      action: "HUMAN_REQUIRED",
      human_question: "choose policy",
    }),
  });
  assert.equal(humanResult.runState.phase, "HUMAN_REQUIRED");
  const failed = await fixture();
  const failedResult = await runIntegrationUatPhase({
    projectRoot: failed.root,
    runId: failed.runId,
    runUat: async () => ({ action: "FAILED", reason: "port unavailable" }),
  });
  assert.equal(failedResult.runState.phase, "FAILED");
});

test("UAT recovery reuses completed artifact without rerunning commands", async () => {
  const f = await fixture();
  let calls = 0;
  await runIntegrationUatPhase({
    projectRoot: f.root,
    runId: f.runId,
    runUat: async () => {
      calls += 1;
      return { action: "PASS" };
    },
  });
  // Crash before the caller observes the transition; restore the durable UAT phase.
  await saveRunState(join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json"), {
    ...(await loadRunState(
      join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json")
    )),
    phase: "INTEGRATION_UAT",
    status: "running",
  });
  await runIntegrationUatPhase({
    projectRoot: f.root,
    runId: f.runId,
    runUat: async () => {
      calls += 1;
      return { action: "FAILED" };
    },
  });
  assert.equal(calls, 1);
});
