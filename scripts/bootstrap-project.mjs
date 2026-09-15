#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  getChiefRunDir,
  saveProjectStateToProject,
  saveRunState,
  syncObligationsFromProject,
} from "../packages/core/dist/index.js";

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`Unknown argument: ${key}`);
    out[key.slice(2).replaceAll("-", "_")] = argv[++i];
  }
  if (!out.repo || !out.run_id || !out.goal || !out.task_file)
    throw new Error(
      "Usage: bootstrap-project --repo ROOT --run-id ID --goal TEXT --task-file JSON"
    );
  return out;
}

const input = args(process.argv.slice(2));
const root = resolve(input.repo);
const tasks = JSON.parse(await readFile(resolve(input.task_file), "utf8"));
if (!Array.isArray(tasks) || tasks.length === 0)
  throw new Error("task-file must contain a non-empty array");
const now = new Date().toISOString();
const project = {
  version: 1,
  project_id: input.project_id ?? input.run_id,
  goal: input.goal,
  status: "active",
  current_milestone: input.milestone ?? "Imported project obligations",
  current_task_id: null,
  tasks: tasks.map((task, index) => ({
    id: String(task.id),
    title: String(task.title),
    goal: String(task.goal),
    status: "queued",
    priority: Number(task.priority ?? tasks.length - index),
    dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
    acceptance: Array.isArray(task.acceptance) ? task.acceptance : [],
    verification: Array.isArray(task.verification) ? task.verification : [],
    evidence: Array.isArray(task.evidence) ? task.evidence : [],
    source: String(task.source ?? "bootstrap evidence"),
    created_round: 1,
    updated_round: 1,
  })),
  created_at: now,
  updated_at: now,
};
await saveProjectStateToProject(root, project);
await syncObligationsFromProject(root, input.run_id);
await saveRunState(join(getChiefRunDir(root, input.run_id), "RUN_STATE.json"), {
  version: 1,
  run_id: input.run_id,
  phase: "SELECT",
  status: "running",
  round: 1,
  current_task_id: null,
  started_at: now,
  updated_at: now,
});
console.log(
  JSON.stringify({
    run_id: input.run_id,
    project_state: ".ralph/chief/PROJECT_STATE.json",
    obligations: tasks.length,
  })
);
