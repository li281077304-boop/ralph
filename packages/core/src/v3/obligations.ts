import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getChiefRunDir } from "./rounds.js";
import {
  loadProjectStateFromProject,
  saveProjectStateToProject,
} from "./project-plan.js";
import {
  loadRunState,
  saveRunState,
  type ProjectState,
  type RunState,
} from "./state.js";
import { writeJsonAtomic } from "./atomic-json.js";

export const OBLIGATION_STATUSES = [
  "RUNNABLE",
  "TECHNICAL_OPEN",
  "HUMAN_BLOCKED",
  "PASS",
] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];
export const HUMAN_CATEGORIES = [
  "BUSINESS_DECISION",
  "CREDENTIAL_OR_SECRET",
  "EXTERNAL_AUTHORIZATION",
  "USER_ONLY_INPUT",
  "IRREVERSIBLE_EXTERNAL_ACTION",
] as const;
export type HumanCategory = (typeof HUMAN_CATEGORIES)[number];
/** Canonical five-category vocabulary shared with recovery decisions. */
export const HUMAN_BACKLOG_CATEGORIES = HUMAN_CATEGORIES;
export type HumanBacklogCategory = HumanCategory;

export interface Obligation {
  id: string;
  source: string;
  description: string;
  status: ObligationStatus;
  task_id?: string;
  priority?: number;
  dependencies?: string[];
  verification: string[];
  evidence: string[];
  failure_signature?: string;
  failure_signatures?: string[];
  recovery_attempts?: number;
  resume_context?: Record<string, unknown>;
  blocked_reason?: string;
  human_backlog_id?: string;
  created_round: number;
  updated_round: number;
}

export interface HumanBacklogItem {
  id: string;
  obligation_id: string;
  task_id?: string;
  category: HumanCategory;
  question: string;
  reason: string;
  options: string[];
  context: Record<string, unknown>;
  created_at: string;
  resume_condition: string;
  status: "OPEN" | "RESOLVED";
  resolved_at?: string;
  answer?: string;
}
export interface ObligationLedger {
  version: 1;
  run_id: string;
  obligations: Obligation[];
  updated_at: string;
}
export interface HumanBacklog {
  version: 1;
  run_id: string;
  items: HumanBacklogItem[];
  updated_at: string;
}

function runDir(root: string, runId: string): string {
  return getChiefRunDir(resolve(root), runId);
}
export function obligationsPath(root: string, runId: string): string {
  return join(runDir(root, runId), "OBLIGATIONS.json");
}
export function humanBacklogPath(root: string, runId: string): string {
  return join(runDir(root, runId), "HUMAN_BACKLOG.json");
}

function isCategory(value: unknown): value is HumanCategory {
  return (
    typeof value === "string" &&
    (HUMAN_CATEGORIES as readonly string[]).includes(value)
  );
}
export function isHumanBacklogCategory(
  value: unknown
): value is HumanBacklogCategory {
  return isCategory(value);
}
function assertLedger(value: unknown): asserts value is ObligationLedger {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("OBLIGATIONS.json is malformed");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.run_id !== "string" ||
    !Array.isArray(record.obligations)
  )
    throw new Error("OBLIGATIONS.json identity is malformed");
  for (const item of record.obligations) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("obligation is malformed");
    const obligation = item as Record<string, unknown>;
    if (
      typeof obligation.id !== "string" ||
      !OBLIGATION_STATUSES.includes(obligation.status as ObligationStatus)
    )
      throw new Error("obligation identity or status is invalid");
  }
}

export function summarizeObligations(ledger: ObligationLedger) {
  return ledger.obligations.reduce(
    (counts, item) => {
      counts.total_count += 1;
      if (item.status === "PASS") counts.pass_count += 1;
      if (item.status === "RUNNABLE") counts.runnable_count += 1;
      if (item.status === "TECHNICAL_OPEN") counts.technical_open_count += 1;
      if (item.status === "HUMAN_BLOCKED") counts.human_blocked_count += 1;
      return counts;
    },
    {
      total_count: 0,
      pass_count: 0,
      runnable_count: 0,
      technical_open_count: 0,
      human_blocked_count: 0,
    }
  );
}

