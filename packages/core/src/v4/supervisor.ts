/**
 * Ralph V4 — supervisor / obligation integration.
 *
 * V4 does not replace the V3 supervisor or the obligation ledger; it supplies
 * the product-side decision the V3 layer never had. This module is the seam:
 * given one round's gate outcomes, outstanding product issues and the current
 * obligations, it answers what V4 requires of the run and — on P0 — how the
 * obligation list must be reprioritised.
 *
 * Everything here is a pure function over plain data so the runtime wiring in
 * the run-mode slice can call it without touching V3 internals, and the tests
 * can pin the behaviour without a controller loop.
 */

import {
  P0_OBLIGATION_CHAIN,
  P0_SUPPRESSED_WORK,
  type GateOutcome,
  type GoalDriftCheck,
  type P0SuppressedWork,
  type ProductIssue,
  type V4Signal,
} from "./domain.js";
import {
  deriveP0Reprioritisation,
  deriveReleaseReadiness,
  evaluateGoalDrift,
  evaluateProductAnchorRequirement,
  p0CorruptionKinds,
  type P0Reprioritisation,
  type ProductAnchorRequirement,
  type ReleaseReadinessVerdict,
} from "./policy.js";
import type { Obligation } from "../v3/obligations.js";

/**
 * Priority floor for a P0 lineage obligation. V3 sorts by descending numeric
 * priority, so anything above this band wins over ordinary work.
 */
export const P0_OBLIGATION_PRIORITY = 1000;

/** Highest priority an ordinary obligation may hold while P0 is active. */
export const P0_DEMOTED_PRIORITY_CAP =
  P0_OBLIGATION_PRIORITY - P0_OBLIGATION_CHAIN.length - 1;

const P0_SOURCE = "V4_P0_PRODUCT_CORRUPTION";
const P0_OBLIGATION_ID_PREFIX = "v4-p0:";

const P0_STEP_DESCRIPTIONS: Record<string, string> = {
  TRACE_PRODUCT_LINEAGE: "trace the artifact lineage to the first contamination point",
  ROOT_CAUSE: "name the root cause that produced the corruption",
  CHIEF_REVIEW: "have the chief review the root cause and the proposed fix",
  MINIMAL_FIX: "apply the minimal fix that removes the cause",
  PRODUCT_REGRESSION: "add a regression that fails on the corruption",
};

/**
 * Build the P0 obligation chain. Each step depends on the previous one, so the
 * V3 selection logic walks the chain in order rather than picking a step out of
 * sequence.
 */
export function p0ChainObligations(
  round: number,
  issues: readonly ProductIssue[]
): Obligation[] {
  const kinds = p0CorruptionKinds(issues);
  const detail = kinds.length ? ` (${kinds.join(", ")})` : "";
  return P0_OBLIGATION_CHAIN.map((step, index) => ({
    id: `${P0_OBLIGATION_ID_PREFIX}${step}`,
    source: P0_SOURCE,
    description: `${P0_STEP_DESCRIPTIONS[step] ?? step}${index === 0 ? detail : ""}`,
    status: "RUNNABLE",
    priority: P0_OBLIGATION_PRIORITY - index,
    dependencies:
      index === 0
        ? []
        : [`${P0_OBLIGATION_ID_PREFIX}${P0_OBLIGATION_CHAIN[index - 1]}`],
    verification: ["product gate re-run reports PASS on the real artifact"],
    evidence: index === 0 ? kinds.map((kind) => `corruption:${kind}`) : [],
    created_round: round,
    updated_round: round,
  }));
}

/**
 * On P0 the chain replaces the plan: the five lineage obligations go to the
 * front at an unbeatable priority, and every other obligation is capped below
 * them. Without P0 the list is returned untouched.
 *
 * Steps already on the chain keep their recorded progress. Rebuilding them
 * unconditionally would reset a `PASS` step back to `RUNNABLE`, and since each
 * step depends on the previous one the selection logic would pick
 * `TRACE_PRODUCT_LINEAGE` again on every round — the chain would never advance.
 */
