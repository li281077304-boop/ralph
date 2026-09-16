import { readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getChiefRunDir } from "./rounds.js";
import { canonicalizeValue } from "./project-plan.js";
import { writeJsonAtomic, writeTextAtomic } from "./atomic-json.js";

/** Permanent vocabulary. Technical failures are intentionally absent. */
export const HUMAN_CATEGORIES = [
  "BUSINESS_DECISION",
  "CREDENTIAL_OR_SECRET",
  "EXTERNAL_AUTHORIZATION",
  "USER_ONLY_INPUT",
  "SOURCE_CONFIRMATION",
  "IRREVERSIBLE_EXTERNAL_ACTION",
] as const;
export type HumanCategory = (typeof HUMAN_CATEGORIES)[number];

export const HUMAN_SCOPES = ["RUN", "PERIOD", "PERSISTENT"] as const;
export type HumanScope = (typeof HUMAN_SCOPES)[number];

const TECHNICAL_REASON_MARKERS = [
  "IMPLEMENTATION_DIFFICULTY",
  "TEST_FAILURE",
  "BUILD_FAILURE",
  "RUNTIME_CRASH",
  "MISSING_COMMAND",
  "ENVIRONMENT_LIMITATION",
  "UI_AUTOMATION_FAILURE",
  "BROWSER_TECHNICAL_ISSUE",
  "PARSING_FAILURE",
  "DATA_PROCESSING_BUG",
  "AMBIGUOUS_INTERNAL_ARCHITECTURE",
  "GOAL_STALLED",
];

export type HumanRequiredItem = {
  id: string;
  obligation_id: string;
  category: HumanCategory;
  confirmed_facts: string[];
  blocker_reason: string;
  question: string;
  minimum_answer: string;
  options: string[];
  evidence_paths: string[];
  resume_action: string;
  affected_obligations: string[];
  context: Record<string, unknown>;
  scope: HumanScope;
  effective_from?: string;
  effective_to?: string;
  created_at: string;
  status: "OPEN" | "RESOLVED";
  response_id?: string;
};

export type HumanResponse = {
  version: 1;
  id: string;
  run_id: string;
  obligation_id: string;
  human_required_item_id: string;
  answer: string;
  answered_at: string;
  evidence?: string;
  confirmation_type:
    "USER_CONFIRMED" | "USER_PROVIDED_SOURCE" | "USER_APPROVED";
  scope: HumanScope;
  effective_from?: string;
  effective_to?: string;
};

export type HumanBoundaryStatus =
  "RUNNABLE" | "TECHNICAL_OPEN" | "HUMAN_BLOCKED" | "PASS";

export type HumanCandidate = {
  id: string;
  obligation_id: string;
  category: string;
  confirmed_facts?: string[];
  blocker_reason: string;
  question: string;
  minimum_answer: string;
  options?: string[];
  evidence_paths?: string[];
  resume_action: string;
  affected_obligations?: string[];
  context?: Record<string, unknown>;
  scope?: HumanScope;
  effective_from?: string;
  effective_to?: string;
  /** True when Core can resolve this without user input. */
  auto_resolvable?: boolean;
  /** True only when a business/source conflict remains after automation. */
  requires_human_judgment?: boolean;
  /** Technical categories are never compiled into Human Required. */
  technical?: boolean;
};

export type HumanGateCounts = {
  total_count: number;
  pass_count: number;
  runnable_count: number;
  technical_open_count: number;
  human_blocked_count: number;
};

