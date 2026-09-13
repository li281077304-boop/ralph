import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJsonAtomic } from "./atomic-json.js";
import { getChiefRunDir } from "./rounds.js";
import { loadProjectStateFromProject } from "./project-plan.js";
import { loadRunState, saveRunState, type RunState } from "./state.js";
import {
  runV3WorkSlice,
  type V3WorkConfig,
  type V3WorkResult,
} from "./work.js";
import type { GoalTransport } from "./goal-worker.js";
import type { MachineGateOptions, MachineGateResult } from "../machine-gate.js";
import type { V3WorkerRunner } from "./worker.js";

export type UnattendedStatus =
  "TASK_PASS" | "HUMAN_REQUIRED" | "FAILED" | "WAITING_FOR_CHIEF";

export type UnattendedResult = {
  status: UnattendedStatus;
  runState: RunState;
  patchRounds: number;
  reason?: string;
};

type ReviewResult = {
  runState: RunState;
  projectState: unknown;
  recovered?: boolean;
  guiCalls?: number;
};

type AutoArtifact = {
  version: 1;
  run_id: string;
  task_id: string;
  created_at: string;
  updated_at: string;
  patch_rounds: number;
};

function runStatePath(root: string, runId: string): string {
  return join(getChiefRunDir(root, runId), "RUN_STATE.json");
}

function autoArtifactPath(root: string, runId: string): string {
  return join(getChiefRunDir(root, runId), "unattended.json");
}

