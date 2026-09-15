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
  type ProjectTask,
  type RunState,
} from "./state.js";
import { assertProjectState, assertRunState } from "./state-invariants.js";
import {
  writeJsonAtomic,
  writeJsonImmutable,
  writeTextImmutable,
} from "./atomic-json.js";
import {
  isHumanBacklogCategory,
  markObligationHumanBlocked,
  type HumanBacklogCategory,
} from "./obligations.js";

export const RECOVERY_OPEN_MARKER = "<<<CHIEF_RECOVERY_JSON>>>";
export const RECOVERY_CLOSE_MARKER = "<<<END_CHIEF_RECOVERY_JSON>>>";

export const RECOVERY_ACTIONS = [
  "RETRY_WORKER",
  "RUN_MACHINE_GATE",
  "HUMAN_BLOCK",
] as const;
export const HUMAN_REASON_CATEGORIES = [
  "BUSINESS_DECISION",
  "CREDENTIAL_OR_SECRET",
  "EXTERNAL_AUTHORIZATION",
  "USER_ONLY_INPUT",
  "IRREVERSIBLE_EXTERNAL_ACTION",
] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

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
  human_category: HumanBacklogCategory | "";
  run_id: string;
  round: number;
  task_id: string;
  worker_block_hash: string;
  project_state_hash: string;
}

export interface WorkerBlock {
  version: 1;
  run_id: string;
  round: number;
  task_id: string;
  goal_status: "blocked" | "error";
  human_required: boolean;
  failure_kind: "technical" | "human";
  worker_error: string;
  worker_text: string;
  failure_signature: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed_paths: string[];
  violations: unknown[];
  before_branch: string;
  after_branch: string;
  before_workspace_fingerprint: Record<string, unknown>;
  after_workspace_fingerprint: Record<string, unknown>;
  previous_context: Record<string, unknown>;
  created_at: string;
}

export interface PersistWorkerBlockInput extends Omit<
  WorkerBlock,
  "version" | "failure_signature" | "created_at"
> {
  failure_signature?: string;
  created_at?: string;
}

export interface RecoveryHandoff {
  version: 1;
  run_id: string;
  round: number;
  task_id: string;
  project_state_hash: string;
  worker_block_hash: string;
  worker_block: WorkerBlock;
  task: ProjectTask;
  previous_context: Record<string, unknown>;
}

export interface RecoveryPreparation {
  runState: RunState;
  projectState: ProjectState;
  workerBlock: WorkerBlock;
  workerBlockHash: string;
  handoff: RecoveryHandoff;
  handoffContent: string;
  handoffPath: string;
  handoffHash: string;
}

export interface FailureSignatureRecord {
  signature: string;
  first_seen_round: number;
  last_seen_round: number;
  count: number;
  latest_diagnosis?: string;
  latest_strategy?: string[];
}

