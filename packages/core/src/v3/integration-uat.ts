import { join, resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";

import { acquireActiveWriterLock, releaseActiveWriterLock } from "./lock.js";
import { getChiefRunDir, getRoundDir } from "./rounds.js";
import {
  loadProjectStateFromProject,
  saveProjectStateToProject,
} from "./project-plan.js";
import { loadRunState, saveRunState, type RunState } from "./state.js";
import { assertProjectState, assertRunState } from "./state-invariants.js";
import { writeJsonAtomic } from "./atomic-json.js";
import {
  runMachineGate,
  type MachineGateOptions,
  type MachineGateResult,
} from "../machine-gate.js";

export type IntegrationUatAction =
  "PASS" | "PATCH" | "HUMAN_REQUIRED" | "FAILED";

export interface IntegrationUatOutcome {
  action: IntegrationUatAction;
  findings?: string[];
  human_question?: string;
  human_options?: string[];
  reason?: string;
  result?: Record<string, unknown>;
}

export interface V3IntegrationUatConfig {
  uat_commands?: string[];
  timeout_seconds?: number;
  gate_allowed_paths?: string[];
}

export interface IntegrationUatResult {
  runState: RunState;
  outcome: IntegrationUatOutcome;
}

function runPath(root: string, runId: string): string {
  return join(getChiefRunDir(root, runId), "RUN_STATE.json");
}
function artifactPath(root: string, runId: string, round: number): string {
  return join(
    getRoundDir(getChiefRunDir(root, runId), round),
    "integration_uat.json"
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function readArtifact(
  path: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(value)) throw new Error("integration_uat.json is malformed");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function failState(state: RunState, reason: string): RunState {
  return {
    ...state,
    phase: "FAILED",
    status: "failed",
    failure_reason: reason,
    updated_at: new Date().toISOString(),
  };
}
function normalizeOutcome(
  value: Record<string, unknown>
): IntegrationUatOutcome {
  const action = value.action;
  if (
    action !== "PASS" &&
    action !== "PATCH" &&
    action !== "HUMAN_REQUIRED" &&
    action !== "FAILED"
  )
    throw new Error("integration UAT outcome action is invalid");
  return {
    action,
    findings: Array.isArray(value.findings)
      ? value.findings.filter((v): v is string => typeof v === "string")
      : [],
    human_question:
      typeof value.human_question === "string" ? value.human_question : "",
    human_options: Array.isArray(value.human_options)
      ? value.human_options.filter((v): v is string => typeof v === "string")
      : [],
    reason: typeof value.reason === "string" ? value.reason : undefined,
    result: isRecord(value.result) ? value.result : undefined,
  };
}

function transition(state: RunState, outcome: IntegrationUatOutcome): RunState {
  const now = new Date().toISOString();
  if (outcome.action === "PASS") {
    return {
      ...state,
      phase: "FINAL_REVIEW",
      status: "running",
      updated_at: now,
    };
  }
  if (outcome.action === "PATCH") {
    if (!state.current_task_id)
      throw new Error("UAT PATCH requires an active task");
    return {
      ...state,
      round: state.round + 1,
      phase: "WORKER",
      status: "running",
      current_task_id: state.current_task_id,
      updated_at: now,
    };
  }
  if (outcome.action === "HUMAN_REQUIRED") {
    if (!outcome.human_question)
      throw new Error("UAT HUMAN_REQUIRED requires a question");
    return {
      ...state,
      phase: "HUMAN_REQUIRED",
      status: "paused",
      failure_reason: outcome.human_question,
      updated_at: now,
    };
  }
  return failState(state, outcome.reason || "Integration UAT failed");
}

/** Run the explicit Integration UAT phase. It is intentionally separate from normal Machine Gate. */
export async function runIntegrationUatPhase(options: {
  projectRoot: string;
  runId: string;
  config?: V3IntegrationUatConfig;
  runUat?: (
    projectRoot: string,
    options: MachineGateOptions
  ) => Promise<MachineGateResult | IntegrationUatOutcome>;
}): Promise<IntegrationUatResult> {
  const root = resolve(options.projectRoot);
  const statePath = runPath(root, options.runId);
  const lock = await acquireActiveWriterLock(root, {
    run_id: options.runId,
    run_state_path: statePath,
  });
  try {
    const state = await loadRunState(statePath);
    assertRunState(state);
    if (state.phase !== "INTEGRATION_UAT" || state.status !== "running")
      throw new Error("Integration UAT requires INTEGRATION_UAT/running state");
    const project = await loadProjectStateFromProject(root);
    assertProjectState(project);
    if (project.current_task_id !== state.current_task_id)
      throw new Error("Integration UAT task identity is inconsistent");
    const roundDir = getRoundDir(
      getChiefRunDir(root, options.runId),
      state.round
    );
    await mkdir(roundDir, { recursive: true });
    const outputPath = artifactPath(root, options.runId, state.round);
    const existing = await readArtifact(outputPath);
    let outcome: IntegrationUatOutcome;
    if (existing) {
      if (
        existing.run_id !== options.runId ||
        existing.round !== state.round ||
        existing.task_id !== state.current_task_id
      )
        throw new Error("integration UAT artifact identity is invalid");
      outcome = normalizeOutcome(existing);
    } else {
      const runner =
        options.runUat ??
        (async (workspaceDir, gateOptions) =>
          runMachineGate(workspaceDir, gateOptions));
      try {
        const raw = await runner(root, {
          commands: options.config?.uat_commands ?? [],
          uatCommands: [],
          timeoutMs: (options.config?.timeout_seconds ?? 1800) * 1000,
          allowedGeneratedPaths: options.config?.gate_allowed_paths ?? [],
        });
        if ("action" in raw)
          outcome = normalizeOutcome(raw as unknown as Record<string, unknown>);
        else {
          const gate = raw as MachineGateResult;
          outcome = gate.passed
            ? {
                action: "PASS",
                result: gate as unknown as Record<string, unknown>,
              }
            : {
                action: "FAILED",
                reason: "Integration UAT command failed",
                result: gate as unknown as Record<string, unknown>,
              };
        }
      } catch (error) {
        outcome = {
          action: "FAILED",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      await writeJsonAtomic(outputPath, {
        version: 1,
        run_id: options.runId,
        round: state.round,
        task_id: state.current_task_id,
        action: outcome.action,
        findings: outcome.findings ?? [],
        human_question: outcome.human_question ?? "",
        human_options: outcome.human_options ?? [],
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.result ? { result: outcome.result } : {}),
        created_at: new Date().toISOString(),
      });
    }
    const next = transition(state, outcome);
    assertRunState(next);
    await saveRunState(statePath, next);
    return { runState: next, outcome };
  } finally {
    await releaseActiveWriterLock(root, lock);
  }
}
