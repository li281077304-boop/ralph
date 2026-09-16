import { createHash } from "node:crypto";

/**
 * The permanent required-gate evidence contract.
 *
 * A Machine Gate may only advance the run when every configured REQUIRED
 * command has a durable, well-formed, actually-executed result with
 * `exitCode === 0` and `timedOut === false`. Policy success is a separate,
 * strictly weaker signal and must never be able to stand in for command
 * evidence; `policy_passed: true` therefore never rescues a failed command.
 *
 * This module is deliberately free of Git/process concerns so that every
 * consumer (gate phase, checkpoint phase, review verification, tests) shares
 * one authority for the judgement instead of re-deriving it.
 */

export type GateEvidenceFailureCode =
  | "GATE_EVIDENCE_MISSING"
  | "GATE_EVIDENCE_MALFORMED"
  | "REQUIRED_COMMAND_NOT_EXECUTED"
  | "REQUIRED_COMMAND_FAILED"
  | "REQUIRED_COMMAND_TIMEOUT"
  | "REQUIRED_COMMAND_LIST_MISMATCH";

export type GateEvidenceFailure = {
  code: GateEvidenceFailureCode;
  command?: string;
  detail: string;
};

export type RequiredGateVerdict = {
  ok: boolean;
  /** Normalized required commands the run currently demands. */
  configured: string[];
  /** Required commands that have a well-formed recorded result. */
  executed: string[];
  failures: GateEvidenceFailure[];
  /** Stable fingerprint of the failures, for recovery/crash-loop dedupe. */
  signature: string;
};

/**
 * Raised when a gate artifact simply predates the required-evidence contract,
 * so a caller may deterministically re-run the gate instead of silently
 * trusting weaker evidence. Explicit failures never use this error.
 */
