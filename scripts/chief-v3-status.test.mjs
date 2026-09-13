import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getChiefRunDir,
  readV3Status,
  saveProjectStateToProject,
  saveRunState,
} from "../packages/core/dist/index.js";

const now = "2026-09-13T00:00:00.000Z";
async function fixture(runPatch = {}) {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-status-"));
  await saveProjectStateToProject(root, {
    version: 1,
    project_id: "status-fixture",
    goal: "inspect",
    status: "active",
    current_milestone: "m1",
    current_task_id: runPatch.current_task_id ?? null,
    tasks: [
      {
        id: "ready-task",
        title: "Ready",
        goal: "ready",
        status: "queued",
        priority: 1,
        dependencies: [],
        acceptance: ["ok"],
        verification: ["none"],
        evidence: [],
        source: "test",
        created_round: 1,
        updated_round: 1,
      },
      {
        id: "active-task",
        title: "Active",
        goal: "active",
        status:
          runPatch.current_task_id === "active-task" ? "in_progress" : "queued",
        priority: 2,
        dependencies: [],
        acceptance: ["ok"],
        verification: ["none"],
        evidence: [],
        source: "test",
        created_round: 1,
        updated_round: 1,
      },
    ],
    created_at: now,
    updated_at: now,
  });
  const runId = "status-run";
  await saveRunState(join(getChiefRunDir(root, runId), "RUN_STATE.json"), {
    run_id: runId,
    version: 1,
    phase: runPatch.phase ?? "SELECT",
    status: runPatch.status ?? "running",
    round: 1,
    current_task_id: runPatch.current_task_id ?? null,
    ...(runPatch.waiting_handoff
      ? { waiting_handoff: runPatch.waiting_handoff }
      : {}),
    ...(runPatch.head_evidence
      ? { head_evidence: runPatch.head_evidence }
      : {}),
    started_at: now,
    updated_at: now,
  });
  return { root, runId };
}

test("valid SELECT state projects strict status JSON", async () => {
  const f = await fixture({ head_evidence: { base: "a", head: "b" } });
  const before = await readFile(
    join(f.root, ".ralph/chief/PROJECT_STATE.json")
  );
  const status = await readV3Status(f.root, f.runId);
  assert.deepEqual(status, {
    project_id: "status-fixture",
    project_status: "active",
    milestone: "m1",
    run_id: "status-run",
    round: 1,
    phase: "SELECT",
    run_status: "running",
    current_task_id: null,
    ready_task_ids: ["ready-task", "active-task"],
    waiting_kind: null,
    base_sha: "a",
    head_sha: "b",
  });
  assert.equal(
    (
      await readFile(join(f.root, ".ralph/chief/PROJECT_STATE.json"))
    ).toString(),
    before.toString()
  );
});

test("active Worker and waiting handoff are exposed", async () => {
  const f = await fixture({
    phase: "WAITING_FOR_CHIEF",
    status: "waiting",
    current_task_id: "active-task",
    waiting_handoff: {
      kind: "review",
      run_id: "status-run",
      round: 1,
      handoff_path: ".ralph/chief-runs/status-run/rounds/001/review_handoff.md",
      handoff_hash: "a".repeat(64),
      handoff_content_hash: "b".repeat(64),
      project_state_hash: "c".repeat(64),
      checkpoint_hash: "d".repeat(64),
      gate_artifact_hash: "e".repeat(64),
      created_at: now,
    },
  });
  const status = await readV3Status(f.root, f.runId);
  assert.equal(status.current_task_id, "active-task");
  assert.deepEqual(status.ready_task_ids, ["ready-task"]);
  assert.equal(status.waiting_kind, "review");
});

test("malformed durable state fails closed", async () => {
  const f = await fixture();
  const path = join(f.root, ".ralph/chief/PROJECT_STATE.json");
  const original = await readFile(path, "utf8");
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(path, "{}\n")
  );
  await assert.rejects(readV3Status(f.root, f.runId));
  await stat(f.root);
  assert.notEqual(original, "{}\n");
});
