import { join } from "node:path";

import { getChiefRunDir } from "./rounds.js";
import { loadProjectStateFromProject, getReadyTasks } from "./project-plan.js";
import {
  loadRunState,
  type ProjectState,
  type RunState,
  type WaitingHandoff,
} from "./state.js";

export interface V3Status {
  project_id: string;
  project_status: ProjectState["status"];
  milestone: string;
  run_id: string;
  round: number;
  phase: RunState["phase"];
  run_status: RunState["status"];
  current_task_id: string | null;
  ready_task_ids: string[];
  waiting_kind: WaitingHandoff["kind"] | null;
  base_sha: string | null;
  head_sha: string | null;
}

function assertConsistentState(
  project: ProjectState,
  run: RunState,
  requestedRunId: string
): void {
  if (run.run_id !== requestedRunId)
    throw new Error(
      "Invalid durable state: RUN_STATE.run_id does not match --run-id"
    );
  if (run.current_task_id !== project.current_task_id)
    throw new Error(
      "Invalid durable state: project and run current_task_id values do not match"
    );
  if (
    run.waiting_handoff &&
    (run.waiting_handoff.run_id !== run.run_id ||
      run.waiting_handoff.round !== run.round)
  )
    throw new Error(
      "Invalid durable state: waiting_handoff does not match RUN_STATE"
    );
}

export async function inspectV3Status(
  projectRoot: string,
  runId: string
): Promise<V3Status> {
  const project = await loadProjectStateFromProject(projectRoot);
  const run = await loadRunState(
    join(getChiefRunDir(projectRoot, runId), "RUN_STATE.json")
  );
  assertConsistentState(project, run, runId);

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