export class MissingRequiredGateEvidenceError extends Error {
  readonly code = "MISSING_REQUIRED_GATE_EVIDENCE";
  constructor(message: string) {
    super(message);
    this.name = "MissingRequiredGateEvidenceError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRequiredCommands(
  commands: readonly string[] | undefined
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of commands ?? []) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function signatureOf(failures: GateEvidenceFailure[]): string {
  const canonical = failures
    .map((failure) => `${failure.code}:${failure.command ?? ""}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Decide whether durable gate evidence proves that every required command
 * actually ran and passed. Anything unprovable fails closed.
 */
export function evaluateRequiredGateEvidence(
  artifact: unknown,
  requiredCommands: readonly string[] | undefined
): RequiredGateVerdict {
  const configured = normalizeRequiredCommands(requiredCommands);
  const failures: GateEvidenceFailure[] = [];
  const executed: string[] = [];
  const verdict = (): RequiredGateVerdict => ({
    ok: failures.length === 0,
    configured,
    executed,
    failures,
    signature: signatureOf(failures),
  });

  if (!record(artifact)) {
    failures.push({
      code: "GATE_EVIDENCE_MISSING",
      detail: "Machine Gate evidence is missing or is not a JSON object",
    });
    return verdict();
  }
  if (!Array.isArray(artifact.commands)) {
    failures.push({
      code: "GATE_EVIDENCE_MALFORMED",
      detail: "Machine Gate evidence has no `commands` array",
    });
    return verdict();
  }

  const requiredEntries = new Map<string, Record<string, unknown>>();
  for (const [index, entry] of artifact.commands.entries()) {
    if (!record(entry)) {
      failures.push({
        code: "GATE_EVIDENCE_MALFORMED",
        detail: `commands[${index}] is not an object`,
      });
      continue;
    }
    const command =
      typeof entry.command === "string" ? entry.command.trim() : "";
    if (!command) {
      failures.push({
        code: "GATE_EVIDENCE_MALFORMED",
        detail: `commands[${index}].command is not a non-empty string`,
      });
      continue;
    }
    if (entry.kind !== "required" && entry.kind !== "uat") {
      failures.push({
        code: "GATE_EVIDENCE_MALFORMED",
        command,
        detail: `commands[${index}].kind is not required/uat`,
      });
      continue;
    }
    if (
      entry.exitCode !== null &&
      (typeof entry.exitCode !== "number" || !Number.isInteger(entry.exitCode))
    ) {
      failures.push({
        code: "GATE_EVIDENCE_MALFORMED",
        command,
        detail: `commands[${index}].exitCode is neither an integer nor null`,
      });
      continue;
    }
    if (typeof entry.timedOut !== "boolean") {
      failures.push({
        code: "GATE_EVIDENCE_MALFORMED",
        command,
        detail: `commands[${index}].timedOut is not a boolean`,
      });
      continue;
    }
    if (entry.kind === "required") {
      executed.push(command);
      if (!requiredEntries.has(command)) requiredEntries.set(command, entry);
    }
  }
  if (failures.length) return verdict();

  // The required set is the union of what the run demands and what the gate
  // actually recorded as required. A superset is tolerated (a gate may report
  // extra work it performed) but it can never hide a failure, and a configured
  // command that has no recorded result is always fatal.
  const effective = [...configured];
  for (const command of requiredEntries.keys())
    if (!effective.includes(command)) effective.push(command);
  if (Array.isArray(artifact.required_commands)) {
    const recorded = normalizeRequiredCommands(
      artifact.required_commands.filter(
        (item): item is string => typeof item === "string"
      )
    );
    if (
      recorded.length !== configured.length ||
      recorded.some((command, index) => command !== configured[index])
    )
      failures.push({
        code: "REQUIRED_COMMAND_LIST_MISMATCH",
        detail: `gate recorded required commands [${recorded.join(", ")}] but the run now requires [${configured.join(", ")}]`,
      });
  }

  for (const command of effective) {
    const entry = requiredEntries.get(command);
    if (!entry) {
      failures.push({
        code: "REQUIRED_COMMAND_NOT_EXECUTED",
        command,
        detail: "required command has no recorded result",
      });
      continue;
    }
    if (entry.timedOut === true) {
      failures.push({
        code: "REQUIRED_COMMAND_TIMEOUT",
        command,
        detail: "required command timed out",
      });
      continue;
    }
    if (entry.exitCode !== 0)
      failures.push({
        code: "REQUIRED_COMMAND_FAILED",
        command,
        detail: `required command exited with ${String(entry.exitCode)}`,
      });
  }

  return verdict();
}

export function requiredGateFailureSummary(
  verdict: RequiredGateVerdict
): string {
  if (verdict.ok) return "required gate commands passed";
  return verdict.failures
    .map(
      (failure) =>
        `${failure.code}${failure.command ? `(${failure.command})` : ""}`
    )
    .join(", ");
}

/**
 * Checkpoint-boundary assertion. A checkpoint may never be created, committed
 * or pushed unless the durable gate artifact itself attests that the required
 * commands passed and lists no failures.
 */
export function assertCheckpointGateEvidence(artifact: unknown): void {
  if (!record(artifact)) {
    throw new MissingRequiredGateEvidenceError(
      "Machine Gate evidence is missing; refusing to checkpoint"
    );
  }
  if (artifact.required_gate_passed === undefined) {
    throw new MissingRequiredGateEvidenceError(
      "Machine Gate evidence predates the required-command contract; refusing to checkpoint"
    );
  }
  if (artifact.required_gate_passed !== true)
    throw new Error(
      `Machine Gate required commands did not pass; refusing to checkpoint (${formatRecordedFailures(artifact.required_gate_failures)})`
    );
  if (!Array.isArray(artifact.required_gate_failures))
    throw new Error(
      "Machine Gate required-command evidence is malformed; refusing to checkpoint"
    );
  if (artifact.required_gate_failures.length > 0)
    throw new Error(
      `Machine Gate recorded required-command failures but reported success; refusing to checkpoint (${formatRecordedFailures(artifact.required_gate_failures)})`
    );
}

function formatRecordedFailures(value: unknown): string {
  if (!Array.isArray(value)) return "no failure detail recorded";
  const parts = value
    .map((item) => (record(item) ? String(item.code ?? "UNKNOWN") : "UNKNOWN"))
    .filter(Boolean);
  return parts.length ? parts.join(", ") : "no failure detail recorded";
}
