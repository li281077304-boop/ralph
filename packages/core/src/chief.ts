export type ChiefVerdict = "PASS" | "PATCH" | "RETURN" | "HUMAN_REQUIRED";

import type { MachineGateResult } from "./machine-gate.js";

export type ChiefDecision = {
  verdict: ChiefVerdict;
  summary: string;
  reasoning_summary: string;
  worker_task: string;
  human_question: string;
  human_options: string[];
  risk: string;
  next_step: string;
};

export type ExternalChiefVerdict = {
  verdict: ChiefVerdict;
  summary: string;
  worker_task: string;
  human_question: string;
  human_options: string[];
  next_step: string;
  run_id: string;
  iteration: number;
  handoff_hash: string;
  previousGate?: MachineGateResult;
};

/**
 * Parse the Chief's final message as the protocol, never as free-form prose.
 * The adapter may return a little surrounding whitespace, but any prose,
 * missing field, unknown verdict, or wrong field type is rejected. An invalid
 * decision is therefore an explicit orchestration failure and can never turn
 * into a false PASS.
 */
export function parseChiefDecision(text: string): ChiefDecision | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const verdict = record.verdict;
  if (
    verdict !== "PASS" &&
    verdict !== "PATCH" &&
    verdict !== "RETURN" &&
    verdict !== "HUMAN_REQUIRED"
  ) {
    return undefined;
  }
  const strings = [
    "summary",
    "reasoning_summary",
    "worker_task",
    "human_question",
    "risk",
    "next_step",
  ];
  if (!strings.every((key) => typeof record[key] === "string"))
    return undefined;
  if (
    !Array.isArray(record.human_options) ||
    !record.human_options.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  const expectedKeys = new Set([
    "verdict",
    "summary",
    "reasoning_summary",
    "worker_task",
    "human_question",
    "human_options",
    "risk",
    "next_step",
  ]);
  if (Object.keys(record).some((key) => !expectedKeys.has(key)))
    return undefined;
  const decision = {
    verdict,
    summary: record.summary as string,
    reasoning_summary: record.reasoning_summary as string,
    worker_task: record.worker_task as string,
    human_question: record.human_question as string,
    human_options: record.human_options as string[],
    risk: record.risk as string,
    next_step: record.next_step as string,
  } satisfies ChiefDecision;
  if (decision.verdict === "RETURN" && decision.worker_task.trim() === "")
    return undefined;
  if (
    decision.verdict === "HUMAN_REQUIRED" &&
    decision.human_question.trim() === ""
  )
    return undefined;
  return decision;
}

/** Backwards-compatible name for the first experimental protocol helper. */
export const parseChiefReview = parseChiefDecision;
export type ChiefReview = ChiefDecision;

/**
 * Parse the small file-based protocol used when the Chief runs outside this
 * process. It is intentionally a different, smaller schema than the Codex
 * Chief protocol: external ChatGPT cannot patch the local checkout itself.
 */
export function parseExternalChiefVerdict(
  text: string
): ExternalChiefVerdict | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const expectedKeys = new Set([
    "verdict",
    "summary",
    "worker_task",
    "human_question",
    "human_options",
    "next_step",
    "run_id",
    "iteration",
    "handoff_hash",
    "previousGate",
  ]);
  if (Object.keys(record).some((key) => !expectedKeys.has(key)))
    return undefined;
  if (
    record.verdict !== "PASS" &&
    record.verdict !== "PATCH" &&
    record.verdict !== "RETURN" &&
    record.verdict !== "HUMAN_REQUIRED"
  )
    return undefined;
  if (
    typeof record.summary !== "string" ||
    typeof record.worker_task !== "string" ||
    typeof record.human_question !== "string" ||
    typeof record.next_step !== "string" ||
    typeof record.run_id !== "string" ||
    !Number.isInteger(record.iteration) ||
    (record.iteration as number) < 1 ||
    typeof record.handoff_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.handoff_hash) ||
    !Array.isArray(record.human_options) ||
    !record.human_options.every((item) => typeof item === "string")
  )
    return undefined;
  const verdict = {
    verdict: record.verdict,
    summary: record.summary,
    worker_task: record.worker_task,
    human_question: record.human_question,
    human_options: record.human_options,
    next_step: record.next_step,
    run_id: record.run_id,
    iteration: record.iteration as number,
    handoff_hash: record.handoff_hash,
    previousGate: parseExternalGate(record.previousGate),
  } satisfies ExternalChiefVerdict;
  if (record.previousGate !== undefined && !verdict.previousGate)
    return undefined;
  if (verdict.verdict === "PASS" && !verdict.previousGate?.passed)
    return undefined;
  if (
    (verdict.verdict === "RETURN" || verdict.verdict === "PATCH") &&
    verdict.worker_task.trim() === ""
  )
    return undefined;
  if (
    verdict.verdict === "HUMAN_REQUIRED" &&
    verdict.human_question.trim() === ""
  )
    return undefined;
  return verdict;
}

function parseExternalGate(value: unknown): MachineGateResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.passed !== "boolean" || !Array.isArray(record.commands))
    return undefined;
  if (
    !record.commands.every(
      (command) =>
        !!command &&
        typeof command === "object" &&
        !Array.isArray(command) &&
        typeof (command as Record<string, unknown>).command === "string" &&
        ((command as Record<string, unknown>).kind === "required" ||
          (command as Record<string, unknown>).kind === "uat") &&
        (typeof (command as Record<string, unknown>).exitCode === "number" ||
          (command as Record<string, unknown>).exitCode === null) &&
        typeof (command as Record<string, unknown>).stdout === "string" &&
        typeof (command as Record<string, unknown>).stderr === "string" &&
        typeof (command as Record<string, unknown>).durationMs === "number" &&
        typeof (command as Record<string, unknown>).timedOut === "boolean"
    )
  )
    return undefined;
  return value as MachineGateResult;
}

export const parseExternalVerdict = parseExternalChiefVerdict;
