/**
 * Ralph V4 — the per-round runtime.
 *
 * This is where the V4 layer stops being a library and starts changing what a
 * run does. One call per iteration:
 *
 *   1. run the project's declared Product Gate command (or record that none is
 *      declared — an unrun gate is not a passing one);
 *   2. derive the Product Gate verdict from the evidence;
 *   3. persist a Product Anchor, which is what advances the durable
 *      `NOT_RUN` counter the preflight gate reads;
 *   4. persist the run-journal entry;
 *   5. decide what V4 requires next (stop expanding, reprioritise to the P0
 *      lineage chain, or carry on).
 *
 * Steps 3 and 4 are the reason this module exists: without a runtime writer the
 * anchor counter never advances and the whole control plane is inert.
 */

import { P0_OBLIGATION_CHAIN, type GateOutcome, type ProductAnchor } from "./domain.js";
import type { ProductAnchorRecord } from "./anchor-store.js";
import { recordAnchor } from "./anchor-store.js";
import { recordJournalEntry } from "./journal.js";
import {
  deriveP0Reprioritisation,
  deriveProductGateRecord,
  evaluateGoalDrift,
  evaluateSourceProvenance,
  sortIssuesByPriority,
} from "./policy.js";
import {
  runProductGateCommand,
  type ProductGateRunResult,
} from "./product-gate.js";
import { evaluateV4Round, type V4RoundDecision } from "./supervisor.js";
import type { ProductGateRecord, RunJournalEntry } from "./domain.js";

export interface V4RuntimeOptions {
  /** Host repo the run works in; holds the anchor record and journal. */
  workspaceDir: string;
  runId: string;
  /**
   * Command whose stdout is the Product Gate payload. When absent the round has
   * no product evidence and is recorded `NOT_RUN`.
   */
  productGateCommand?: string;
  productGateTimeoutMs?: number;
}

export interface V4RoundRequest {
  round: number;
  sha: string;
  machineGate: GateOutcome;
  /** Work kinds performed since the last anchor; drives the drift check. */
  recentWorkKinds?: readonly string[];
}

export interface V4RoundOutcome {
  decision: V4RoundDecision;
  productGate: ProductGateRecord;
  anchor: ProductAnchor;
  journal: RunJournalEntry;
  record: ProductAnchorRecord;
  productGateSource: ProductGateRunResult["source"];
  productGateError?: string;
}

function nextActionFor(
  hasP0: boolean,
  outcome: GateOutcome
): string {
  if (hasP0)
    return `${P0_OBLIGATION_CHAIN[0]}: trace the artifact lineage to the first contamination point`;
  switch (outcome) {
    case "PASS":
      return "continue the next highest-value product work";
    case "NOT_RUN":
      return "run the product gate and inspect the real artifact";
    default:
      return "fix the product gate failure and re-inspect the artifact";
  }
}

/**
 * Run one V4 round. Persisting happens before the decision is returned, so a
 * crashed run still leaves the anchor and journal behind for the next start.
 */
export async function runV4Round(
  options: V4RuntimeOptions,
  request: V4RoundRequest
): Promise<V4RoundOutcome> {
  const gate = await runProductGateCommand(
    options.productGateCommand,
    options.workspaceDir,
    { timeoutMs: options.productGateTimeoutMs ?? productGateTimeoutFromEnv() }
  );

  // An unusable source provenance voids the run's product evidence: a result
  // produced from a previous generation proves nothing about the source.
  const provenance = gate.payload?.evidence?.provenance;
  const provenanceVerdict = evaluateSourceProvenance(provenance);
  const issues = [...(gate.payload?.issues ?? [])];
  if (provenanceVerdict.signal === "UAT_INPUT_INVALID")
    issues.push({
      priority: "P1",
      summary: `UAT_INPUT_INVALID: ${provenanceVerdict.reason ?? "source provenance is not usable"}`,
    });

  const productGate = deriveProductGateRecord(issues, gate.payload?.evidence);
  const recentWorkKinds = request.recentWorkKinds ?? [];
  const goalDrift = evaluateGoalDrift({
    recentWorkKinds,
    productGateOutcome: productGate.outcome,
  });
  const p0 = deriveP0Reprioritisation(issues);

  const anchor: ProductAnchor = {
    round: request.round,
    sha: request.sha,
    user_value_delta:
      gate.payload?.user_value_delta?.trim() ||
      "no user-visible change recorded this round",
    product_artifact:
      gate.payload?.evidence?.artifact_ref ?? "no artifact produced this round",
    product_gate: productGate.outcome,
    product_issues: sortIssuesByPriority(issues).map(
      (issue) => `${issue.priority} ${issue.summary}`
    ),
    goal_drift_check: goalDrift,
    next_highest_value_action: nextActionFor(p0.active, productGate.outcome),
  };

  const record = await recordAnchor(options.workspaceDir, anchor, options.runId);

  const decision = evaluateV4Round({
    round: request.round,
    machineGate: request.machineGate,
    productGate: productGate.outcome,
    consecutiveProductNotRun: record.consecutive_product_not_run,
    productIssues: issues,
    recentWorkKinds,
    obligations: [],
  });

  const journal = await recordJournalEntry(options.workspaceDir, options.runId, {
    round: request.round,
    sha: request.sha,
    userValueDelta: anchor.user_value_delta,
    machineGate: request.machineGate,
    productArtifact: anchor.product_artifact,
    productGate: productGate.outcome,
    productIssues: issues,
    sourceProvenance: gate.payload?.evidence?.provenance,
    goalDriftCheck: goalDrift,
    nextHighestValueAction: anchor.next_highest_value_action,
  });

  return {
    decision,
    productGate,
    anchor,
    journal,
    record,
    productGateSource: gate.source,
    productGateError: gate.error,
  };
}

/** The product gate command a run declares, if any. */
export function productGateCommandFromEnv(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const command = env.RALPH_V4_PRODUCT_GATE;
  return command && command.trim() !== "" ? command : undefined;
}

export const DEFAULT_V4_RUN_ID = "default";

/** Optional override for how long a Product Gate command may run. */
export function productGateTimeoutFromEnv(
  env: Record<string, string | undefined> = process.env
): number | undefined {
  const raw = env.RALPH_V4_PRODUCT_GATE_TIMEOUT_MS;
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The run id V4 persists under; matches the V3 chief-run identity. */
export function resolveV4RunId(
  env: Record<string, string | undefined> = process.env
): string {
  const id = env.RALPH_RUN_ID;
  return id && id.trim() !== "" ? id.trim() : DEFAULT_V4_RUN_ID;
}