async function readAutoArtifact(
  root: string,
  runId: string
): Promise<AutoArtifact | undefined> {
  try {
    const value = JSON.parse(
      await readFile(autoArtifactPath(root, runId), "utf8")
    ) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.run_id !== runId ||
      typeof value.task_id !== "string" ||
      typeof value.created_at !== "string" ||
      typeof value.updated_at !== "string" ||
      typeof value.patch_rounds !== "number" ||
      !Number.isInteger(value.patch_rounds) ||
      value.patch_rounds < 0
    )
      throw new Error("unattended.json is malformed");
    return value as AutoArtifact;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function now(): string {
  return new Date().toISOString();
}

async function persistArtifact(
  root: string,
  runId: string,
  taskId: string,
  patchRounds: number,
  createdAt?: string
): Promise<AutoArtifact> {
  const artifact: AutoArtifact = {
    version: 1,
    run_id: runId,
    task_id: taskId,
    created_at: createdAt ?? now(),
    updated_at: now(),
    patch_rounds: patchRounds,
  };
  await writeJsonAtomic(autoArtifactPath(root, runId), artifact);
  return artifact;
}

function waitingKind(state: RunState): string | undefined {
  return state.waiting_handoff?.kind;
}

function statusFromState(
  state: RunState,
  reason?: string,
  patchRounds = 0
): UnattendedResult {
  if (state.phase === "HUMAN_REQUIRED")
    return { status: "HUMAN_REQUIRED", runState: state, patchRounds, reason };
  if (state.phase === "WAITING_FOR_CHIEF")
    return {
      status: "WAITING_FOR_CHIEF",
      runState: state,
      patchRounds,
      reason,
    };
  if (state.phase === "FAILED")
    return { status: "FAILED", runState: state, patchRounds, reason };
  if (state.phase === "DONE")
    return { status: "TASK_PASS", runState: state, patchRounds, reason };
  return { status: "FAILED", runState: state, patchRounds, reason };
}

export async function runV3UnattendedTask(options: {
  projectRoot: string;
  runId: string;
  config: V3WorkConfig;
  reviewRunner?: (options: {
    projectRoot: string;
    runId: string;
  }) => Promise<ReviewResult>;
  runAgent?: V3WorkerRunner;
  goalTransport?: GoalTransport;
  runGate?: (
    workspaceDir: string,
    options: MachineGateOptions
  ) => Promise<MachineGateResult>;
}): Promise<UnattendedResult> {
  const projectRoot = resolve(options.projectRoot);
  const statePath = runStatePath(projectRoot, options.runId);
  let state = await loadRunState(statePath);
  let project = await loadProjectStateFromProject(projectRoot);
  let artifact = await readAutoArtifact(projectRoot, options.runId);
  let taskId = artifact?.task_id ?? state.current_task_id;
  if (!taskId) {
    if (state.phase === "DONE") return statusFromState(state, undefined, 0);
    throw new Error("Unattended task runner requires a selected task");
  }
  if (
    artifact &&
    state.current_task_id &&
    artifact.task_id !== state.current_task_id
  ) {
    if (!(state.phase === "SELECT" && state.current_task_id === null))
      throw new Error("unattended task identity changed");
  }
  if (!artifact)
    artifact = await persistArtifact(projectRoot, options.runId, taskId, 0);
  let patchRounds = artifact.patch_rounds;

  for (;;) {
    state = await loadRunState(statePath);
    project = await loadProjectStateFromProject(projectRoot);
    if (
      state.phase === "DONE" ||
      state.phase === "FAILED" ||
      state.phase === "HUMAN_REQUIRED"
    )
      return statusFromState(
        state,
        state.failure_reason ?? state.stop_reason,
        patchRounds
      );
    if (state.phase === "WAITING_FOR_CHIEF" && waitingKind(state) !== "review")
      return statusFromState(
        state,
        "External Chief decision is required",
        patchRounds
      );
    if (state.phase === "SELECT") {
      const task = project.tasks.find((entry) => entry.id === taskId);
      if (task?.status === "done" && project.current_task_id === null) {
        const done: RunState = {
          ...state,
          phase: "DONE",
          status: "done",
          current_task_id: null,
          stop_reason: "unattended single-task review PASS",
          updated_at: now(),
        };
        await saveRunState(statePath, done);
        return { status: "TASK_PASS", runState: done, patchRounds };
      }
      return statusFromState(
        { ...state, phase: "FAILED", status: "failed" },
        "Unattended runner cannot select a new task",
        patchRounds
      );
    }
    if (["WORKER", "MACHINE_GATE", "CHECKPOINT"].includes(state.phase)) {
      const work: V3WorkResult = await runV3WorkSlice({
        projectRoot,
        runId: options.runId,
        config: options.config,
        runAgent: options.runAgent,
        goalTransport: options.goalTransport,
        runGate: options.runGate,
      });
      if (
        work.runState.phase === "FAILED" ||
        work.runState.phase === "HUMAN_REQUIRED"
      )
        return statusFromState(
          work.runState,
          work.runState.failure_reason,
          patchRounds
        );
      continue;
    }
    if (state.phase === "CHIEF_REVIEW" || state.phase === "WAITING_FOR_CHIEF") {
      if (!options.reviewRunner)
        return statusFromState(
          state,
          "External Chief review runner is unavailable",
          patchRounds
        );
      try {
        const review = await options.reviewRunner({
          projectRoot,
          runId: options.runId,
        });
        state = review.runState;
        project = await loadProjectStateFromProject(projectRoot);
        if (state.phase === "HUMAN_REQUIRED")
          return statusFromState(state, state.failure_reason, patchRounds);
        if (state.phase === "WAITING_FOR_CHIEF")
          return statusFromState(
            state,
            "External Chief is still unavailable",
            patchRounds
          );
        if (state.phase === "WORKER") {
          patchRounds += 1;
          artifact = await persistArtifact(
            projectRoot,
            options.runId,
            taskId,
            patchRounds,
            artifact.created_at
          );
          continue;
        }
        if (state.phase === "SELECT") continue;
      } catch (error) {
        const current = await loadRunState(statePath);
        if (
          current.phase === "WAITING_FOR_CHIEF" &&
          waitingKind(current) === "review"
        )
          return statusFromState(
            current,
            error instanceof Error ? error.message : String(error),
            patchRounds
          );
        throw error;
      }
      continue;
    }
    throw new Error(`Unattended runner cannot execute phase ${state.phase}`);
  }
}
