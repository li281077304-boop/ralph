import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySelectDecision,
  getReadyTasks,
  hashProjectState,
  prepareSelectHandoff,
  renderProjectPlan,
  saveProjectStateToProject,
  projectPlanPath,
  projectStatePath,
  parseChiefSelectDecision,
  validateChiefSelectDecision,
  type ChiefSelectDecision,
  type ProjectState,
  type RunState,
} from "../index.js";

const now = "2026-09-13T00:00:00.000Z";
function task(
  id: string,
  status: ProjectState["tasks"][number]["status"] = "queued",
  dependencies: string[] = []
) {
  return {
    id,
    title: `Task ${id}`,
    goal: `Deliver ${id}`,
    status,
    priority: 1,
    dependencies,
    acceptance: ["tests pass"],
    verification: ["pnpm test"],
    evidence: ["repo"],
    source: "user",
    created_round: 1,
    updated_round: 1,
  };
}
function project(tasks = [task("a")]): ProjectState {
  return {
    version: 1,
    project_id: "project",
    goal: "ship",
    status: "active",
    current_milestone: "m1",
    current_task_id: null,
    tasks,
    created_at: now,
    updated_at: now,
  };
}
function run(runId = "run-1"): RunState {
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
function decision(
  overrides: Partial<ChiefSelectDecision> = {}
): ChiefSelectDecision {
  return {
    action: "CONTINUE_DEVELOPMENT",
    selected_task_id: "a",
    why_now: "highest value",
    evidence: ["ready"],
    why_not_other_ready_tasks: "none",
    reference_check: {
      decision: "REUSE",
      evidence: "existing pattern",
      why_build_if_needed: "",
    },
    human_question: "",
    human_options: [],
    uat_scope: "",
    run_id: "run-1",
    round: 1,
    handoff_hash: "",
    project_state_hash: "",
    ...overrides,
  };
}

describe("Chief V3 SELECT and project plan", () => {
  it("derives READY only from queued tasks with done dependencies", () => {
    const state = project([
      task("independent"),
      task("done-dep", "done"),
      task("unlocked", "queued", ["done-dep"]),
      task("queued-dep", "queued", ["independent"]),
      task("blocked-dep", "queued", ["blocked"]),
      task("blocked", "blocked"),
      task("working", "in_progress"),
      task("finished", "done"),
      task("cancelled", "cancelled"),
    ]);
    expect(getReadyTasks(state).map((item) => item.id)).toEqual([
      "independent",
      "unlocked",
    ]);
  });

  it("strictly parses action schema and rejects unknown/invalid combinations", () => {
    expect(() =>
      parseChiefSelectDecision({ ...decision(), unknown: true })
    ).toThrow(/unknown/);
    expect(() =>
      parseChiefSelectDecision({ ...decision(), action: "NOPE" })
    ).toThrow(/action/);
    const state = project();
    expect(() =>
      validateChiefSelectDecision(
        decision({
          action: "CONTINUE_DEVELOPMENT",
          selected_task_id: "missing",
        }),
        state
      )
    ).toThrow(/READY/);
    expect(() =>
      validateChiefSelectDecision(
        decision({ action: "CONTINUE_DEVELOPMENT", selected_task_id: null }),
        state
      )
    ).toThrow(/selected_task_id/);
    expect(() =>
      validateChiefSelectDecision(
        decision({
          action: "RUN_INTEGRATION_UAT",
          selected_task_id: null,
          uat_scope: "",
        }),
        state
      )
    ).toThrow(/uat_scope/);
    expect(() =>
      validateChiefSelectDecision(
        decision({
          action: "HUMAN_REQUIRED",
          selected_task_id: null,
          human_question: "",
        }),
        state
      )
    ).toThrow(/human_question/);
    expect(() =>
      validateChiefSelectDecision(
        decision({
          reference_check: {
            decision: "BUILD",
            evidence: "",
            why_build_if_needed: "",
          },
        }),
        state
      )
    ).toThrow(/why_build/);
  });

  it("creates self-contained handoff and applies CONTINUE without free-form worker task", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-v3-select-"));
    const state = project();
    const preparedState = await prepareSelectHandoff(root, run(), state);
    expect(preparedState.runState.phase).toBe("WAITING_FOR_CHIEF");
    expect(preparedState.runState.waiting_handoff?.kind).toBe("select");
    const text = await readFile(preparedState.handoff.path, "utf8");
    expect(text).toContain("Task a");
    const applied = await applySelectDecision(
      root,
      preparedState.runState,
      state,
      decision({
        handoff_hash: preparedState.handoff.handoff_hash,
        project_state_hash: hashProjectState(state),
      })
    );
    expect(applied.runState.phase).toBe("WORKER");
    expect(applied.runState.current_task_id).toBe("a");
    expect(applied.projectState.tasks[0].status).toBe("in_progress");
    await expect(
      applySelectDecision(
        root,
        preparedState.runState,
        state,
        decision({
          handoff_hash: preparedState.handoff.handoff_hash,
          project_state_hash: hashProjectState(state),
        })
      )
    ).rejects.toThrow(/consumed/);
  });

  it("rejects stale project state and identity mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-v3-select-stale-"));
    const state = project();
    const preparedState = await prepareSelectHandoff(root, run(), state);
    const valid = decision({
      handoff_hash: preparedState.handoff.handoff_hash,
      project_state_hash: preparedState.handoff.project_state_hash,
    });
    const changed = { ...state, goal: "changed" };
    await expect(
      applySelectDecision(root, preparedState.runState, changed, valid)
    ).rejects.toThrow(/project_state_hash/);
    await expect(
      applySelectDecision(root, preparedState.runState, state, {
        ...valid,
        run_id: "other",
      })
    ).rejects.toThrow(/identity/);
    await expect(
      applySelectDecision(root, preparedState.runState, state, {
        ...valid,
        round: 2,
      })
    ).rejects.toThrow(/identity/);
    await expect(
      applySelectDecision(root, preparedState.runState, state, {
        ...valid,
        handoff_hash: "wrong",
      })
    ).rejects.toThrow(/handoff_hash/);
  });

  it("transitions each non-worker action without marking DONE", async () => {
    for (const [action, expectedPhase, extra] of [
      [
        "RUN_INTEGRATION_UAT",
        "INTEGRATION_UAT",
        { selected_task_id: null, uat_scope: "smoke" },
      ],
      [
        "HUMAN_REQUIRED",
        "HUMAN_REQUIRED",
        { selected_task_id: null, human_question: "policy?" },
      ],
      ["REQUEST_FINAL_REVIEW", "FINAL_REVIEW", { selected_task_id: null }],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "ralph-v3-select-transition-"));
      const state = project();
      const preparedState = await prepareSelectHandoff(
        root,
        run(action),
        state
      );
      const valid = decision({
        ...extra,
        action,
        run_id: action,
        handoff_hash: preparedState.handoff.handoff_hash,
        project_state_hash: preparedState.handoff.project_state_hash,
      });
      const applied = await applySelectDecision(
        root,
        preparedState.runState,
        state,
        valid
      );
      expect(applied.runState.phase).toBe(expectedPhase);
      expect(applied.runState.phase).not.toBe("DONE");
    }
  });

  it("renders a deterministic derived plan", () => {
    const state = project([task("b", "done"), task("a")]);
    expect(renderProjectPlan(state)).toBe(
      renderProjectPlan(JSON.parse(JSON.stringify(state)) as ProjectState)
    );
    expect(renderProjectPlan(state)).toContain("## READY");
    expect(renderProjectPlan(state)).toContain("## DONE");
  });

  it("persists PROJECT_STATE as authority and writes the derived markdown view", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-v3-plan-"));
    const state = project();
    await saveProjectStateToProject(root, state);
    expect(await readFile(projectStatePath(root), "utf8")).toContain(
      '"project_id": "project"'
    );
    expect(await readFile(projectPlanPath(root), "utf8")).toContain(
      "# Project Plan"
    );
  });
});
