import { getReadyTasks, loadProjectStateFromProject } from "./project-plan.js";
import { getChiefRunDir } from "./rounds.js";
import { assertRunState } from "./state-invariants.js";
import { loadRunState } from "./state.js";
import { join } from "node:path";

export interface V3StatusSnapshot {
  project_id: string;
  project_status: string;
  milestone: string;
  run_id: string;
  round: number;
  phase: string;
  run_status: string;
  current_task_id: string | null;
  ready_task_ids: string[];
  waiting_kind: string | null;
  base_sha: string | null;
  head_sha: string | null;
}

function runStatePath(projectRoot: string, runId: string): string {
  return join(getChiefRunDir(projectRoot, runId), "RUN_STATE.json");
}

/** Read-only, strict V3 durable status projection. */
export async function readV3Status(
  projectRoot: string,
  runId: string
): Promise<V3StatusSnapshot> {
  const project = await loadProjectStateFromProject(projectRoot);
  const run = await loadRunState(runStatePath(projectRoot, runId));
  assertRunState(run);
  if (run.run_id !== runId) throw new Error("RUN_STATE run_id does not match");
  return {
    project_id: project.project_id,
    project_status: project.status,
    milestone: project.current_milestone,
    run_id: run.run_id,
    round: run.round,
    phase: run.phase,
    run_status: run.status,
    current_task_id: run.current_task_id,
    ready_task_ids: getReadyTasks(project).map((task) => task.id),
    waiting_kind: run.waiting_handoff?.kind ?? null,
    base_sha: run.head_evidence?.base ?? null,
    head_sha: run.head_evidence?.head ?? null,
  };
}
