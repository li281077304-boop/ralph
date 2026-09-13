import type { ProjectState, ProjectTask, RunState } from "./state.js";

// Keep the invariant vocabulary local so validation has no runtime import cycle
// with state.ts (which imports these assertions for persistence boundaries).
const phaseSet = new Set<string>([
  "SELECT",
  "WORKER",
  "MACHINE_GATE",
  "CHECKPOINT",
  "CHIEF_REVIEW",
  "INTEGRATION_UAT",
  "FINAL_REVIEW",
  "WAITING_FOR_CHIEF",
  "HUMAN_REQUIRED",
  "DONE",
  "FAILED",
]);
const PROJECT_STATE_VERSION = 1;
const RUN_STATE_VERSION = 1;
const projectStatuses = new Set(["active", "paused", "done", "failed"]);
const runStatuses = new Set(["running", "waiting", "paused", "done", "failed"]);
const taskStatuses = new Set([
  "queued",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
]);
const terminalPhases = new Set(["DONE", "FAILED"]);
const waitingPhases = new Set(["WAITING_FOR_CHIEF", "HUMAN_REQUIRED"]);

function fail(message: string): never {
  throw new Error(`Invalid durable state: ${message}`);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function knownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value))
    if (!allowedSet.has(key)) fail(`${label}.${key} is unknown`);
}
function string(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    fail(`${field} must be a non-empty string`);
}
function nullableString(
  value: unknown,
  field: string
): asserts value is string | null {
  if (value !== null && typeof value !== "string")
    fail(`${field} must be a string or null`);
}
function iso(value: unknown, field: string): asserts value is string {
  string(value, field);
  if (Number.isNaN(Date.parse(value)))
    fail(`${field} must be an ISO timestamp`);
}
function stringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    fail(`${field} must be an array of strings`);
}
function integer(
  value: unknown,
  field: string,
  min = 0
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min)
    fail(`${field} must be an integer >= ${min}`);
}

function assertTask(value: unknown): asserts value is ProjectTask {
  if (!record(value)) fail("task must be an object");
  knownKeys(
    value,
    [
      "id",
      "title",
      "goal",
      "status",
      "priority",
      "dependencies",
      "acceptance",
      "verification",
      "evidence",
      "source",
      "created_round",
      "updated_round",
      "blocked_reason",
    ],
    "task"
  );
  for (const field of ["id", "title", "goal", "source"])
    string(value[field], `task.${field}`);
  if (typeof value.status !== "string" || !taskStatuses.has(value.status))
    fail("task.status is unknown");
  integer(value.priority, "task.priority");
  stringArray(value.dependencies, "task.dependencies");
  stringArray(value.acceptance, "task.acceptance");
  stringArray(value.verification, "task.verification");
  stringArray(value.evidence, "task.evidence");
  integer(value.created_round, "task.created_round", 1);
  integer(value.updated_round, "task.updated_round", 1);
  if (
    value.blocked_reason !== undefined &&
    typeof value.blocked_reason !== "string"
  )
    fail("task.blocked_reason must be a string");
}

