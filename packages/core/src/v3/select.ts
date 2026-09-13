import { createHash } from "node:crypto";
import { access, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "./atomic-json.js";
import { assertRunState, assertProjectState } from "./state-invariants.js";
import { getChiefRunDir, getRoundDir } from "./rounds.js";
import {
  canonicalizeValue,
  getReadyTasks,
  hashProjectState,
} from "./project-plan.js";
import { saveProjectStateToProject } from "./project-plan.js";
import {
  saveRunState,
  type ProjectState,
  type RunState,
  type ProjectTask,
} from "./state.js";

export const SELECT_HANDOFF_KIND = "select" as const;
export type SelectAction =
  | "CONTINUE_DEVELOPMENT"
  | "RUN_INTEGRATION_UAT"
  | "HUMAN_REQUIRED"
  | "REQUEST_FINAL_REVIEW";
export type ReferenceDecision = "REUSE" | "ADAPT" | "BUILD" | "NOT_APPLICABLE";

export interface ReferenceCheck {
  decision: ReferenceDecision;
  evidence: string;
  why_build_if_needed: string;
}

export interface ChiefSelectDecision {
  action: SelectAction;
  selected_task_id: string | null;
  why_now: string;
  evidence: string[];
  why_not_other_ready_tasks: string;
  reference_check: ReferenceCheck;
  human_question: string;
  human_options: string[];
  uat_scope: string;
  run_id: string;
  round: number;
  handoff_hash: string;
  project_state_hash: string;
}

export interface SelectHandoff {
  kind: typeof SELECT_HANDOFF_KIND;
  run_id: string;
  round: number;
  handoff_hash: string;
  project_state_hash: string;
  path: string;
  content: string;
}

export interface SelectPreparation {
  runState: RunState;
  handoff: SelectHandoff;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message: string): never {
  throw new Error(`Invalid Chief SELECT decision: ${message}`);
}
function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    fail(`${field} must be a non-empty string`);
}
function stringValue(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") fail(`${field} must be a string`);
}
function nullableString(
  value: unknown,
  field: string
): asserts value is string | null {
  if (value !== null && typeof value !== "string")
    fail(`${field} must be a string or null`);
}
function stringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    fail(`${field} must be an array of strings`);
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(`${label}.${key} is unknown`);
}

export function parseChiefSelectDecision(value: unknown): ChiefSelectDecision {
  if (!record(value)) fail("decision must be an object");
  exactKeys(
    value,
    [
      "action",
      "selected_task_id",
      "why_now",
      "evidence",
      "why_not_other_ready_tasks",
      "reference_check",
      "human_question",
      "human_options",
      "uat_scope",
      "run_id",
      "round",
      "handoff_hash",
      "project_state_hash",
    ],
    "decision"
  );
  const actions = [
    "CONTINUE_DEVELOPMENT",
    "RUN_INTEGRATION_UAT",
    "HUMAN_REQUIRED",
    "REQUEST_FINAL_REVIEW",
  ];
  if (typeof value.action !== "string" || !actions.includes(value.action))
    fail("action is unknown");
  nullableString(value.selected_task_id, "selected_task_id");
  nonEmpty(value.why_now, "why_now");
  stringArray(value.evidence, "evidence");
  nonEmpty(value.why_not_other_ready_tasks, "why_not_other_ready_tasks");
  if (!record(value.reference_check)) fail("reference_check must be an object");
  exactKeys(
    value.reference_check,
    ["decision", "evidence", "why_build_if_needed"],
    "reference_check"
  );
  if (
    typeof value.reference_check.decision !== "string" ||
    !["REUSE", "ADAPT", "BUILD", "NOT_APPLICABLE"].includes(
      value.reference_check.decision
    )
  )
    fail("reference_check.decision is unknown");
  stringValue(value.reference_check.evidence, "reference_check.evidence");
  stringValue(
    value.reference_check.why_build_if_needed,
    "reference_check.why_build_if_needed"
  );
  stringValue(value.human_question, "human_question");
  stringArray(value.human_options, "human_options");
  stringValue(value.uat_scope, "uat_scope");
  nonEmpty(value.run_id, "run_id");
  if (
    typeof value.round !== "number" ||
    !Number.isInteger(value.round) ||
    value.round < 1
  )
    fail("round must be a positive integer");
  nonEmpty(value.handoff_hash, "handoff_hash");
  nonEmpty(value.project_state_hash, "project_state_hash");
  return value as unknown as ChiefSelectDecision;
}

