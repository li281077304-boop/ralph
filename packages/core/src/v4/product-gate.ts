/**
 * Ralph V4 — product gate execution.
 *
 * The harness stays domain-neutral, so it cannot inspect anyone's artifact
 * itself. What it can do is run a command the project declares and read the
 * verdict back. That command is the project's Product Gate.
 *
 * Contract for the command's stdout (JSON):
 *
 *   {
 *     "evidence": {
 *       "artifact_ref": "out/handout.docx",
 *       "exists": true,
 *       "inspected_by": "agent",
 *       "checks": [{ "id": "recursive-template", "severity": "error", "outcome": "FAIL" }]
 *     },
 *     "issues": [ { "priority": "P0", "summary": "...", "corruption": "RECURSIVE_CONTENT" } ],
 *     "user_value_delta": "the student edition stopped carrying answers"
 *   }
 *
 * `issues` and `user_value_delta` are optional; `evidence` is required.
 *
 * Anything the harness cannot parse is treated as *no evidence* rather than a
 * pass: an unreadable gate is an unrun gate. That is what makes a project
 * without a configured gate advance the `NOT_RUN` counter instead of sailing
 * through.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

import type {
  ProductEvidence,
  ProductIssue,
  ProductIssue as Issue,
} from "./domain.js";

const execAsync = promisify(exec);

export const DEFAULT_PRODUCT_GATE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ProductGatePayload {
  evidence: ProductEvidence;
  issues?: ProductIssue[];
  user_value_delta?: string;
}

export interface ProductGateRunResult {
  /** `COMMAND` when a command was configured, `NONE` when the project declares none. */
  source: "COMMAND" | "NONE";
  payload?: ProductGatePayload;
  /** Set when the command ran but its output could not be used. */
  error?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIssue(value: unknown): ProductIssue | undefined {
  if (!record(value)) return undefined;
  if (typeof value.priority !== "string" || typeof value.summary !== "string")
    return undefined;
  return value as unknown as Issue;
}

/** Strict enough that a malformed gate report never reads as a pass. */
export function parseProductGatePayload(
  text: string
): ProductGatePayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return undefined;
  }
  if (!record(value) || !record(value.evidence)) return undefined;
  const evidence = value.evidence;
  if (
    typeof evidence.artifact_ref !== "string" ||
    typeof evidence.exists !== "boolean" ||
    typeof evidence.inspected_by !== "string" ||
    !Array.isArray(evidence.checks)
  )
    return undefined;

  const issues: ProductIssue[] = [];
  if (value.issues !== undefined) {
    if (!Array.isArray(value.issues)) return undefined;
    for (const item of value.issues) {
      const issue = parseIssue(item);
      if (!issue) return undefined;
      issues.push(issue);
    }
  }

  return {
    evidence: evidence as unknown as ProductEvidence,
    ...(value.issues !== undefined ? { issues } : {}),
    ...(typeof value.user_value_delta === "string"
      ? { user_value_delta: value.user_value_delta }
      : {}),
  };
}

/**
 * Run the project's product gate command, if one is declared.
 *
 * A missing command, a non-zero exit, a timeout and unparseable output all
 * yield `payload: undefined` — the run then has no product evidence, which is
 * recorded as `NOT_RUN` and counts towards the anchor requirement.
 */
export async function runProductGateCommand(
  command: string | undefined,
  cwd: string,
  options: { timeoutMs?: number } = {}
): Promise<ProductGateRunResult> {
  if (!command || command.trim() === "") return { source: "NONE" };

  try {
    const { stdout } = await execAsync(command, {
      cwd,
      timeout: options.timeoutMs ?? DEFAULT_PRODUCT_GATE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    const payload = parseProductGatePayload(stdout);
    if (!payload)
      return {
        source: "COMMAND",
        error: "product gate output was not a usable JSON payload",
      };
    return { source: "COMMAND", payload };
  } catch (error) {
    return {
      source: "COMMAND",
      error: `product gate command failed: ${(error as Error).message}`,
    };
  }
}