export function assertProjectState(
  value: unknown
): asserts value is ProjectState {
  if (!record(value)) fail("PROJECT_STATE must be an object");
  knownKeys(
    value,
    [
      "version",
      "project_id",
      "goal",
      "status",
      "current_milestone",
      "current_task_id",
      "tasks",
      "created_at",
      "updated_at",
    ],
    "PROJECT_STATE"
  );
  if (value.version !== PROJECT_STATE_VERSION)
    fail(`PROJECT_STATE.version must be ${PROJECT_STATE_VERSION}`);
  string(value.project_id, "project_id");
  string(value.goal, "goal");
  if (typeof value.status !== "string" || !projectStatuses.has(value.status))
    fail("project.status is unknown");
  string(value.current_milestone, "current_milestone");
  nullableString(value.current_task_id, "current_task_id");
  if (!Array.isArray(value.tasks)) fail("tasks must be an array");
  value.tasks.forEach(assertTask);
  const ids = new Set<string>();
  for (const task of value.tasks) {
    if (ids.has(task.id)) fail(`duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of value.tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.id) fail(`task ${task.id} depends on itself`);
      if (!ids.has(dependency))
        fail(`task ${task.id} depends on unknown task: ${dependency}`);
    }
  }
  const activeTasks = value.tasks.filter(
    (task) => task.status === "in_progress"
  );
  if (activeTasks.length > 1)
    fail("PROJECT_STATE cannot contain more than one in_progress task");
  if (activeTasks.length === 0) {
    if (value.current_task_id !== null)
      fail("current_task_id must be null when no task is in_progress");
  } else if (value.current_task_id !== activeTasks[0].id) {
    fail("current_task_id must match the in_progress task");
  }
  if (value.current_task_id !== null && !ids.has(value.current_task_id))
    fail("current_task_id is not present in tasks");
  iso(value.created_at, "created_at");
  iso(value.updated_at, "updated_at");
}

export function assertRunState(value: unknown): asserts value is RunState {
  if (!record(value)) fail("RUN_STATE must be an object");
  knownKeys(
    value,
    [
      "run_id",
      "version",
      "phase",
      "status",
      "round",
      "current_task_id",
      "waiting_handoff",
      "head_evidence",
      "started_at",
      "updated_at",
      "failure_reason",
      "stop_reason",
    ],
    "RUN_STATE"
  );
  string(value.run_id, "run_id");
  if (value.version !== RUN_STATE_VERSION)
    fail(`RUN_STATE.version must be ${RUN_STATE_VERSION}`);
  if (typeof value.phase !== "string" || !phaseSet.has(value.phase))
    fail("phase is unknown");
  if (typeof value.status !== "string" || !runStatuses.has(value.status))
    fail("status is unknown");
  integer(value.round, "round", 1);
  nullableString(value.current_task_id, "current_task_id");
  iso(value.started_at, "started_at");
  iso(value.updated_at, "updated_at");
  if (terminalPhases.has(value.phase)) {
    const expected = value.phase === "DONE" ? "done" : "failed";
    if (value.status !== expected)
      fail(`${value.phase} requires status ${expected}`);
  } else if (waitingPhases.has(value.phase)) {
    if (value.status !== "waiting" && value.status !== "paused")
      fail(`${value.phase} requires waiting or paused status`);
  } else if (value.status !== "running") {
    fail(`${value.phase} requires running status`);
  }
  if (
    value.failure_reason !== undefined &&
    typeof value.failure_reason !== "string"
  )
    fail("failure_reason must be a string");
  if (value.stop_reason !== undefined && typeof value.stop_reason !== "string")
    fail("stop_reason must be a string");
  if (
    value.phase === "WAITING_FOR_CHIEF" &&
    value.waiting_handoff === undefined
  )
    fail("WAITING_FOR_CHIEF requires waiting_handoff");
  if (value.waiting_handoff !== undefined) {
    if (!record(value.waiting_handoff))
      fail("waiting_handoff must be an object");
    knownKeys(
      value.waiting_handoff,
      [
        "kind",
        "run_id",
        "round",
        "handoff_path",
        "handoff_hash",
        "project_state_hash",
        "created_at",
      ],
      "waiting_handoff"
    );
    if (
      typeof value.waiting_handoff.kind !== "string" ||
      !["select", "review", "final_review"].includes(value.waiting_handoff.kind)
    )
      fail("waiting_handoff.kind is unknown");
    string(value.waiting_handoff.run_id, "waiting_handoff.run_id");
    integer(value.waiting_handoff.round, "waiting_handoff.round", 1);
    string(value.waiting_handoff.handoff_path, "waiting_handoff.handoff_path");
    string(value.waiting_handoff.handoff_hash, "waiting_handoff.handoff_hash");
    if (!/^[0-9a-f]{64}$/.test(value.waiting_handoff.handoff_hash))
      fail("waiting_handoff.handoff_hash must be lowercase SHA-256");
    if (value.waiting_handoff.kind === "select") {
      string(
        value.waiting_handoff.project_state_hash,
        "waiting_handoff.project_state_hash"
      );
      if (!/^[0-9a-f]{64}$/.test(value.waiting_handoff.project_state_hash))
        fail("waiting_handoff.project_state_hash must be lowercase SHA-256");
    } else if (value.waiting_handoff.project_state_hash !== undefined) {
      fail("project_state_hash is only valid for select handoffs");
    }
    iso(value.waiting_handoff.created_at, "waiting_handoff.created_at");
    if (!waitingPhases.has(value.phase))
      fail("waiting_handoff only valid in a waiting phase");
  }
  if (value.head_evidence !== undefined) {
    if (!record(value.head_evidence)) fail("head_evidence must be an object");
    knownKeys(
      value.head_evidence,
      ["base", "head", "diff_hash"],
      "head_evidence"
    );
    for (const field of ["base", "head", "diff_hash"])
      if (value.head_evidence[field] !== undefined)
        string(value.head_evidence[field], `head_evidence.${field}`);
  }
}