export function isHumanCategory(value: unknown): value is HumanCategory {
  return (
    typeof value === "string" &&
    (HUMAN_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isHumanScope(value: unknown): value is HumanScope {
  return (
    typeof value === "string" &&
    (HUMAN_SCOPES as readonly string[]).includes(value)
  );
}

export function assertHumanCategory(
  value: unknown
): asserts value is HumanCategory {
  if (!isHumanCategory(value)) throw new Error("INVALID_HUMAN_CATEGORY");
}

export function isTechnicalHumanReason(reason: unknown): boolean {
  if (typeof reason !== "string") return false;
  const upper = reason.toUpperCase();
  return TECHNICAL_REASON_MARKERS.some((marker) => upper.includes(marker));
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`HUMAN_REQUIRED_${field}_REQUIRED`);
}

export function validateHumanRequiredItem(
  value: unknown
): asserts value is HumanRequiredItem {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("HUMAN_REQUIRED_ITEM_MALFORMED");
  const item = value as Record<string, unknown>;
  for (const field of [
    "id",
    "obligation_id",
    "blocker_reason",
    "question",
    "minimum_answer",
    "resume_action",
  ])
    nonEmpty(item[field], field);
  assertHumanCategory(item.category);
  if (!isHumanScope(item.scope)) throw new Error("INVALID_HUMAN_SCOPE");
  for (const field of [
    "confirmed_facts",
    "options",
    "evidence_paths",
    "affected_obligations",
  ]) {
    if (
      !Array.isArray(item[field]) ||
      (item[field] as unknown[]).some((entry) => typeof entry !== "string")
    )
      throw new Error(`HUMAN_REQUIRED_${field}_MALFORMED`);
  }
  if (item.status !== "OPEN" && item.status !== "RESOLVED")
    throw new Error("HUMAN_REQUIRED_STATUS_INVALID");
  nonEmpty(item.created_at, "created_at");
  if (Number.isNaN(Date.parse(item.created_at as string)))
    throw new Error("HUMAN_REQUIRED_CREATED_AT_INVALID");
}

export function validateHumanResponse(
  value: unknown
): asserts value is HumanResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("HUMAN_RESPONSE_MALFORMED");
  const response = value as Record<string, unknown>;
  if (response.version !== 1) throw new Error("HUMAN_RESPONSE_VERSION_INVALID");
  for (const field of [
    "id",
    "run_id",
    "obligation_id",
    "human_required_item_id",
    "answer",
    "answered_at",
  ])
    nonEmpty(response[field], field);
  if (Number.isNaN(Date.parse(response.answered_at as string)))
    throw new Error("HUMAN_RESPONSE_ANSWERED_AT_INVALID");
  if (!isHumanScope(response.scope)) throw new Error("INVALID_HUMAN_SCOPE");
  if (
    !["USER_CONFIRMED", "USER_PROVIDED_SOURCE", "USER_APPROVED"].includes(
      String(response.confirmation_type)
    )
  )
    throw new Error("HUMAN_RESPONSE_CONFIRMATION_TYPE_INVALID");
}

/**
 * Deterministically removes candidates that Core can solve itself. This is the
 * only compiler path that may create a final Human Required question.
 */
export function compileMinimalHumanRequired(
  candidates: readonly HumanCandidate[],
  now = new Date().toISOString()
): HumanRequiredItem[] {
  return candidates
    .filter((candidate) => !candidate.technical)
    .filter((candidate) => !candidate.auto_resolvable)
    .filter((candidate) => candidate.requires_human_judgment === true)
    .map((candidate) => {
      assertHumanCategory(candidate.category);
      if (!isHumanScope(candidate.scope ?? "RUN"))
        throw new Error("INVALID_HUMAN_SCOPE");
      const item: HumanRequiredItem = {
        id: candidate.id,
        obligation_id: candidate.obligation_id,
        category: candidate.category,
        confirmed_facts: candidate.confirmed_facts ?? [],
        blocker_reason: candidate.blocker_reason,
        question: candidate.question,
        minimum_answer: candidate.minimum_answer,
        options: candidate.options ?? [],
        evidence_paths: candidate.evidence_paths ?? [],
        resume_action: candidate.resume_action,
        affected_obligations: candidate.affected_obligations ?? [
          candidate.obligation_id,
        ],
        context: candidate.context ?? {},
        scope: candidate.scope ?? "RUN",
        ...(candidate.effective_from
          ? { effective_from: candidate.effective_from }
          : {}),
        ...(candidate.effective_to
          ? { effective_to: candidate.effective_to }
          : {}),
        created_at: now,
        status: "OPEN",
      };
      validateHumanRequiredItem(item);
      return item;
    });
}

/** Filter questions already answered by an applicable durable response. */
export function filterUnresolvedHumanCandidates(
  candidates: readonly HumanCandidate[],
  responses: readonly HumanResponse[],
  context: { runId: string; periodStart?: string; periodEnd?: string }
): HumanCandidate[] {
  const answered = new Set(
    responses
      .filter((response) => humanResponseAppliesTo(response, context))
      .map((response) => response.human_required_item_id)
  );
  return candidates.filter((candidate) => !answered.has(candidate.id));
}

export function evaluateHumanBoundary(
  statuses: readonly HumanBoundaryStatus[]
): HumanGateCounts & { terminal: "DONE" | "WAITING_FOR_HUMAN" | "CONTINUE" } {
  const counts: HumanGateCounts = {
    total_count: statuses.length,
    pass_count: statuses.filter((status) => status === "PASS").length,
    runnable_count: statuses.filter((status) => status === "RUNNABLE").length,
    technical_open_count: statuses.filter(
      (status) => status === "TECHNICAL_OPEN"
    ).length,
    human_blocked_count: statuses.filter((status) => status === "HUMAN_BLOCKED")
      .length,
  };
  const terminal =
    counts.total_count > 0 && counts.pass_count === counts.total_count
      ? "DONE"
      : counts.runnable_count === 0 &&
          counts.technical_open_count === 0 &&
          counts.human_blocked_count > 0
        ? "WAITING_FOR_HUMAN"
        : "CONTINUE";
  return { ...counts, terminal };
}

export function humanResponseAppliesTo(
  response: Pick<
    HumanResponse,
    "run_id" | "scope" | "effective_from" | "effective_to"
  >,
  context: { runId: string; periodStart?: string; periodEnd?: string }
): boolean {
  if (response.scope === "RUN") return response.run_id === context.runId;
  const start = response.effective_from
    ? Date.parse(response.effective_from)
    : Number.NEGATIVE_INFINITY;
  const end = response.effective_to
    ? Date.parse(response.effective_to)
    : Number.POSITIVE_INFINITY;
  if (context.periodStart && Date.parse(context.periodStart) > end)
    return false;
  if (context.periodEnd && Date.parse(context.periodEnd) < start) return false;
  return true;
}

export function humanRequiredPath(root: string, runId: string): string {
  return join(
    getChiefRunDir(resolve(root), runId),
    "human",
    "HUMAN_REQUIRED.json"
  );
}
export function humanRequiredMarkdownPath(root: string, runId: string): string {
  return join(
    getChiefRunDir(resolve(root), runId),
    "human",
    "HUMAN_REQUIRED.md"
  );
}
export function humanResponsesPath(root: string, runId: string): string {
  return join(
    getChiefRunDir(resolve(root), runId),
    "human",
    "HUMAN_RESPONSE.json"
  );
}

export async function persistHumanRequired(
  root: string,
  runId: string,
  items: readonly HumanRequiredItem[]
): Promise<void> {
  items.forEach(validateHumanRequiredItem);
  const path = humanRequiredPath(root, runId);
  await mkdir(join(getChiefRunDir(resolve(root), runId), "human"), {
    recursive: true,
  });
  let merged = [...items];
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as {
      run_id?: string;
      items?: HumanRequiredItem[];
    };
    if (existing.run_id === runId && Array.isArray(existing.items)) {
      const byId = new Map(existing.items.map((item) => [item.id, item]));
      for (const item of items) byId.set(item.id, item);
      merged = [...byId.values()];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJsonAtomic(path, {
    version: 1,
    run_id: runId,
    items: merged,
    updated_at: new Date().toISOString(),
  });
  const lines = ["# HUMAN_REQUIRED", "", `run_id: ${runId}`, ""];
  for (const item of merged) {
    lines.push(
      `## ${item.id}`,
      "",
      `- obligation_id: ${item.obligation_id}`,
      `- category: ${item.category}`,
      `- question: ${item.question}`,
      `- minimum_answer: ${item.minimum_answer}`,
      `- resume_action: ${item.resume_action}`,
      `- evidence_paths: ${item.evidence_paths.join(", ") || "none"}`,
      ""
    );
  }
  await writeTextAtomic(
    humanRequiredMarkdownPath(root, runId),
    `${lines.join("\n")}\n`
  );
}

export async function ingestHumanResponse(
  root: string,
  response: HumanResponse
): Promise<HumanResponse> {
  validateHumanResponse(response);
  const requiredText = await readFile(
    humanRequiredPath(root, response.run_id),
    "utf8"
  );
  const required = JSON.parse(requiredText) as {
    run_id: string;
    items: HumanRequiredItem[];
  };
  if (required.run_id !== response.run_id)
    throw new Error("HUMAN_REQUIRED_RUN_ID_MISMATCH");
  const item = required.items.find(
    (candidate) => candidate.id === response.human_required_item_id
  );
  if (!item || item.obligation_id !== response.obligation_id)
    throw new Error("HUMAN_RESPONSE_BINDING_MISMATCH");
  await persistHumanResponse(root, response);
  item.status = "RESOLVED";
  item.response_id = response.id;
  await persistHumanRequired(root, response.run_id, required.items);
  return response;
}

/** Append an answer as an immutable audit event without requiring a compiled question file. */
export async function persistHumanResponse(
  root: string,
  response: HumanResponse
): Promise<void> {
  validateHumanResponse(response);
  await mkdir(join(getChiefRunDir(resolve(root), response.run_id), "human"), {
    recursive: true,
  });
  let responses: HumanResponse[] = [];
  try {
    responses = JSON.parse(
      await readFile(humanResponsesPath(root, response.run_id), "utf8")
    ) as HumanResponse[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!responses.some((existing) => existing.id === response.id))
    responses.push(response);
  await writeJsonAtomic(humanResponsesPath(root, response.run_id), responses);
}

export function humanResponseAuditValue(response: HumanResponse): string {
  validateHumanResponse(response);
  return canonicalizeValue(response);
}