export async function loadObligationLedger(
  root: string,
  runId: string
): Promise<ObligationLedger> {
  try {
    const parsed = JSON.parse(
      await readFile(obligationsPath(root, runId), "utf8")
    ) as unknown;
    assertLedger(parsed);
    if (parsed.run_id !== runId)
      throw new Error("OBLIGATIONS.json run identity mismatch");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const project = await loadProjectStateFromProject(root);
    const ledger: ObligationLedger = {
      version: 1,
      run_id: runId,
      obligations: project.tasks.map((task) => ({
        id: `task:${task.id}`,
        source: "PROJECT_STATE",
        description: task.title,
        status:
          task.status === "done"
            ? "PASS"
            : task.status === "blocked"
              ? "HUMAN_BLOCKED"
              : task.status === "in_progress"
                ? "TECHNICAL_OPEN"
                : "RUNNABLE",
        task_id: task.id,
        priority: task.priority,
        dependencies: task.dependencies,
        verification: task.verification,
        evidence: task.evidence,
        ...(task.blocked_reason ? { blocked_reason: task.blocked_reason } : {}),
        created_round: task.created_round,
        updated_round: task.updated_round,
      })),
      updated_at: new Date().toISOString(),
    };
    await saveObligationLedger(root, ledger);
    return ledger;
  }
}
export async function saveObligationLedger(
  root: string,
  ledger: ObligationLedger
): Promise<void> {
  assertLedger(ledger);
  await writeJsonAtomic(obligationsPath(root, ledger.run_id), {
    ...ledger,
    updated_at: new Date().toISOString(),
  });
}

export async function syncObligationsFromProject(
  root: string,
  runId: string
): Promise<ObligationLedger> {
  const ledger = await loadObligationLedger(root, runId);
  const project = await loadProjectStateFromProject(root);
  const next = {
    ...ledger,
    obligations: ledger.obligations.map((item) => {
      const task = item.task_id
        ? project.tasks.find((candidate) => candidate.id === item.task_id)
        : undefined;
      if (!task || item.status === "HUMAN_BLOCKED") return item;
      const status: ObligationStatus =
        task.status === "done"
          ? "PASS"
          : task.status === "queued"
            ? "RUNNABLE"
            : task.status === "in_progress"
              ? "TECHNICAL_OPEN"
              : item.status;
      return { ...item, status, updated_round: task.updated_round };
    }),
  };
  await saveObligationLedger(root, next);
  return next;
}

export async function loadHumanBacklog(
  root: string,
  runId: string
): Promise<HumanBacklog> {
  try {
    const parsed = JSON.parse(
      await readFile(humanBacklogPath(root, runId), "utf8")
    ) as HumanBacklog;
    if (
      parsed.version !== 1 ||
      parsed.run_id !== runId ||
      !Array.isArray(parsed.items)
    )
      throw new Error("HUMAN_BACKLOG.json is malformed");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const backlog: HumanBacklog = {
      version: 1,
      run_id: runId,
      items: [],
      updated_at: new Date().toISOString(),
    };
    await writeJsonAtomic(humanBacklogPath(root, runId), backlog);
    return backlog;
  }
}

export async function addHumanBacklogItem(
  root: string,
  item: Omit<HumanBacklogItem, "status" | "created_at">
): Promise<HumanBacklogItem> {
  if (!isCategory(item.category))
    throw new Error("invalid human backlog category");
  const backlog = await loadHumanBacklog(root, String(item.context.run_id));
  const existing = backlog.items.find((candidate) => candidate.id === item.id);
  if (existing) return existing;
  const created = {
    ...item,
    status: "OPEN" as const,
    created_at: new Date().toISOString(),
  };
  backlog.items.push(created);
  await writeJsonAtomic(humanBacklogPath(root, backlog.run_id), {
    ...backlog,
    updated_at: new Date().toISOString(),
  });
  return created;
}

function categoryFromReason(reason: string): HumanCategory {
  const category = reason.split(/[:|]/, 1)[0];
  if (!isCategory(category))
    throw new Error(
      "human block reason is not one of the five allowed categories"
    );
  return category;
}

