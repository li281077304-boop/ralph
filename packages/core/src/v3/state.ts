import { readFile } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "./atomic-json.js";
import { assertProjectState, assertRunState } from "./state-invariants.js";

export const RUN_STATE_VERSION = 1 as const;
export const PROJECT_STATE_VERSION = 1 as const;

export const V3_PHASES = [
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
] as const;
export type V3Phase = (typeof V3_PHASES)[number];
export type RunStatus = "running" | "waiting" | "paused" | "done" | "failed";
export type ProjectStatus = "active" | "paused" | "done" | "failed";
export type TaskStatus =
  "queued" | "in_progress" | "blocked" | "done" | "cancelled";

export interface ProjectTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  dependencies: string[];
  acceptance: string[];
  evidence: string[];
  source: string;
  created_round: number;
  updated_round: number;
  blocked_reason?: string;
}

export interface ProjectState {
  version: typeof PROJECT_STATE_VERSION;
  project_id: string;
  goal: string;
  status: ProjectStatus;
  current_milestone: string;
  current_task_id: string | null;
  tasks: ProjectTask[];
  created_at: string;
  updated_at: string;
}

export interface WaitingHandoff {
  handoff_path: string;
  handoff_hash: string;
  created_at: string;
}

export interface HeadEvidence {
  base?: string;
  head?: string;
  diff_hash?: string;
}

export interface RunState {
  run_id: string;
  version: typeof RUN_STATE_VERSION;
  phase: V3Phase;
  status: RunStatus;
  round: number;
  current_task_id: string | null;
  waiting_handoff?: WaitingHandoff;
  head_evidence?: HeadEvidence;
  started_at: string;
  updated_at: string;
  failure_reason?: string;
  stop_reason?: string;
}

function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

export function parseRunState(value: unknown): RunState {
  assertRunState(value);
  return value;
}

export function parseProjectState(value: unknown): ProjectState {
  assertProjectState(value);
  return value;
}

export async function loadRunState(path: string): Promise<RunState> {
  return parseRunState(await readJson(path));
}

export async function loadProjectState(path: string): Promise<ProjectState> {
  return parseProjectState(await readJson(path));
}

export async function saveRunState(
  path: string,
  state: RunState
): Promise<void> {
  assertRunState(state);
  await writeJsonAtomic(path, state);
}

export async function saveProjectState(
  path: string,
  state: ProjectState
): Promise<void> {
  assertProjectState(state);
  await writeJsonAtomic(path, state);
}

/** Strict text hydrators are useful at boundaries where a JSON file is already read. */
export function hydrateRunState(text: string): RunState {
  return parseRunState(parseJsonText(text, "RUN_STATE"));
}

export function hydrateProjectState(text: string): ProjectState {
  return parseProjectState(parseJsonText(text, "PROJECT_STATE"));
}