interface RecoveryTransition {
  version: 1;
  decision_hash: string;
  before_project_state_hash: string;
  after_project_state_hash: string;
  before_run_state_hash: string;
  after_run_state_hash: string;
  action: RecoveryAction;
  after_project_state: ProjectState;
  after_run_state: RunState;
  created_at: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(message: string): never {
  throw new Error(`Invalid Chief RECOVERY decision: ${message}`);
}
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") fail(`${field} must be string`);
}
function nonEmpty(value: unknown, field: string): asserts value is string {
  text(value, field);
  if (!value.trim()) fail(`${field} must be non-empty`);
}
function stringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    fail(`${field} must be an array of strings`);
}
function sha(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    fail(`${field} must be lowercase SHA-256`);
}
function iso(value: unknown, field: string): asserts value is string {
  nonEmpty(value, field);
  if (Number.isNaN(Date.parse(value)))
    fail(`${field} must be an ISO timestamp`);
}
function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) fail(`${label}.${key} is unknown`);
}
function hashBytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
function hashCanonical(value: unknown): string {
  return hashBytes(canonicalizeValue(value));
}
function runStateHash(state: RunState): string {
  assertRunState(state);
  return hashCanonical(state);
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
function workerBlockPath(root: string, runId: string, round: number): string {
  return roundPath(root, runId, round, "worker_block.json");
}
function failureSignaturesPath(root: string, runId: string): string {
  return join(getChiefRunDir(root, runId), "failure-signatures.json");
}
async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return await readJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function writeImmutableJsonChecked(
  path: string,
  value: unknown
): Promise<void> {
  const existing = await readJsonIfExists(path);
  if (existing !== undefined) {
    if (canonicalizeValue(existing) !== canonicalizeValue(value))
      throw new Error(`immutable recovery artifact changed: ${path}`);
    return;
  }
  try {
    await writeJsonImmutable(path, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const concurrent = await readJson(path);
    if (canonicalizeValue(concurrent) !== canonicalizeValue(value))
      throw new Error(`immutable recovery artifact changed: ${path}`);
  }
}
async function writeImmutableTextChecked(
  path: string,
  value: string
): Promise<void> {
  try {
    const existing = await readFile(path, "utf8");
    if (existing !== value)
      throw new Error(`immutable recovery artifact changed: ${path}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await writeTextImmutable(path, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await readFile(path, "utf8")) !== value)
      throw new Error(`immutable recovery artifact changed: ${path}`);
  }
}

/**
 * Normalizes volatile operational details before hashing an error. The hash is
 * stable across temp paths, numeric ids, timestamps, Git object ids, and UUIDs.
 */
export function normalizeFailureSignature(message: string): string {
  return message
    .replace(/\b[0-9a-f]{7,64}\b/gi, "<hash>")
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+/g, "<path>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
}

export function stableFailureSignature(message: string): string {
  return hashBytes(normalizeFailureSignature(message));
}

export async function recordFailureSignature(
  projectRoot: string,
  runId: string,
  round: number,
  signature: string,
  details: { diagnosis?: string; strategy?: string[] } = {}
): Promise<FailureSignatureRecord> {
  const path = failureSignaturesPath(resolve(projectRoot), runId);
  let records: FailureSignatureRecord[] = [];
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      version?: number;
      run_id?: string;
      signatures?: FailureSignatureRecord[];
    };
    if (
      parsed.version !== 1 ||
      parsed.run_id !== runId ||
      !Array.isArray(parsed.signatures)
    )
      throw new Error("failure-signatures.json is malformed");
    records = parsed.signatures;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const existing = records.find((entry) => entry.signature === signature);
  const next: FailureSignatureRecord = existing
    ? {
        ...existing,
        last_seen_round: round,
        count: existing.count + 1,
        ...(details.diagnosis ? { latest_diagnosis: details.diagnosis } : {}),
        ...(details.strategy ? { latest_strategy: details.strategy } : {}),
      }
    : {
        signature,
        first_seen_round: round,
        last_seen_round: round,
        count: 1,
        ...(details.diagnosis ? { latest_diagnosis: details.diagnosis } : {}),
        ...(details.strategy ? { latest_strategy: details.strategy } : {}),
      };
  const output = {
    version: 1,
    run_id: runId,
    signatures: records
      .filter((entry) => entry.signature !== signature)
      .concat(next),
    updated_at: new Date().toISOString(),
  };
  await writeJsonAtomic(path, output);
  return next;
}

function assertWorkerBlock(value: unknown): asserts value is WorkerBlock {
  if (!record(value)) throw new Error("worker_block.json must be an object");
  exactKeys(
    value,
    [
      "version",
      "run_id",
      "round",
      "task_id",
      "goal_status",
      "human_required",
      "failure_kind",
      "worker_error",
      "worker_text",
      "failure_signature",
      "before",
      "after",
      "changed_paths",
      "violations",
      "before_branch",
      "after_branch",
      "before_workspace_fingerprint",
      "after_workspace_fingerprint",
      "previous_context",
      "created_at",
    ],
    "worker_block"
  );
  if (value.version !== 1)
    throw new Error("worker_block.json version is invalid");
  for (const field of [
    "run_id",
    "task_id",
    "worker_error",
    "before_branch",
    "after_branch",
  ])
    nonEmpty(value[field], `worker_block.${field}`);
  if (!Number.isInteger(value.round) || (value.round as number) < 1)
    throw new Error("worker_block.json round is invalid");
  if (value.goal_status !== "blocked" && value.goal_status !== "error")
    throw new Error("worker_block.json goal_status is invalid");
  if (typeof value.human_required !== "boolean")
    throw new Error("worker_block.json human_required is invalid");
  if (value.failure_kind !== "technical" && value.failure_kind !== "human")
    throw new Error("worker_block.json failure_kind is invalid");
  if ((value.failure_kind === "human") !== value.human_required)
    throw new Error(
      "worker_block.json failure_kind and human_required disagree"
    );
  text(value.worker_text, "worker_block.worker_text");
  sha(value.failure_signature, "worker_block.failure_signature");
  const workerError = value.worker_error as string;
  if (value.failure_signature !== stableFailureSignature(workerError))
    throw new Error(
      "worker_block.json failure_signature does not match worker_error"
    );
  for (const field of [
    "before",
    "after",
    "before_workspace_fingerprint",
    "after_workspace_fingerprint",
    "previous_context",
  ])
    if (!record(value[field]))
      throw new Error(`worker_block.${field} must be an object`);
  stringArray(value.changed_paths, "worker_block.changed_paths");
  if (!Array.isArray(value.violations))
    throw new Error("worker_block.violations must be an array");
  iso(value.created_at, "worker_block.created_at");
}

/** Persist one identity-bound worker failure exactly once. */
export async function persistWorkerBlock(
  projectRoot: string,
  input: PersistWorkerBlockInput
): Promise<WorkerBlock> {
  const root = resolve(projectRoot);
  const block: WorkerBlock = {
    ...input,
    version: 1,
    failure_signature:
      input.failure_signature ?? stableFailureSignature(input.worker_error),
    created_at: input.created_at ?? new Date().toISOString(),
  };
  assertWorkerBlock(block);
  const state = await loadRunState(runPath(root, block.run_id));
  const project = await loadProjectStateFromProject(root);
  assertRunState(state);
  assertProjectState(project);
  if (
    state.run_id !== block.run_id ||
    state.round !== block.round ||
    state.current_task_id !== block.task_id ||
    project.current_task_id !== block.task_id
  )
    throw new Error("worker_block.json run, round, or task identity is stale");
  const task = project.tasks.find(
    (candidate) => candidate.id === block.task_id
  );
  if (!task || task.status !== "in_progress")
    throw new Error("worker_block.json requires an in-progress task");
  await writeImmutableJsonChecked(
    workerBlockPath(root, block.run_id, block.round),
    block
  );
  await recordFailureSignature(
    root,
    block.run_id,
    block.round,
    block.failure_signature
  );
  return block;
}

export function parseChiefRecoveryDecision(
  value: unknown
): ChiefRecoveryDecision {
  if (!record(value)) fail("object required");
  exactKeys(
    value,
    [
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
      "human_category",
      "run_id",
      "round",
      "task_id",
      "worker_block_hash",
      "project_state_hash",
    ],
    "decision"
  );
  if (
    typeof value.action !== "string" ||
    !(RECOVERY_ACTIONS as readonly string[]).includes(value.action)
  )
    fail("action is unknown");
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
    "human_category",
  ])
    text(value[field], field);
  stringArray(value.verification_strategy, "verification_strategy");
  stringArray(value.human_options, "human_options");
  if (!Number.isInteger(value.round) || (value.round as number) < 1)
    fail("round is invalid");
  sha(value.worker_block_hash, "worker_block_hash");
  sha(value.project_state_hash, "project_state_hash");
  if (value.action === "RETRY_WORKER") {
    for (const field of [
      "summary",
      "technical_diagnosis",
      "worker_task",
      "why_previous_approach_failed",
      "why_next_approach_should_work",
    ])
      nonEmpty(value[field], field);
  }
  if (value.action === "RUN_MACHINE_GATE") {
    nonEmpty(value.summary, "summary");
    nonEmpty(value.technical_diagnosis, "technical_diagnosis");
  }
  if (value.action === "HUMAN_BLOCK") {
    for (const field of ["summary", "human_question", "human_required_reason"])
      nonEmpty(value[field], field);
    if (!isHumanBacklogCategory(value.human_category))
      fail("human_category is not permitted");
  } else if (value.human_category !== "") {
    fail("human_category is only valid for HUMAN_BLOCK");
  }
  return value as unknown as ChiefRecoveryDecision;
}

async function previousContext(
  root: string,
  runId: string,
  round: number
): Promise<Record<string, unknown>> {
  if (round <= 1) return {};
  const result: Record<string, unknown> = {};
  for (const name of [
    "select_decision.json",
    "review_decision.json",
    "final_review_decision.json",
    "recovery_decision.json",
    "recovery_resume_context.json",
  ]) {
    const value = await readJsonIfExists(
      roundPath(root, runId, round - 1, name)
    );
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function recoveryContent(
  project: ProjectState,
  task: ProjectTask,
  block: WorkerBlock,
  handoff: RecoveryHandoff
): string {
  const template: ChiefRecoveryDecision = {
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
    human_category: "",
    run_id: handoff.run_id,
    round: handoff.round,
    task_id: handoff.task_id,
    worker_block_hash: handoff.worker_block_hash,
    project_state_hash: handoff.project_state_hash,
  };
  return [
    "# Ralph V3 Chief Recovery",
    "",
    "请检查仓库、任务和 Worker 证据，返回严格 CHIEF_RECOVERY_JSON 机器区块，不要输出 prose。",
    "技术失败必须选 RETRY_WORKER 或 RUN_MACHINE_GATE；不得用 HUMAN_BLOCK 逃避技术失败。",
    "HUMAN_BLOCK 仅可用于 Worker 已明确标记为人工所需、并且类别属于五个允许类别之一的情况。",
    "",
    `run_id: ${handoff.run_id}`,
    `round: ${handoff.round}`,
    `task_id: ${handoff.task_id}`,
    `project_state_hash: ${handoff.project_state_hash}`,
    `worker_block_hash: ${handoff.worker_block_hash}`,
    `failure_signature: ${block.failure_signature}`,
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
    "## PREVIOUS CONTEXT",
    JSON.stringify(handoff.previous_context, null, 2),
    "",
    RECOVERY_OPEN_MARKER,
    JSON.stringify(template, null, 2),
    RECOVERY_CLOSE_MARKER,
    "",
  ].join("\n");
}

async function buildRecoveryPreparation(
  projectRoot: string,
  runId: string
): Promise<RecoveryPreparation> {
  const root = resolve(projectRoot);
  const state = await loadRunState(runPath(root, runId));
  const project = await loadProjectStateFromProject(root);
  assertRunState(state);
  assertProjectState(project);
  if (
    state.run_id !== runId ||
    !["CHIEF_RECOVERY", "FAILED"].includes(state.phase) ||
    !["running", "failed"].includes(state.status)
  )
    throw new Error("Chief Recovery requires a CHIEF_RECOVERY/running state");
  if (
    !state.current_task_id ||
    project.current_task_id !== state.current_task_id
  )
    throw new Error("Chief Recovery task identity is inconsistent");
  const task = project.tasks.find((item) => item.id === state.current_task_id);
  if (!task || task.status !== "in_progress")
    throw new Error("Chief Recovery requires an in-progress task");
  const bytes = await readFile(workerBlockPath(root, runId, state.round));
  const block = JSON.parse(bytes.toString("utf8")) as unknown;
  assertWorkerBlock(block);
  if (
    block.run_id !== runId ||
    block.round !== state.round ||
    block.task_id !== task.id
  )
    throw new Error("worker_block.json identity is invalid");
  const handoff: RecoveryHandoff = {
    version: 1,
    run_id: runId,
    round: state.round,
    task_id: task.id,
    project_state_hash: hashProjectState(project),
    worker_block_hash: hashBytes(bytes),
    worker_block: block,
    task,
    previous_context: await previousContext(root, runId, state.round),
  };
  const content = recoveryContent(project, task, block, handoff);
  return {
    runState: state,
    projectState: project,
    workerBlock: block,
    workerBlockHash: handoff.worker_block_hash,
    handoff,
    handoffContent: content,
    handoffPath: roundPath(root, runId, state.round, "recovery_handoff.md"),
    handoffHash: hashCanonical(handoff),
  };
}

/** Create a durable immutable recovery handoff; it contains no write authority. */
export async function prepareChiefRecovery(
  projectRoot: string,
  runId: string
): Promise<RecoveryPreparation> {
  const prepared = await buildRecoveryPreparation(projectRoot, runId);
  const root = resolve(projectRoot);
  await writeImmutableTextChecked(
    prepared.handoffPath,
    prepared.handoffContent
  );
  await writeImmutableJsonChecked(
    roundPath(root, runId, prepared.runState.round, "recovery_handoff.json"),
    prepared.handoff
  );
  return prepared;
}

/**
 * Read the handoff that an external/host transport may send to a Chief. It is
 * deliberately read-only and rejects any state or artifact drift since it was
 * prepared, so a delayed transport cannot submit a stale recovery request.
 */
export async function readFreshChiefRecoveryHandoff(
  projectRoot: string,
  runId: string
): Promise<Readonly<RecoveryPreparation>> {
  const prepared = await buildRecoveryPreparation(projectRoot, runId);
  const root = resolve(projectRoot);
  const [content, json] = await Promise.all([
    readFile(prepared.handoffPath, "utf8"),
    readJson(
      roundPath(root, runId, prepared.runState.round, "recovery_handoff.json")
    ),
  ]);
  if (
    content !== prepared.handoffContent ||
    canonicalizeValue(json) !== canonicalizeValue(prepared.handoff)
  )
    throw new Error("recovery handoff is stale or altered");
  return Object.freeze(prepared);
}

function assertRecoveryTransition(
  value: unknown
): asserts value is RecoveryTransition {
  if (!record(value)) throw new Error("recovery transition is malformed");
  exactKeys(
    value,
    [
      "version",
      "decision_hash",
      "before_project_state_hash",
      "after_project_state_hash",
      "before_run_state_hash",
      "after_run_state_hash",
      "action",
      "after_project_state",
      "after_run_state",
      "created_at",
    ],
    "transition"
  );
  if (value.version !== 1)
    throw new Error("recovery transition version is invalid");
  for (const field of [
    "decision_hash",
    "before_project_state_hash",
    "after_project_state_hash",
    "before_run_state_hash",
    "after_run_state_hash",
  ])
    sha(value[field], `transition.${field}`);
  if (
    typeof value.action !== "string" ||
    !(RECOVERY_ACTIONS as readonly string[]).includes(value.action)
  )
    throw new Error("recovery transition action is invalid");
  assertProjectState(value.after_project_state);
  assertRunState(value.after_run_state);
  iso(value.created_at, "transition.created_at");
}

async function recoverExistingTransition(
  root: string,
  runId: string,
  state: RunState,
  project: ProjectState,
  rawDecision: unknown
): Promise<{
  runState: RunState;
  projectState: ProjectState;
  decision: ChiefRecoveryDecision;
}> {
  const rounds = [
    ...new Set([state.round, state.round - 1].filter((round) => round >= 1)),
  ];
  for (const round of rounds) {
    const decisionValue = await readJsonIfExists(
      roundPath(root, runId, round, "recovery_decision.json")
    );
    const transitionValue = await readJsonIfExists(
      roundPath(root, runId, round, "recovery_transition.json")
    );
    if (decisionValue === undefined && transitionValue === undefined) continue;
    if (decisionValue === undefined || transitionValue === undefined)
      throw new Error("recovery decision/transition pair is incomplete");
    const decision = parseChiefRecoveryDecision(decisionValue);
    assertRecoveryTransition(transitionValue);
    const transition = transitionValue;
    if (
      decision.run_id !== runId ||
      transition.decision_hash !== hashCanonical(decision) ||
      transition.after_project_state_hash !==
        hashProjectState(transition.after_project_state) ||
      transition.after_run_state_hash !==
        runStateHash(transition.after_run_state)
    )
      throw new Error("Chief Recovery transition integrity check failed");
    if (
      rawDecision !== undefined &&
      canonicalizeValue(parseChiefRecoveryDecision(rawDecision)) !==
        canonicalizeValue(decision)
    )
      throw new Error(
        "Chief Recovery decision is immutable and cannot be replaced"
      );
    const currentRunHash = runStateHash(state);
    const currentProjectHash = hashProjectState(project);
    const runIsBefore = currentRunHash === transition.before_run_state_hash;
    const projectIsBefore =
      currentProjectHash === transition.before_project_state_hash;
    const runIsAfter = currentRunHash === transition.after_run_state_hash;
    const projectIsAfter =
      currentProjectHash === transition.after_project_state_hash;
    if ((!runIsBefore && !runIsAfter) || (!projectIsBefore && !projectIsAfter))
      throw new Error("Chief Recovery state is not recoverable");
    if (projectIsBefore)
      await saveProjectStateToProject(root, transition.after_project_state);
    if (runIsBefore)
      await saveRunState(runPath(root, runId), transition.after_run_state);
    return {
      runState: transition.after_run_state,
      projectState: transition.after_project_state,
      decision,
    };
  }
  throw new Error(
    "Chief Recovery decision requires a blocked run with no prior transition"
  );
}

function buildRecoveredGateEvidence(
  block: WorkerBlock,
  task: ProjectTask,
  runId: string,
  round: number
): Record<string, unknown> {
  if (!block.changed_paths.length || block.violations.length)
    throw new Error(
      "RUN_MACHINE_GATE requires changed paths and no policy violations"
    );
  return {
    version: 1,
    completed: true,
    run_id: runId,
    round,
    task_id: task.id,
    before: block.before,
    after: block.after,
    changed_paths: block.changed_paths,
    violations: [],
    after_workspace_fingerprint: block.after_workspace_fingerprint,
    before_branch: block.before_branch,
    after_branch: block.after_branch,
    recovered_from_technical_block: true,
    worker_reported_complete: false,
    created_at: new Date().toISOString(),
  };
}

/**
 * Validate and apply one immutable recovery decision. A technical worker block
 * may only retry work or run the deterministic gate; it cannot enter the human
 * backlog merely because it is inconvenient to repair.
 */
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
  const state = await loadRunState(runPath(root, runId));
  const project = await loadProjectStateFromProject(root);
  assertRunState(state);
  assertProjectState(project);
  if (!(
    state.phase === "CHIEF_RECOVERY" ||
    (state.phase === "FAILED" && state.status === "failed")
  ))
    return recoverExistingTransition(root, runId, state, project, rawDecision);

  const prepared = await prepareChiefRecovery(root, runId);
  const decision = parseChiefRecoveryDecision(rawDecision);
  const {
    workerBlock: block,
    runState: beforeRun,
    projectState: beforeProject,
  } = prepared;
  await recordFailureSignature(
    root,
    runId,
    beforeRun.round,
    block.failure_signature,
    {
      diagnosis: decision.technical_diagnosis,
      strategy: decision.verification_strategy,
    }
  );
  if (
    decision.run_id !== runId ||
    decision.round !== beforeRun.round ||
    decision.task_id !== beforeRun.current_task_id ||
    decision.worker_block_hash !== prepared.workerBlockHash ||
    decision.project_state_hash !== hashProjectState(beforeProject)
  )
    throw new Error("Chief Recovery decision identity/hash mismatch");
  const task = beforeProject.tasks.find(
    (item) => item.id === beforeRun.current_task_id
  );
  if (!task || task.status !== "in_progress")
    throw new Error("Chief Recovery task is not in progress");
  if (decision.action === "HUMAN_BLOCK" && block.failure_kind === "technical")
    throw new Error("technical worker failures cannot HUMAN_BLOCK");
  if (decision.action === "HUMAN_BLOCK" && !block.human_required)
    throw new Error(
      "HUMAN_BLOCK requires explicit worker human_required evidence"
    );

  if (decision.action === "RUN_MACHINE_GATE") {
    const current = new GitGuard(root).snapshot();
    if (
      canonicalizeValue(block.after_workspace_fingerprint) !==
      canonicalizeValue(workspaceFingerprint(current))
    )
      throw new Error("RUN_MACHINE_GATE workspace fingerprint is stale");
    await writeJsonAtomic(
      roundPath(root, runId, beforeRun.round, "worker_evidence.json"),
      buildRecoveredGateEvidence(block, task, runId, beforeRun.round)
    );
  }

  const decisionPath = roundPath(
    root,
    runId,
    beforeRun.round,
    "recovery_decision.json"
  );
  await writeImmutableJsonChecked(decisionPath, decision);
  const { failure_reason: _failureReason, ...withoutFailure } = beforeRun;
  let afterRun: RunState;
  let afterProject: ProjectState = beforeProject;
  if (decision.action === "RETRY_WORKER") {
    afterRun = {
      ...withoutFailure,
      phase: "WORKER",
      status: "running",
      round: beforeRun.round + 1,
      current_task_id: task.id,
      updated_at: new Date().toISOString(),
    };
    afterProject = {
      ...beforeProject,
      updated_at: new Date().toISOString(),
      tasks: beforeProject.tasks.map((item) =>
        item.id === task.id ? { ...item, updated_round: afterRun.round } : item
      ),
    };
  } else if (decision.action === "RUN_MACHINE_GATE") {
    afterRun = {
      ...withoutFailure,
      phase: "MACHINE_GATE",
      status: "running",
      current_task_id: task.id,
      updated_at: new Date().toISOString(),
    };
  } else {
    const human = await markObligationHumanBlocked(
      root,
      beforeRun,
      beforeProject,
      {
        ...decision,
        human_category: decision.human_category || undefined,
      }
    );
    afterRun = human.runState;
    afterProject = human.projectState;
  }
  assertProjectState(afterProject);
  assertRunState(afterRun);
  const transition: RecoveryTransition = {
    version: 1,
    decision_hash: hashCanonical(decision),
    before_project_state_hash: hashProjectState(beforeProject),
    after_project_state_hash: hashProjectState(afterProject),
    before_run_state_hash: runStateHash(beforeRun),
    after_run_state_hash: runStateHash(afterRun),
    action: decision.action,
    after_project_state: afterProject,
    after_run_state: afterRun,
    created_at: new Date().toISOString(),
  };
  if (decision.action === "RETRY_WORKER") {
    await writeImmutableJsonChecked(
      roundPath(root, runId, afterRun.round, "recovery_resume_context.json"),
      {
        version: 1,
        run_id: runId,
        round: afterRun.round,
        task_id: task.id,
        recovered_round: beforeRun.round,
        decision_hash: transition.decision_hash,
        worker_block_hash: prepared.workerBlockHash,
        failure_signature: block.failure_signature,
        worker_task: decision.worker_task,
        verification_strategy: decision.verification_strategy,
        why_previous_approach_failed: decision.why_previous_approach_failed,
        why_next_approach_should_work: decision.why_next_approach_should_work,
        created_at: new Date().toISOString(),
      }
    );
  }
  await writeImmutableJsonChecked(
    roundPath(root, runId, beforeRun.round, "recovery_transition.json"),
    transition
  );
  await saveProjectStateToProject(root, afterProject);
  await saveRunState(runPath(root, runId), afterRun);
  return { runState: afterRun, projectState: afterProject, decision };
}
