import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  loadProjectState,
  parseProjectState,
  saveProjectState,
  type ProjectState,
  type ProjectTask,
} from "./state.js";
import { writeTextAtomic } from "./atomic-json.js";
import { assertProjectState } from "./state-invariants.js";

export const PROJECT_STATE_RELATIVE_PATH = ".ralph/chief/PROJECT_STATE.json";
export const PROJECT_PLAN_RELATIVE_PATH = ".ralph/chief/PROJECT_PLAN.md";

export function projectStatePath(projectRoot: string): string {
  return join(projectRoot, PROJECT_STATE_RELATIVE_PATH);
}
export function projectPlanPath(projectRoot: string): string {
  return join(projectRoot, PROJECT_PLAN_RELATIVE_PATH);
}

export function canonicalizeValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalizeValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalizeProjectState(state: ProjectState): string {
  assertProjectState(state);
  return canonicalizeValue(state);
}

export function hashProjectState(state: ProjectState): string {
  return createHash("sha256")
    .update(canonicalizeProjectState(state), "utf8")
    .digest("hex");
}

export function getReadyTasks(state: ProjectState): ProjectTask[] {
  assertProjectState(state);
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  return state.tasks.filter(
    (task) =>
      task.status === "queued" &&
      task.dependencies.every((id) => byId.get(id)?.status === "done")
  );
}

function taskLines(tasks: ProjectTask[]): string[] {
  return [...tasks]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .map(
      (task) =>
        `- ${task.id}: ${task.title} (priority ${task.priority})\n  goal: ${task.goal}`
    );
}

export function renderProjectPlan(state: ProjectState): string {
  assertProjectState(state);
  const ready = getReadyTasks(state);
  const active = state.current_task_id ?? "none";
  const sections: Array<[string, ProjectTask[]]> = [
    ["READY", ready],
    [
      "QUEUED (blocked by dependencies)",
      state.tasks.filter(
        (task) =>
          task.status === "queued" &&
          !ready.some((candidate) => candidate.id === task.id)
      ),
    ],
    [
      "IN PROGRESS",
      state.tasks.filter((task) => task.status === "in_progress"),
    ],
    ["BLOCKED", state.tasks.filter((task) => task.status === "blocked")],
    ["DONE", state.tasks.filter((task) => task.status === "done")],
    ["CANCELLED", state.tasks.filter((task) => task.status === "cancelled")],
  ];
  const lines = [
    "# Project Plan",
    "",
    `- Goal: ${state.goal}`,
    `- Milestone: ${state.current_milestone}`,
    `- Status: ${state.status}`,
    `- Active task: ${active}`,
    "",
  ];
  for (const [title, tasks] of sections) {
    lines.push(`## ${title}`);
    lines.push(...(tasks.length > 0 ? taskLines(tasks) : ["- None"]), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function loadProjectStateFromProject(
  projectRoot: string
): Promise<ProjectState> {
  return loadProjectState(projectStatePath(projectRoot));
}

export async function saveProjectStateToProject(
  projectRoot: string,
  state: ProjectState
): Promise<void> {
  parseProjectState(state);
  await saveProjectState(projectStatePath(projectRoot), state);
  await writeTextAtomic(projectPlanPath(projectRoot), renderProjectPlan(state));
}
