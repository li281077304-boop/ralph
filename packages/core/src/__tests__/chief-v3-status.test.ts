import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  getChiefRunDir,
  inspectV3Status,
  saveProjectStateToProject,
  saveRunState,
  type ProjectState,
  type RunState,
} from "../index.js";

const timestamp = "2026-09-13T00:00:00.000Z";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function project(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    version: 1,
    project_id: "project-1",
    goal: "inspect status",
    status: "active",
    current_milestone: "milestone-1",
    current_task_id: null,
    tasks: [
      {
        id: "ready-1",
        title: "ready task",
        goal: "do ready work",
        status: "queued",
        priority: 2,
        dependencies: [],
        acceptance: ["done"],
        verification: ["test"],
        evidence: [],
        source: "test",
        created_round: 1,
        updated_round: 1,
      },
      {
        id: "blocked-1",
        title: "blocked task",
        goal: "wait for ready task",
        status: "queued",
        priority: 1,
        dependencies: ["ready-1"],
        acceptance: ["done"],
        verification: ["test"],
        evidence: [],
        source: "test",
        created_round: 1,
        updated_round: 1,
      },
    ],
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function run(runId: string, overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: runId,
    version: 1,
    phase: "SELECT",
    status: "running",
    round: 1,
    current_task_id: null,
    started_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

async function fixture(
  projectState: ProjectState,
  runState: RunState,
  runId = runState.run_id
) {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-status-"));
  await saveProjectStateToProject(root, projectState);
  await saveRunState(
    join(getChiefRunDir(root, runId), "RUN_STATE.json"),
    runState
  );
  return root;
}

describe("V3 status inspector", () => {
  it("reports valid SELECT state with only the required fields", async () => {
    const root = await fixture(project(), run("run-select"));

    await expect(inspectV3Status(root, "run-select")).resolves.toEqual({
      project_id: "project-1",
      project_status: "active",
      milestone: "milestone-1",
      run_id: "run-select",
      round: 1,
      phase: "SELECT",
      run_status: "running",
      current_task_id: null,
      ready_task_ids: ["ready-1"],
      waiting_kind: null,
      base_sha: null,
      head_sha: null,
    });
  });

  it("reports an active WORKER task and head evidence", async () => {
    const root = await fixture(
      project({
        current_task_id: "ready-1",
        tasks: project().tasks.map((task) =>
          task.id === "ready-1" ? { ...task, status: "in_progress" } : task
        ),
      }),
      run("run-worker", {
        phase: "WORKER",
        current_task_id: "ready-1",
        head_evidence: { base: baseSha, head: headSha },
      })
    );

    await expect(inspectV3Status(root, "run-worker")).resolves.toMatchObject({
      run_id: "run-worker",
      phase: "WORKER",
      current_task_id: "ready-1",
      ready_task_ids: [],
      base_sha: baseSha,
      head_sha: headSha,
    });
  });

  it("reports WAITING_FOR_CHIEF waiting_kind", async () => {
    const root = await fixture(
      project(),
      run("run-waiting", {
        phase: "WAITING_FOR_CHIEF",
        status: "waiting",
        waiting_handoff: {
          kind: "select",
          run_id: "run-waiting",
          round: 1,
          handoff_path: "/tmp/select_handoff.md",
          handoff_hash: "c".repeat(64),
          project_state_hash: "d".repeat(64),
          created_at: timestamp,
        },
      })
    );

    await expect(inspectV3Status(root, "run-waiting")).resolves.toMatchObject({
      phase: "WAITING_FOR_CHIEF",
      run_status: "waiting",
      waiting_kind: "select",
    });
  });

  it("fails closed on malformed durable state", async () => {
    const root = await fixture(project(), run("run-malformed"));
    const path = join(getChiefRunDir(root, "run-malformed"), "RUN_STATE.json");
    await writeFile(path, '{"version":1,"phase":"SELECT"}\n', "utf8");

    await expect(inspectV3Status(root, "run-malformed")).rejects.toThrow(
      /Invalid durable state/
    );
  });

  it("does not change durable files", async () => {
    const root = await fixture(project(), run("run-read-only"));
    const projectPath = join(root, ".ralph/chief/PROJECT_STATE.json");
    const runPath = join(
      getChiefRunDir(root, "run-read-only"),
      "RUN_STATE.json"
    );
    const before = [await readFile(projectPath), await readFile(runPath)];

    await inspectV3Status(root, "run-read-only");

    expect(await readFile(projectPath)).toEqual(before[0]);
    expect(await readFile(runPath)).toEqual(before[1]);
  });
});