export function reprioritiseObligationsForP0(
  obligations: readonly Obligation[],
  issues: readonly ProductIssue[],
  round: number
): Obligation[] {
  if (!deriveP0Reprioritisation(issues).active) return [...obligations];

  const existing = new Map(
    obligations
      .filter((item) => item.id.startsWith(P0_OBLIGATION_ID_PREFIX))
      .map((item) => [item.id, item])
  );
  const chain = p0ChainObligations(round, issues).map((step) => {
    const prior = existing.get(step.id);
    return prior
      ? { ...prior, priority: step.priority, updated_round: round }
      : step;
  });

  const chainIds = new Set(chain.map((item) => item.id));
  const others = obligations
    .filter((item) => !chainIds.has(item.id))
    .map((item) => ({
      ...item,
      priority: Math.min(item.priority ?? 0, P0_DEMOTED_PRIORITY_CAP),
    }));

  return [...chain, ...others];
}

export interface V4RoundInput {
  round: number;
  machineGate: GateOutcome;
  productGate: GateOutcome;
  /** Consecutive rounds the product gate has been `NOT_RUN`. */
  consecutiveProductNotRun: number;
  productIssues: readonly ProductIssue[];
  /** Work kinds performed since the last Product Anchor, newest last. */
  recentWorkKinds: readonly string[];
  obligations: readonly Obligation[];
}

export interface V4RoundDecision {
  round: number;
  release: ReleaseReadinessVerdict;
  anchor: ProductAnchorRequirement;
  goalDrift: GoalDriftCheck;
  p0: P0Reprioritisation;
  /** Work classes V4 puts on hold; empty unless P0 is active. */
  suppressedWork: readonly P0SuppressedWork[];
  /** True when the run must stop expanding development. */
  mustStopExpanding: boolean;
  /** The signal that forced the stop, when one applies. */
  stopSignal?: V4Signal;
  /** Next obligation to work once the list is reprioritised. */
  nextObligationId?: string;
  /** The obligation list after any P0 reprioritisation. */
  obligations: Obligation[];
  /** Why V4 reached this decision, in the order the checks fired. */
  reasons: string[];
}

/**
 * The one decision a V4 round has to make: is the product still the thing being
 * worked on, and if not, what must happen instead.
 *
 * The stop signals are ordered by severity — corruption outranks a missing
 * anchor, which outranks drift — so a run that has several problems in flight
 * is always told the most serious one first.
 */
export function evaluateV4Round(input: V4RoundInput): V4RoundDecision {
  const release = deriveReleaseReadiness(input.machineGate, input.productGate);
  const anchor = evaluateProductAnchorRequirement(
    input.consecutiveProductNotRun
  );
  const goalDrift = evaluateGoalDrift({
    recentWorkKinds: input.recentWorkKinds,
    productGateOutcome: input.productGate,
  });
  const p0 = deriveP0Reprioritisation(input.productIssues);
  const obligations = reprioritiseObligationsForP0(
    input.obligations,
    input.productIssues,
    input.round
  );

  const reasons: string[] = [];
  let stopSignal: V4Signal | undefined;

  if (p0.active) {
    stopSignal = "P0_PRODUCT_CORRUPTION";
    reasons.push(
      `P0 product corruption recorded; release/packaging/performance/UI work is on hold until ${P0_OBLIGATION_CHAIN.join(" -> ")} completes`
    );
  } else if (anchor.required) {
    stopSignal = "PRODUCT_ANCHOR_REQUIRED";
    reasons.push(anchor.reason ?? "product anchor required");
  } else if (goalDrift === "FAIL") {
    stopSignal = "GOAL_DRIFT";
    reasons.push(
      "recent work only maintained the machine while the product gate is unverified"
    );
  }

  for (const blocker of release.blockers) reasons.push(blocker);

  return {
    round: input.round,
    release,
    anchor,
    goalDrift,
    p0,
    suppressedWork: p0.active ? P0_SUPPRESSED_WORK : [],
    mustStopExpanding: stopSignal !== undefined,
    stopSignal,
    nextObligationId: obligations[0]?.id,
    obligations,
    reasons,
  };
}

/** Whether a work class may run this round. */
export function isWorkAllowed(
  kind: P0SuppressedWork,
  decision: V4RoundDecision
): boolean {
  return !decision.suppressedWork.includes(kind);
}