export function validateChiefSelectDecision(
  decision: ChiefSelectDecision,
  projectState: ProjectState
): void {
  assertProjectState(projectState);
  const ready = getReadyTasks(projectState);
  if (
    decision.reference_check.decision === "BUILD" &&
    decision.reference_check.why_build_if_needed.length === 0
  )
    fail("BUILD requires why_build_if_needed");
  if (
    decision.reference_check.decision !== "BUILD" &&
    decision.reference_check.evidence.length === 0 &&
    decision.reference_check.decision !== "NOT_APPLICABLE"
  )
    fail("reference decision requires evidence");
  switch (decision.action) {
    case "CONTINUE_DEVELOPMENT":
      if (decision.selected_task_id === null)
        fail("CONTINUE_DEVELOPMENT requires selected_task_id");
      if (!ready.some((task) => task.id === decision.selected_task_id))
        fail("selected task is not READY");
      if (decision.human_question !== "")
        fail("CONTINUE_DEVELOPMENT cannot include human_question");
      if (decision.uat_scope !== "")
        fail("CONTINUE_DEVELOPMENT cannot include uat_scope");
      break;
    case "RUN_INTEGRATION_UAT":
      if (decision.selected_task_id !== null)
        fail("RUN_INTEGRATION_UAT cannot select a task");
      if (decision.uat_scope.length === 0)
        fail("RUN_INTEGRATION_UAT requires uat_scope");
      break;
    case "HUMAN_REQUIRED":
      if (decision.selected_task_id !== null)
        fail("HUMAN_REQUIRED cannot select a task");
      if (decision.human_question.length === 0)
        fail("HUMAN_REQUIRED requires human_question");
      break;
    case "REQUEST_FINAL_REVIEW":
      if (decision.selected_task_id !== null)
        fail("REQUEST_FINAL_REVIEW cannot select a task");
      break;
  }
}

function taskSummary(task: ProjectTask): string {
  return [
    `- ${task.id}: ${task.title} (priority ${task.priority})`,
    `  goal: ${task.goal}`,
    `  dependencies: ${task.dependencies.length ? task.dependencies.join(", ") : "none"}`,
    `  verification: ${task.verification.join("; ") || "none"}`,
    `  acceptance: ${task.acceptance.join("; ") || "none"}`,
    `  evidence: ${task.evidence.join("; ") || "none"}`,
    `  source: ${task.source}`,
  ].join("\n");
}

