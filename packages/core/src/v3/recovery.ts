import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { GitGuard, workspaceFingerprint } from "../git-guard.js";
import {
  canonicalizeValue,
  hashProjectState,
  loadProjectStateFromProject,
  saveProjectStateToProject,
} from "./project-plan.js";
import { getChiefRunDir, getRoundDir } from "./rounds.js";
import {
  loadRunState,
  saveRunState,
  type ProjectState,
  type RunState,
} from "./state.js";
import { assertProjectState, assertRunState } from "./state-invariants.js";
import {
  writeJsonAtomic,
  writeJsonImmutable,
  writeTextAtomic,
} from "./atomic-json.js";

export const RECOVERY_OPEN_MARKER = "<<<CHIEF_RECOVERY_JSON>>>";
export const RECOVERY_CLOSE_MARKER = "<<<END_CHIEF_RECOVERY_JSON>>>";

export type RecoveryAction =
  "RETRY_WORKER" | "RUN_MACHINE_GATE" | "HUMAN_REQUIRED";

export interface ChiefRecoveryDecision {
  action: RecoveryAction;
  summary: string;
  technical_diagnosis: string;
  worker_task: string;
  verification_strategy: string[];
  why_previous_approach_failed: string;
  why_next_approach_should_work: string;
  human_question: string;
  human_options: string[];
  human_required_reason: string;
  run_id: string;
  round: number;
  task_id: string;
  worker_block_hash: string;
  project_state_hash: string;
}