export async function markObligationHumanBlocked(
  root: string,
  run: RunState,
  project: ProjectState,
  decision: {
    human_question: string;
    human_required_reason: string;
    human_options: string[];
    human_category?: HumanCategory;
    summary: string;
  }
): Promise<{
  runState: RunState;
  projectState: ProjectState;
  backlog: HumanBacklogItem;
}> {
  if (!run.current_task_id)
    throw new Error("Human block requires current task");
  const obligationId = `task:${run.current_task_id}`;
  const category =
    decision.human_category ??
    categoryFromReason(decision.human_required_reason);
  if (!isCategory(category))
    throw new Error(
      "human block category is not one of the five allowed categories"
    );
  const backlog = await loadHumanBacklog(root, run.run_id);
  const id = `human:${run.run_id}:${obligationId}`;
  const existing = backlog.items.find((item) => item.id === id);
  const item = existing ?? {
    id,
    obligation_id: obligationId,
    task_id: run.current_task_id,
    category,
    question: decision.human_question,
    reason: decision.human_required_reason,
    options: decision.human_options,
    context: {
      run_id: run.run_id,
      round: run.round,
      summary: decision.summary,
    },
    created_at: new Date().toISOString(),
    resume_condition: "Resolve this item to resume the obligation",
    status: "OPEN" as const,
  };
  if (!existing) {
    backlog.items.push(item);
    await writeJsonAtomic(humanBacklogPath(root, run.run_id), {
      ...backlog,
      updated_at: new Date().toISOString(),
    });
  }
  const ledger = await loadObligationLedger(root, run.run_id);
  await saveObligationLedger(root, {
    ...ledger,
    obligations: ledger.obligations.map((entry) =>
      entry.id === obligationId
        ? {
            ...entry,
            status: "HUMAN_BLOCKED",
            blocked_reason: decision.human_required_reason,
            human_backlog_id: id,
            updated_round: run.round,
          }
        : entry
    ),
  });
  const projectState: ProjectState = {
    ...project,
    current_task_id: null,
    updated_at: new Date().toISOString(),
    tasks: project.tasks.map((task) =>
      task.id === run.current_task_id
        ? {
            ...task,
            status: "blocked",
            blocked_reason: decision.human_required_reason,
            updated_round: run.round,
          }
        : task
    ),
  };
  const hasOtherWork = projectState.tasks.some(
    (task) => task.status === "queued" || task.status === "in_progress"
  );
  const runState: RunState = {
    ...run,
    phase: hasOtherWork ? "SELECT" : "HUMAN_REQUIRED",
    status: hasOtherWork ? "running" : "waiting",
    current_task_id: null,
    failure_reason: undefined,
    stop_reason: hasOtherWork
      ? undefined
      : "all remaining obligations are HUMAN_BLOCKED",
    updated_at: new Date().toISOString(),
  };
  return { runState, projectState, backlog: item };
}

export async function resolveHumanBacklogItem(
  root: string,
  runId: string,
  backlogId: string,
  answer: string
): Promise<RunState> {
  const backlog = await loadHumanBacklog(root, runId);
  const item = backlog.items.find((candidate) => candidate.id === backlogId);
  if (!item) throw new Error(`human backlog item not found: ${backlogId}`);
  item.status = "RESOLVED";
  item.answer = answer;
  item.resolved_at = new Date().toISOString();
  await writeJsonAtomic(humanBacklogPath(root, runId), {
    ...backlog,
    updated_at: new Date().toISOString(),
  });
  const ledger = await loadObligationLedger(root, runId);
  await saveObligationLedger(root, {
    ...ledger,
    obligations: ledger.obligations.map((entry) =>
      entry.id === item.obligation_id
        ? {
            ...entry,
            status: "RUNNABLE",
            blocked_reason: undefined,
            human_backlog_id: undefined,
          }
        : entry
    ),
  });
  const project = await loadProjectStateFromProject(root);
  await saveProjectStateToProject(root, {
    ...project,
    current_task_id: null,
    updated_at: new Date().toISOString(),
    tasks: project.tasks.map((task) =>
      task.id === item.task_id
        ? { ...task, status: "queued", blocked_reason: undefined }
        : task
    ),
  });
  const path = join(runDir(root, runId), "RUN_STATE.json");
  const run = await loadRunState(path);
  const ledgerAfter = await loadObligationLedger(root, runId);
  const next: RunState = {
    ...run,
    phase: ledgerAfter.obligations.every((entry) => entry.status === "PASS")
      ? "DONE"
      : "SELECT",
    status: ledgerAfter.obligations.every((entry) => entry.status === "PASS")
      ? "done"
      : "running",
    current_task_id: null,
    stop_reason: undefined,
    updated_at: new Date().toISOString(),
  };
  await saveRunState(path, next);
  return next;
}
