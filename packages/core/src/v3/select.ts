import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  writeJsonAtomic,
  writeJsonImmutable,
  writeTextAtomic,
} from "./atomic-json.js";
import { assertProjectState, assertRunState } from "./state-invariants.js";
import { getChiefRunDir, getRoundDir } from "./rounds.js";
import {
  canonicalizeValue,
  getReadyTasks,
  hashProjectState,
  loadProjectStateFromProject,
  saveProjectStateToProject,
} from "./project-plan.js";
import {
  loadRunState,
  saveRunState,
  type ProjectState,
  type ProjectTask,
  type RunState,
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
  next_worker_task?: {
    objective: string;
    technical_direction: string;
    avoid_previous_routes: string[];
    acceptance: string[];
    evidence_to_check: string[];
  };
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

interface SelectTransition {
  version: 1;
  decision_hash: string;
  before_project_state_hash: string;
  after_project_state_hash: string;
  before_run_state_hash: string;
  after_run_state_hash: string;
  target_phase: RunState["phase"];
  target_task_id: string | null;
  after_project_state: ProjectState;
  after_run_state: RunState;
  created_at: string;
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
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function runHash(state: RunState): string {
  assertRunState(state);
  return sha256(canonicalizeValue(state));
}
function assertTransition(value: unknown): asserts value is SelectTransition {
  if (!record(value)) throw new Error("Invalid SELECT transition journal");
  exactKeys(
    value,
    [
      "version",
      "decision_hash",
      "before_project_state_hash",
      "after_project_state_hash",
      "before_run_state_hash",
      "after_run_state_hash",
      "target_phase",
      "target_task_id",
      "after_project_state",
      "after_run_state",
      "created_at",
    ],
    "transition"
  );
  if (value.version !== 1)
    throw new Error("Invalid SELECT transition journal version");
  for (const field of [
    "decision_hash",
    "before_project_state_hash",
    "after_project_state_hash",
    "before_run_state_hash",
    "after_run_state_hash",
  ])
    if (
      typeof value[field] !== "string" ||
      !/^[0-9a-f]{64}$/.test(value[field])
    )
      throw new Error(`Invalid SELECT transition journal ${field}`);
  if (
    typeof value.target_phase !== "string" ||
    (typeof value.target_task_id !== "string" && value.target_task_id !== null)
  )
    throw new Error("Invalid SELECT transition target");
  stringValue(value.created_at, "transition.created_at");
  if (Number.isNaN(Date.parse(value.created_at)))
    throw new Error("Invalid SELECT transition timestamp");
  assertProjectState(value.after_project_state);
  assertRunState(value.after_run_state);
  if (
    hashProjectState(value.after_project_state) !==
      value.after_project_state_hash ||
    runHash(value.after_run_state) !== value.after_run_state_hash
  )
    throw new Error("SELECT transition after-state hash mismatch");
  if (
    value.after_run_state.phase !== value.target_phase ||
    value.after_run_state.current_task_id !== value.target_task_id
  )
    throw new Error("SELECT transition target mismatch");
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
      "next_worker_task",
      "run_id",
      "round",
      "handoff_hash",
      "project_state_hash",
    ],
    "decision"
  );
  if (
    typeof value.action !== "string" ||
    ![
      "CONTINUE_DEVELOPMENT",
      "RUN_INTEGRATION_UAT",
      "HUMAN_REQUIRED",
      "REQUEST_FINAL_REVIEW",
    ].includes(value.action)
  )
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
  if (value.next_worker_task !== undefined) {
    if (!record(value.next_worker_task))
      fail("next_worker_task must be an object");
    exactKeys(
      value.next_worker_task,
      [
        "objective",
        "technical_direction",
        "avoid_previous_routes",
        "acceptance",
        "evidence_to_check",
      ],
      "next_worker_task"
    );
    nonEmpty(value.next_worker_task.objective, "next_worker_task.objective");
    nonEmpty(
      value.next_worker_task.technical_direction,
      "next_worker_task.technical_direction"
    );
    stringArray(
      value.next_worker_task.avoid_previous_routes,
      "next_worker_task.avoid_previous_routes"
    );
    stringArray(
      value.next_worker_task.acceptance,
      "next_worker_task.acceptance"
    );
    stringArray(
      value.next_worker_task.evidence_to_check,
      "next_worker_task.evidence_to_check"
    );
  }
  nonEmpty(value.run_id, "run_id");
  if (
    typeof value.round !== "number" ||
    !Number.isInteger(value.round) ||
    value.round < 1
  )
    fail("round must be a positive integer");
  if (
    typeof value.handoff_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.handoff_hash)
  )
    fail("handoff_hash must be lowercase SHA-256");
  if (
    typeof value.project_state_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.project_state_hash)
  )
    fail("project_state_hash must be lowercase SHA-256");
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
    decision.reference_check.decision !== "NOT_APPLICABLE" &&
    decision.reference_check.evidence.length === 0
  )
    fail("reference decision requires evidence");
  switch (decision.action) {
    case "CONTINUE_DEVELOPMENT":
      if (decision.selected_task_id === null)
        fail("CONTINUE_DEVELOPMENT requires selected_task_id");
      if (!ready.some((task) => task.id === decision.selected_task_id))
        fail("selected task is not READY");
      if (
        decision.human_question !== "" ||
        decision.human_options.length !== 0 ||
        decision.uat_scope !== ""
      )
        fail("CONTINUE_DEVELOPMENT cannot include human or UAT fields");
      break;
    case "RUN_INTEGRATION_UAT":
      if (decision.selected_task_id !== null)
        fail("RUN_INTEGRATION_UAT cannot select a task");
      if (decision.uat_scope.length === 0)
        fail("RUN_INTEGRATION_UAT requires uat_scope");
      if (decision.human_question !== "" || decision.human_options.length !== 0)
        fail("RUN_INTEGRATION_UAT cannot include human fields");
      if (decision.next_worker_task !== undefined)
        fail("RUN_INTEGRATION_UAT cannot include next_worker_task");
      break;
    case "HUMAN_REQUIRED":
      if (decision.selected_task_id !== null)
        fail("HUMAN_REQUIRED cannot select a task");
      if (decision.human_question.length === 0)
        fail("HUMAN_REQUIRED requires human_question");
      if (decision.uat_scope !== "")
        fail("HUMAN_REQUIRED cannot include uat_scope");
      if (decision.next_worker_task !== undefined)
        fail("HUMAN_REQUIRED cannot include next_worker_task");
      break;
    case "REQUEST_FINAL_REVIEW":
      if (decision.selected_task_id !== null)
        fail("REQUEST_FINAL_REVIEW cannot select a task");
      if (
        decision.human_question !== "" ||
        decision.human_options.length !== 0 ||
        decision.uat_scope !== ""
      )
        fail("REQUEST_FINAL_REVIEW cannot include control fields");
      if (decision.next_worker_task !== undefined)
        fail("REQUEST_FINAL_REVIEW cannot include next_worker_task");
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

async function prepareSelectHandoffFromState(
  projectRoot: string,
  runState: RunState,
  projectState: ProjectState
): Promise<SelectPreparation> {
  assertRunState(runState);
  assertProjectState(projectState);
  if (runState.phase !== "SELECT" || runState.status !== "running")
    throw new Error("SELECT handoff requires SELECT/running run state");
  await saveProjectStateToProject(projectRoot, projectState);
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
  const handoffHash = sha256(canonicalizeValue(payload));
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
  const handoffPath = join(
    getRoundDir(getChiefRunDir(projectRoot, runState.run_id), runState.round),
    "select_handoff.md"
  );
  await writeTextAtomic(handoffPath, content);
  const createdAt = new Date().toISOString();
  const nextRunState: RunState = {
    ...runState,
    phase: "WAITING_FOR_CHIEF",
    status: "waiting",
    updated_at: createdAt,
    waiting_handoff: {
      kind: "select",
      run_id: runState.run_id,
      round: runState.round,
      handoff_path: handoffPath,
      handoff_hash: handoffHash,
      project_state_hash: projectStateHash,
      created_at: createdAt,
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

export async function prepareSelectHandoff(
  projectRoot: string,
  runId: string
): Promise<SelectPreparation> {
  const runState = await loadRunState(
    join(getChiefRunDir(projectRoot, runId), "RUN_STATE.json")
  );
  const projectState = await loadProjectStateFromProject(projectRoot);
  return prepareSelectHandoffFromState(projectRoot, runState, projectState);
}

function transitionFor(
  decision: ChiefSelectDecision,
  waitingRunState: RunState,
  projectState: ProjectState
): SelectTransition {
  let afterProjectState = projectState;
  let targetPhase: RunState["phase"] = "FINAL_REVIEW";
  let targetStatus: RunState["status"] = "running";
  let targetTask: string | null = null;
  if (decision.action === "CONTINUE_DEVELOPMENT") {
    const selected = projectState.tasks.find(
      (task) => task.id === decision.selected_task_id
    )!;
    afterProjectState = {
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
    targetPhase = "WORKER";
    targetTask = selected.id;
  } else if (decision.action === "RUN_INTEGRATION_UAT")
    targetPhase = "INTEGRATION_UAT";
  else if (decision.action === "HUMAN_REQUIRED") {
    targetPhase = "HUMAN_REQUIRED";
    targetStatus = "waiting";
  }
  const { waiting_handoff: _waitingHandoff, ...runWithoutHandoff } =
    waitingRunState;
  const afterRunState: RunState = {
    ...runWithoutHandoff,
    phase: targetPhase,
    status: targetStatus,
    current_task_id: targetTask,
    updated_at: new Date().toISOString(),
  };
  assertProjectState(afterProjectState);
  assertRunState(afterRunState);
  return {
    version: 1,
    decision_hash: sha256(canonicalizeValue(decision)),
    before_project_state_hash: hashProjectState(projectState),
    after_project_state_hash: hashProjectState(afterProjectState),
    before_run_state_hash: runHash(waitingRunState),
    after_run_state_hash: runHash(afterRunState),
    target_phase: targetPhase,
    target_task_id: targetTask,
    after_project_state: afterProjectState,
    after_run_state: afterRunState,
    created_at: new Date().toISOString(),
  };
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function applyFromAuthoritative(
  projectRoot: string,
  runId: string,
  rawDecision?: unknown
): Promise<{ runState: RunState; projectState: ProjectState }> {
  const runDir = getChiefRunDir(projectRoot, runId);
  const runPath = join(runDir, "RUN_STATE.json");
  const projectState = await loadProjectStateFromProject(projectRoot);
  const currentRunState = await loadRunState(runPath);
  const handoff =
    currentRunState.phase === "WAITING_FOR_CHIEF" &&
    currentRunState.waiting_handoff?.kind === "select"
      ? currentRunState.waiting_handoff
      : undefined;
  const isWaiting = handoff !== undefined;
  if (
    !isWaiting &&
    currentRunState.phase !== "WORKER" &&
    currentRunState.phase !== "INTEGRATION_UAT" &&
    currentRunState.phase !== "HUMAN_REQUIRED" &&
    currentRunState.phase !== "FINAL_REVIEW"
  )
    throw new Error("run is not waiting for a SELECT decision");
  const waitingRunState = isWaiting ? currentRunState : undefined;
  const round = currentRunState.round;
  const decisionPath = join(getRoundDir(runDir, round), "select_decision.json");
  const transitionPath = join(
    getRoundDir(runDir, round),
    "select_transition.json"
  );
  const storedRaw = await readJsonFile(decisionPath);
  let decision: ChiefSelectDecision;
  if (storedRaw === undefined) {
    if (!isWaiting || rawDecision === undefined || !handoff)
      throw new Error("SELECT decision is missing");
    decision = parseChiefSelectDecision(rawDecision);
    if (
      decision.run_id !== runId ||
      decision.round !== round ||
      decision.run_id !== handoff.run_id ||
      decision.round !== handoff.round
    )
      throw new Error(
        "SELECT decision identity does not match waiting handoff"
      );
    if (decision.handoff_hash !== handoff.handoff_hash)
      throw new Error(
        "SELECT decision handoff_hash does not match waiting handoff"
      );
    if (
      decision.project_state_hash !== handoff.project_state_hash ||
      decision.project_state_hash !== hashProjectState(projectState)
    )
      throw new Error(
        "SELECT decision project_state_hash does not match current project state"
      );
    validateChiefSelectDecision(decision, projectState);
    await writeJsonImmutable(decisionPath, decision);
  } else {
    decision = parseChiefSelectDecision(storedRaw);
    if (
      rawDecision !== undefined &&
      sha256(canonicalizeValue(parseChiefSelectDecision(rawDecision))) !==
        sha256(canonicalizeValue(decision))
    )
      throw new Error("SELECT decision is immutable and cannot be replaced");
  }
  const decisionHash = sha256(canonicalizeValue(decision));
  if (
    handoff &&
    (decision.run_id !== runId ||
      decision.round !== round ||
      decision.run_id !== handoff.run_id ||
      decision.round !== handoff.round)
  )
    throw new Error("SELECT decision identity does not match waiting handoff");
  if (handoff && decision.handoff_hash !== handoff.handoff_hash)
    throw new Error(
      "SELECT decision handoff_hash does not match waiting handoff"
    );
  const currentProjectHash = hashProjectState(projectState);
  if (handoff && decision.project_state_hash !== handoff.project_state_hash)
    throw new Error(
      "SELECT decision project_state_hash does not match waiting handoff"
    );
  let transition: SelectTransition;
  const transitionRaw = await readJsonFile(transitionPath);
  if (transitionRaw !== undefined) {
    assertTransition(transitionRaw);
    if (transitionRaw.decision_hash !== decisionHash)
      throw new Error("SELECT transition journal does not match decision");
    transition = transitionRaw;
  } else {
    if (!isWaiting)
      throw new Error(
        "SELECT transition journal is missing for a completed decision"
      );
    if (currentProjectHash !== decision.project_state_hash)
      throw new Error(
        "SELECT decision project_state_hash does not match current project state"
      );
    validateChiefSelectDecision(decision, projectState);
    transition = transitionFor(decision, currentRunState, projectState);
    await writeJsonImmutable(transitionPath, transition);
  }
  const projectNow = await loadProjectStateFromProject(projectRoot);
  const projectNowHash = hashProjectState(projectNow);
  if (
    projectNowHash !== transition.before_project_state_hash &&
    projectNowHash !== transition.after_project_state_hash
  )
    throw new Error(
      "project state is neither the expected before nor after SELECT transition"
    );
  if (projectNowHash === transition.before_project_state_hash)
    await saveProjectStateToProject(
      projectRoot,
      transition.after_project_state
    );
  const runNow = await loadRunState(runPath);
  const runNowHash = runHash(runNow);
  if (
    runNowHash !== transition.before_run_state_hash &&
    runNowHash !== transition.after_run_state_hash
  )
    throw new Error(
      "run state is neither the expected before nor after SELECT transition"
    );
  if (runNowHash === transition.before_run_state_hash)
    await saveRunState(runPath, transition.after_run_state);
  const receiptPath = join(
    getRoundDir(runDir, round),
    "select_transition_receipt.json"
  );
  if ((await readJsonFile(receiptPath)) === undefined)
    await writeJsonAtomic(receiptPath, {
      version: 1,
      decision_hash: decisionHash,
      completed_at: new Date().toISOString(),
    });
  return {
    runState: transition.after_run_state,
    projectState: transition.after_project_state,
  };
}

export async function applySelectDecision(
  projectRoot: string,
  runId: string,
  rawDecision?: unknown
): Promise<{ runState: RunState; projectState: ProjectState }> {
  return applyFromAuthoritative(projectRoot, runId, rawDecision);
}