const HUMAN_REASON_CATEGORIES = new Set([
  "BUSINESS_DECISION",
  "CREDENTIAL_OR_SECRET",
  "EXTERNAL_AUTHORIZATION",
  "USER_ONLY_INPUT",
  "IRREVERSIBLE_EXTERNAL_ACTION",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sha(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new Error(
      `Invalid Chief RECOVERY decision: ${field} must be SHA-256`
    );
}
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string")
    throw new Error(`Invalid Chief RECOVERY decision: ${field} must be string`);
}
function nonEmpty(value: unknown, field: string): asserts value is string {
  text(value, field);
  if (!value.trim())
    throw new Error(
      `Invalid Chief RECOVERY decision: ${field} must be non-empty`
    );
}
function exactKeys(value: Record<string, unknown>): void {
  const expected = new Set([
    "action",
    "summary",
    "technical_diagnosis",
    "worker_task",
    "verification_strategy",
    "why_previous_approach_failed",
    "why_next_approach_should_work",
    "human_question",
    "human_options",
    "human_required_reason",
    "run_id",
    "round",
    "task_id",
    "worker_block_hash",
    "project_state_hash",
  ]);
  for (const key of Object.keys(value))
    if (!expected.has(key))
      throw new Error(`Invalid Chief RECOVERY decision: unknown field ${key}`);
}

export function parseChiefRecoveryDecision(
  value: unknown
): ChiefRecoveryDecision {
  if (!record(value))
    throw new Error("Invalid Chief RECOVERY decision: object required");
  exactKeys(value);
  if (
    !["RETRY_WORKER", "RUN_MACHINE_GATE", "HUMAN_REQUIRED"].includes(
      String(value.action)
    )
  )
    throw new Error("Invalid Chief RECOVERY decision: action is unknown");
  for (const field of [
    "summary",
    "technical_diagnosis",
    "worker_task",
    "why_previous_approach_failed",
    "why_next_approach_should_work",
    "human_question",
    "human_required_reason",
    "run_id",
    "task_id",
  ])
    text(value[field], field);
  if (
    !Array.isArray(value.verification_strategy) ||
    value.verification_strategy.some((item) => typeof item !== "string")
  )
    throw new Error(
      "Invalid Chief RECOVERY decision: verification_strategy must be strings"
    );
  if (
    !Array.isArray(value.human_options) ||
    value.human_options.some((item) => typeof item !== "string")
  )
    throw new Error(
      "Invalid Chief RECOVERY decision: human_options must be strings"
    );
  if (!Number.isInteger(value.round) || (value.round as number) < 1)
    throw new Error("Invalid Chief RECOVERY decision: round is invalid");
  sha(value.worker_block_hash, "worker_block_hash");
  sha(value.project_state_hash, "project_state_hash");
  if (value.action === "RETRY_WORKER" && !String(value.worker_task).trim())
    throw new Error("RETRY_WORKER requires worker_task");
  if (value.action === "HUMAN_REQUIRED") {
    nonEmpty(value.human_question, "human_question");
    nonEmpty(value.human_required_reason, "human_required_reason");
    const category = String(value.human_required_reason).split(/[:|]/, 1)[0];
    if (!HUMAN_REASON_CATEGORIES.has(category))
      throw new Error("Chief RECOVERY HUMAN_REQUIRED reason is not user-only");
  }
  return value as unknown as ChiefRecoveryDecision;
}

function runPath(root: string, runId: string): string {
  return join(getChiefRunDir(root, runId), "RUN_STATE.json");
}
function roundPath(
  root: string,
  runId: string,
  round: number,
  name: string
): string {
  return join(getRoundDir(getChiefRunDir(root, runId), round), name);
}
function hashBytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

export interface RecoveryPreparation {
  runState: RunState;
  projectState: ProjectState;
  workerBlock: Record<string, unknown>;
  workerBlockHash: string;
  handoff: Record<string, unknown>;
  handoffContent: string;
  handoffPath: string;
}

/** Create (or verify) the durable recovery handoff for the current blocked round. */
export async function prepareChiefRecovery(
  projectRoot: string,
  runId: string
): Promise<RecoveryPreparation> {
  const root = resolve(projectRoot);
  const state = await loadRunState(runPath(root, runId));
  assertRunState(state);
  if (state.phase !== "CHIEF_RECOVERY" || state.status !== "running")
    throw new Error("Chief Recovery requires CHIEF_RECOVERY/running state");
  if (!state.current_task_id)
    throw new Error("Chief Recovery requires current_task_id");
  const project = await loadProjectStateFromProject(root);
  assertProjectState(project);
  if (project.current_task_id !== state.current_task_id)
    throw new Error("Chief Recovery task identity is inconsistent");
  const task = project.tasks.find((item) => item.id === state.current_task_id);
  if (!task || task.status !== "in_progress")
    throw new Error("Chief Recovery requires an in_progress task");
  const blockPath = roundPath(root, runId, state.round, "worker_block.json");
  const blockBytes = await readFile(blockPath);
  const block = JSON.parse(blockBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  if (
    block.version !== 1 ||
    block.run_id !== runId ||
    block.round !== state.round ||
    block.task_id !== task.id ||
    !["blocked", "error"].includes(String(block.goal_status)) ||
    block.human_required !== false
  )
    throw new Error("worker_block.json identity or status is invalid");
  const workerBlockHash = hashBytes(blockBytes);
  const projectStateHash = hashProjectState(project);
  const handoffPath = roundPath(
    root,
    runId,
    state.round,
    "recovery_handoff.md"
  );
  const handoffJsonPath = roundPath(
    root,
    runId,
    state.round,
    "recovery_handoff.json"
  );
  const handoff = {
    version: 1,
    run_id: runId,
    round: state.round,
    task_id: task.id,
    project_state_hash: projectStateHash,
    worker_block_hash: workerBlockHash,
    worker_block: block,
    task,
    previous_context: await previousContext(root, runId, state.round),
  };
  const content = [
    "# Ralph V3 Chief Technical Recovery",
    "",
    "你是技术总工。Worker 的技术阻塞不等于需要人工；请独立检查仓库、当前实现和证据，给出下一步可执行技术动作。",
    "只有真正需要业务决策、凭证、授权或用户独有输入时才可 HUMAN_REQUIRED。",
    "",
    `run_id: ${runId}`,
    `round: ${state.round}`,
    `task_id: ${task.id}`,
    `project_state_hash: ${projectStateHash}`,
    `worker_block_hash: ${workerBlockHash}`,
    "",
    "## PROJECT GOAL",
    project.goal,
    `milestone: ${project.current_milestone}`,
    "",
    "## TASK",
    JSON.stringify(task, null, 2),
    "",
    "## WORKER BLOCK EVIDENCE",
    JSON.stringify(block, null, 2),
    "",
    "## PREVIOUS CHIEF CONTEXT",
    JSON.stringify(handoff.previous_context, null, 2),
    "",
    "返回严格 CHIEF_RECOVERY_JSON 机器区块，不要输出 prose。",
    RECOVERY_OPEN_MARKER,
    JSON.stringify(
      {
        action: "RETRY_WORKER",
        summary: "",
        technical_diagnosis: "",
        worker_task: "",
        verification_strategy: [],
        why_previous_approach_failed: "",
        why_next_approach_should_work: "",
        human_question: "",
        human_options: [],
        human_required_reason: "",
        run_id: runId,
        round: state.round,
        task_id: task.id,
        worker_block_hash: workerBlockHash,
        project_state_hash: projectStateHash,
      },
      null,
      2
    ),
    RECOVERY_CLOSE_MARKER,
  ].join("\n");
  try {
    const existing = await readFile(handoffPath, "utf8");
    if (hashBytes(existing) !== hashBytes(`${content}\n`))
      throw new Error("recovery_handoff.md is immutable and changed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeTextAtomic(handoffPath, `${content}\n`);
  }
  try {
    const existing = await readJson(handoffJsonPath);
    if (
      hashBytes(JSON.stringify(existing)) !== hashBytes(JSON.stringify(handoff))
    )
      throw new Error("recovery_handoff.json is immutable and changed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeJsonImmutable(handoffJsonPath, handoff);
  }
  return {
    runState: state,
    projectState: project,
    workerBlock: block,
    workerBlockHash,
    handoff,
    handoffContent: content,
    handoffPath,
  };
}

async function previousContext(root: string, runId: string, round: number) {
  if (round <= 1) return {};
  const result: Record<string, unknown> = {};
  for (const name of [
    "select_decision.json",
    "review_decision.json",
    "final_review_decision.json",
    "recovery_decision.json",
  ]) {
    try {
      result[name] = await readJson(roundPath(root, runId, round - 1, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}

function runStateHash(state: RunState): string {
  return hashBytes(canonicalizeValue(state));
}

/** Validate and apply one immutable Chief Recovery decision. */
export async function applyChiefRecoveryDecision(
  projectRoot: string,
  runId: string,
  rawDecision: unknown
): Promise<{
  runState: RunState;
  projectState: ProjectState;
  decision: ChiefRecoveryDecision;
}> {
  const root = resolve(projectRoot);
  const path = runPath(root, runId);
  const state = await loadRunState(path);
  const project = await loadProjectStateFromProject(root);
  assertRunState(state);
  assertProjectState(project);
  if (state.phase !== "CHIEF_RECOVERY" || state.status !== "running") {
    const candidateRounds = [state.round, state.round - 1].filter(
      (round) => round >= 1
    );
    try {
      let stored: ChiefRecoveryDecision | undefined;
      let transition: Record<string, unknown> | undefined;
      for (const round of candidateRounds) {
        try {
          stored = parseChiefRecoveryDecision(
            await readJson(
              roundPath(root, runId, round, "recovery_decision.json")
            )
          );
          transition = await readJson(
            roundPath(root, runId, round, "recovery_transition.json")
          );
          break;
        } catch (candidateError) {
          if ((candidateError as NodeJS.ErrnoException).code !== "ENOENT")
            throw candidateError;
        }
      }
      if (!stored || !transition)
        throw Object.assign(new Error("missing recovery transition"), {
          code: "ENOENT",
        });
      if (
        stored.run_id !== runId ||
        transition.decision_hash !== hashBytes(canonicalizeValue(stored)) ||
        transition.after_run_state_hash !==
          runStateHash(transition.after_run_state as RunState) ||
        transition.after_project_state_hash !==
          hashProjectState(transition.after_project_state as ProjectState)
      )
        throw new Error("Chief Recovery transition integrity check failed");
      if (
        rawDecision !== undefined &&
        canonicalizeValue(parseChiefRecoveryDecision(rawDecision)) !==
          canonicalizeValue(stored)
      )
        throw new Error(
          "Chief Recovery decision is immutable and cannot be replaced"
        );
      const currentRunHash = runStateHash(state);
      const currentProjectHash = hashProjectState(project);
      if (
        currentRunHash === transition.before_run_state_hash &&
        currentProjectHash === transition.before_project_state_hash
      ) {
        await saveProjectStateToProject(
          root,
          transition.after_project_state as ProjectState
        );
        await saveRunState(path, transition.after_run_state as RunState);
      } else if (
        currentRunHash !== transition.after_run_state_hash ||
        currentProjectHash !== transition.after_project_state_hash
      ) {
        throw new Error("Chief Recovery state is not recoverable");
      }
      return {
        runState: transition.after_run_state as RunState,
        projectState: transition.after_project_state as ProjectState,
        decision: stored,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(
          "Chief Recovery decision requires CHIEF_RECOVERY/running state"
        );
      throw error;
    }
  }
  const decision = parseChiefRecoveryDecision(rawDecision);
  const blockPath = roundPath(root, runId, state.round, "worker_block.json");
  const blockBytes = await readFile(blockPath);
  const block = JSON.parse(blockBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  const blockHash = hashBytes(blockBytes);
  if (
    decision.run_id !== runId ||
    decision.round !== state.round ||
    decision.task_id !== state.current_task_id ||
    decision.worker_block_hash !== blockHash ||
    decision.project_state_hash !== hashProjectState(project)
  )
    throw new Error("Chief Recovery decision identity/hash mismatch");
  const task = project.tasks.find((item) => item.id === state.current_task_id);
  if (!task || task.status !== "in_progress")
    throw new Error("Chief Recovery task is not in progress");
  if (decision.action === "RUN_MACHINE_GATE") {
    const changed = Array.isArray(block.changed_paths)
      ? block.changed_paths
      : [];
    const violations = Array.isArray(block.violations) ? block.violations : [];
    if (!changed.length || violations.length)
      throw new Error(
        "RUN_MACHINE_GATE requires changed paths and no policy violations"
      );
    const current = new GitGuard(root).snapshot();
    if (
      JSON.stringify(block.after_workspace_fingerprint) !==
      JSON.stringify(workspaceFingerprint(current))
    )
      throw new Error("RUN_MACHINE_GATE workspace fingerprint is stale");
    await writeJsonAtomic(
      roundPath(root, runId, state.round, "worker_evidence.json"),
      {
        version: 1,
        completed: true,
        run_id: runId,
        round: state.round,
        task_id: task.id,
        before: block.before,
        after: block.after,
        changed_paths: changed,
        violations: [],
        after_workspace_fingerprint: block.after_workspace_fingerprint,
        before_branch: block.before_branch,
        after_branch: block.after_branch,
        recovered_from_technical_block: true,
        worker_reported_complete: false,
        created_at: new Date().toISOString(),
      }
    );
  }
  const decisionPath = roundPath(
    root,
    runId,
    state.round,
    "recovery_decision.json"
  );
  await writeJsonImmutable(decisionPath, decision);
  const withoutFailure = { ...state };
  delete withoutFailure.failure_reason;
  let afterRun: RunState;
  let afterProject: ProjectState = project;
  if (decision.action === "RETRY_WORKER") {
    afterRun = {
      ...withoutFailure,
      phase: "WORKER",
      status: "running",
      round: state.round + 1,
      current_task_id: task.id,
      updated_at: new Date().toISOString(),
    };
    afterProject = {
      ...project,
      updated_at: new Date().toISOString(),
      tasks: project.tasks.map((item) =>
        item.id === task.id ? { ...item, updated_round: state.round + 1 } : item
      ),
    };
  } else if (decision.action === "RUN_MACHINE_GATE") {
    afterRun = {
      ...withoutFailure,
      phase: "MACHINE_GATE",
      status: "running",
      updated_at: new Date().toISOString(),
    };
  } else {
    afterRun = {
      ...state,
      phase: "HUMAN_REQUIRED",
      status: "paused",
      failure_reason: decision.human_question,
      updated_at: new Date().toISOString(),
    };
  }
  assertProjectState(afterProject);
  assertRunState(afterRun);
  const transition = {
    version: 1,
    decision_hash: hashBytes(canonicalizeValue(decision)),
    before_project_state_hash: hashProjectState(project),
    after_project_state_hash: hashProjectState(afterProject),
    before_run_state_hash: runStateHash(state),
    after_run_state_hash: runStateHash(afterRun),
    action: decision.action,
    after_project_state: afterProject,
    after_run_state: afterRun,
    created_at: new Date().toISOString(),
  };
  await writeJsonImmutable(
    roundPath(root, runId, state.round, "recovery_transition.json"),
    transition
  );
  await saveProjectStateToProject(root, afterProject);
  await saveRunState(path, afterRun);
  return { runState: afterRun, projectState: afterProject, decision };
}