export async function prepareSelectHandoff(
  projectRoot: string,
  runState: RunState,
  projectState: ProjectState
): Promise<SelectPreparation> {
  assertRunState(runState);
  assertProjectState(projectState);
  if (runState.phase !== "SELECT" || runState.status !== "running")
    throw new Error("SELECT handoff requires SELECT/running run state");
  const projectStateHash = hashProjectState(projectState);
  const ready = getReadyTasks(projectState);
  const nonReady = projectState.tasks.filter(
    (task) => !ready.some((candidate) => candidate.id === task.id)
  );
  const payload = {
    kind: SELECT_HANDOFF_KIND,
    run_id: runState.run_id,
    round: runState.round,
    project_state_hash: projectStateHash,
    ready: ready.map((task) => task.id),
    goal: projectState.goal,
    milestone: projectState.current_milestone,
  };
  const handoffHash = createHash("sha256")
    .update(canonicalizeValue(payload), "utf8")
    .digest("hex");
  const content = [
    "# Chief SELECT Handoff",
    "",
    "Choose exactly one legal action from the durable project plan.",
    "",
    `run_id: ${runState.run_id}`,
    `round: ${runState.round}`,
    `project_state_hash: ${projectStateHash}`,
    `handoff_hash: ${handoffHash}`,
    `project_goal: ${projectState.goal}`,
    `current_milestone: ${projectState.current_milestone}`,
    `project_status: ${projectState.status}`,
    `current_task_id: ${projectState.current_task_id ?? "none"}`,
    "",
    "## READY candidates",
    ...(ready.length ? ready.map(taskSummary) : ["- None"]),
    "",
    "## Non-ready task status",
    ...(nonReady.length
      ? nonReady.map((task) => `- ${task.id}: ${task.status}`)
      : ["- None"]),
    "",
    "## Legal actions",
    "- CONTINUE_DEVELOPMENT: select exactly one READY task.",
    "- RUN_INTEGRATION_UAT: select no task and provide a non-empty UAT scope.",
    "- HUMAN_REQUIRED: select no task and provide a concrete business question.",
    "- REQUEST_FINAL_REVIEW: select no task; route to final review without marking DONE.",
    "",
    "REFERENCE_FIRST: reuse or adapt proven repository/reference work when evidence supports it; BUILD requires explicit justification.",
    "Do not invent, split, reprioritize, cancel, or inject tasks.",
    "",
  ].join("\n");
  const roundDir = getRoundDir(
    getChiefRunDir(projectRoot, runState.run_id),
    runState.round
  );
  const handoffPath = join(roundDir, "select_handoff.md");
  await writeTextAtomic(handoffPath, content);
  const nextRunState: RunState = {
    ...runState,
    phase: "WAITING_FOR_CHIEF",
    status: "waiting",
    updated_at: new Date().toISOString(),
    waiting_handoff: {
      kind: "select",
      run_id: runState.run_id,
      round: runState.round,
      handoff_path: handoffPath,
      handoff_hash: handoffHash,
      project_state_hash: projectStateHash,
      created_at: new Date().toISOString(),
    },
  };
  assertRunState(nextRunState);
  await saveRunState(
    join(getChiefRunDir(projectRoot, runState.run_id), "RUN_STATE.json"),
    nextRunState
  );
  return {
    runState: nextRunState,
    handoff: {
      kind: SELECT_HANDOFF_KIND,
      run_id: runState.run_id,
      round: runState.round,
      handoff_hash: handoffHash,
      project_state_hash: projectStateHash,
      path: handoffPath,
      content,
    },
  };
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function applySelectDecision(
  projectRoot: string,
  waitingRunState: RunState,
  projectState: ProjectState,
  rawDecision: unknown
): Promise<{ runState: RunState; projectState: ProjectState }> {
  assertRunState(waitingRunState);
  assertProjectState(projectState);
  const decision = parseChiefSelectDecision(rawDecision);
  if (
    waitingRunState.phase !== "WAITING_FOR_CHIEF" ||
    waitingRunState.waiting_handoff?.kind !== "select"
  )
    throw new Error("run is not waiting for a SELECT decision");
  const handoff = waitingRunState.waiting_handoff;
  if (
    decision.run_id !== waitingRunState.run_id ||
    decision.round !== waitingRunState.round ||
    decision.run_id !== handoff.run_id ||
    decision.round !== handoff.round
  )
    throw new Error("SELECT decision identity does not match waiting handoff");
  const currentProjectHash = hashProjectState(projectState);
  if (
    decision.project_state_hash !== handoff.project_state_hash ||
    decision.project_state_hash !== currentProjectHash
  )
    throw new Error(
      "SELECT decision project_state_hash does not match current project state"
    );
  if (decision.handoff_hash !== handoff.handoff_hash)
    throw new Error(
      "SELECT decision handoff_hash does not match waiting handoff"
    );
  validateChiefSelectDecision(decision, projectState);
  const decisionPath = join(
    getRoundDir(
      getChiefRunDir(projectRoot, waitingRunState.run_id),
      waitingRunState.round
    ),
    "select_decision.json"
  );
  try {
    await access(decisionPath);
    throw new Error("SELECT decision was already consumed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeExclusive(decisionPath, decision);
  let nextProject = projectState;
  let nextPhase: RunState["phase"] = "FINAL_REVIEW";
  let nextStatus: RunState["status"] = "running";
  let nextTask: string | null = null;
  if (decision.action === "CONTINUE_DEVELOPMENT") {
    const selected = projectState.tasks.find(
      (task) => task.id === decision.selected_task_id
    )!;
    nextProject = {
      ...projectState,
      current_task_id: selected.id,
      updated_at: new Date().toISOString(),
      tasks: projectState.tasks.map((task) =>
        task.id === selected.id
          ? {
              ...task,
              status: "in_progress",
              updated_round: waitingRunState.round,
            }
          : task
      ),
    };
    nextPhase = "WORKER";
    nextTask = selected.id;
  } else if (decision.action === "RUN_INTEGRATION_UAT")
    nextPhase = "INTEGRATION_UAT";
  else if (decision.action === "HUMAN_REQUIRED") {
    nextPhase = "HUMAN_REQUIRED";
    nextStatus = "waiting";
  }
  const nextRun: RunState = {
    ...waitingRunState,
    phase: nextPhase,
    status: nextStatus,
    current_task_id: nextTask,
    waiting_handoff: undefined,
    updated_at: new Date().toISOString(),
  };
  assertProjectState(nextProject);
  assertRunState(nextRun);
  await saveProjectStateToProject(projectRoot, nextProject);
  await saveRunState(
    join(getChiefRunDir(projectRoot, waitingRunState.run_id), "RUN_STATE.json"),
    nextRun
  );
  return { runState: nextRun, projectState: nextProject };
}
