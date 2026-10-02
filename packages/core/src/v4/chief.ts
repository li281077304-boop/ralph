/**
 * Ralph V4 — chief contract.
 *
 * Under V3 the chief could reach a verdict from a diff, a test run and the
 * worker's own summary. That is how a run with a corrupt artifact still earned
 * a PASS. V4 requires two changes:
 *
 * 1. the chief must be *given* the product evidence — machine gate result,
 *    product gate result, Product Anchor, the artifact reference, outstanding
 *    issues and provenance — not merely the code delta; and
 * 2. the chief must return **three separate judgements** (PRODUCT,
 *    ENGINEERING, RELEASE), and an overall PASS requires all three.
 *
 * The parser is fail-closed in the same way as `chief.ts`: prose, a missing
 * field or an unknown verdict is rejected outright, so a malformed chief reply
 * can never collapse into a release approval.
 *
 * Scope: this is the contract the *chief flow* consumes. The afk loop
 * (`loop.ts`) enforces the Product Anchor, Product Gate and P0 stop-loss, but
 * runs no chief stage — so these functions are deliberately not called from
 * there. Wire them where a chief decision is actually taken.
 */

import {
  type MachineGateRecord,
  type ProductAnchor,
  type ProductGateRecord,
  type ProductIssue,
  type SourceProvenance,
} from "./domain.js";
import { p0Issues, sortIssuesByPriority } from "./policy.js";

export const V4_CHIEF_VERDICTS = ["PASS", "PATCH", "BLOCKED"] as const;
export type V4ChiefVerdict = (typeof V4_CHIEF_VERDICTS)[number];

export const V4_CHIEF_DIMENSIONS = ["PRODUCT", "ENGINEERING", "RELEASE"] as const;
export type V4ChiefDimension = (typeof V4_CHIEF_DIMENSIONS)[number];

export type V4ChiefJudgement = {
  PRODUCT: V4ChiefVerdict;
  ENGINEERING: V4ChiefVerdict;
  RELEASE: V4ChiefVerdict;
};

export interface V4ChiefDecision {
  PRODUCT: V4ChiefVerdict;
  ENGINEERING: V4ChiefVerdict;
  RELEASE: V4ChiefVerdict;
  summary: string;
  product_findings: string[];
  engineering_findings: string[];
  release_findings: string[];
  next_step: string;
}

const DECISION_KEYS = new Set([
  "PRODUCT",
  "ENGINEERING",
  "RELEASE",
  "summary",
  "product_findings",
  "engineering_findings",
  "release_findings",
  "next_step",
]);

function isVerdict(value: unknown): value is V4ChiefVerdict {
  return (
    typeof value === "string" &&
    (V4_CHIEF_VERDICTS as readonly string[]).includes(value)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Reject anything that is not the exact three-judgement protocol. */
export function parseV4ChiefDecision(text: string): V4ChiefDecision | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !DECISION_KEYS.has(key)))
    return undefined;
  if (
    !isVerdict(record.PRODUCT) ||
    !isVerdict(record.ENGINEERING) ||
    !isVerdict(record.RELEASE)
  )
    return undefined;
  if (
    typeof record.summary !== "string" ||
    typeof record.next_step !== "string" ||
    !isStringArray(record.product_findings) ||
    !isStringArray(record.engineering_findings) ||
    !isStringArray(record.release_findings)
  )
    return undefined;
  return {
    PRODUCT: record.PRODUCT,
    ENGINEERING: record.ENGINEERING,
    RELEASE: record.RELEASE,
    summary: record.summary,
    product_findings: record.product_findings,
    engineering_findings: record.engineering_findings,
    release_findings: record.release_findings,
    next_step: record.next_step,
  };
}

/** Everything the V4 chief must be handed before it may judge. */
export interface V4ChiefEvidence {
  machine: MachineGateRecord;
  product: ProductGateRecord;
  anchor?: ProductAnchor;
  /** Reference to the newest real artifact / user-facing outcome. */
  artifact_ref?: string;
  outstanding_issues: ProductIssue[];
  provenance?: SourceProvenance;
}

function provenanceLine(provenance: SourceProvenance | undefined): string {
  if (!provenance) return "SOURCE_PROVENANCE: not recorded";
  return `SOURCE_PROVENANCE: ${provenance.origin} ${provenance.filename} sha256:${provenance.sha256} job:${provenance.job_id} attempt:${provenance.attempt}`;
}

/**
 * Render the evidence pack. This is the text a V4 chief is given instead of a
 * bare diff — the point of the slice is that the product evidence is on the
 * record before any verdict is written.
 */
export function renderV4ChiefEvidence(evidence: V4ChiefEvidence): string {
  const issues = sortIssuesByPriority(evidence.outstanding_issues);
  const issueLines = issues.length
    ? issues.map(
        (issue) =>
          `  - ${issue.priority}${issue.corruption ? `/${issue.corruption}` : ""} ${issue.summary}`
      )
    : ["  - none"];
  const checks = evidence.product.evidence?.checks ?? [];
  const checkLines = checks.length
    ? checks.map(
        (check) =>
          `  - ${check.id} ${check.outcome} (${check.severity})${check.reason ? `: ${check.reason}` : ""}`
      )
    : ["  - none"];
  const anchor = evidence.anchor;
  const anchorLines = anchor
    ? [
        `  round ${anchor.round} sha ${anchor.sha}`,
        `  USER_VALUE_DELTA: ${anchor.user_value_delta}`,
        `  PRODUCT_ARTIFACT: ${anchor.product_artifact}`,
        `  PRODUCT_GATE: ${anchor.product_gate}`,
        `  GOAL_DRIFT_CHECK: ${anchor.goal_drift_check}`,
        `  NEXT_HIGHEST_VALUE_ACTION: ${anchor.next_highest_value_action}`,
      ]
    : ["  not recorded"];

  return [
    "MACHINE_GATE:",
    `  outcome ${evidence.machine.outcome}`,
    ...evidence.machine.failures.map((failure) => `  - ${failure}`),
    "",
    "PRODUCT_GATE:",
    `  outcome ${evidence.product.outcome}`,
    `  reason ${evidence.product.reason ?? "n/a"}`,
    "",
    "PRODUCT_ARTIFACT_REF:",
    `  ${evidence.artifact_ref ?? evidence.product.evidence?.artifact_ref ?? "not recorded"}`,
    "",
    "PRODUCT_INTEGRITY_CHECKS:",
    ...checkLines,
    "",
    "PRODUCT_ANCHOR:",
    ...anchorLines,
    "",
    "OUTSTANDING_PRODUCT_ISSUES:",
    ...issueLines,
    "",
    provenanceLine(evidence.provenance),
  ].join("\n");
}

export interface V4ChiefOutcome {
  judgement: V4ChiefJudgement;
  overall: V4ChiefVerdict;
  /** Reasons the original judgement was refused or downgraded. */
  blockers: string[];
  /** True when fail-closed correction changed the chief's own judgement. */
  corrected: boolean;
}

/**
 * Fail-closed evaluation of a chief reply against its evidence.
 *
 * A chief may always be *stricter* than the evidence; it may never be more
 * generous. Any `PASS` the evidence cannot support is downgraded to `BLOCKED`
 * and recorded as a blocker, and the overall verdict is PASS only when all
 * three dimensions survive.
 */
export function evaluateV4ChiefOutcome(
  decision: V4ChiefDecision,
  evidence: V4ChiefEvidence
): V4ChiefOutcome {
  const judgement: V4ChiefJudgement = {
    PRODUCT: decision.PRODUCT,
    ENGINEERING: decision.ENGINEERING,
    RELEASE: decision.RELEASE,
  };
  const blockers: string[] = [];
  let corrected = false;

  const hasProductEvidence = Boolean(
    evidence.product.evidence ?? evidence.artifact_ref
  );
  const failedChecks = (evidence.product.evidence?.checks ?? []).filter(
    (check) => check.outcome === "FAIL"
  );

  // A PASS is only allowed when the evidence itself supports it — presence of
  // evidence is not the same as evidence of correctness.
  if (judgement.PRODUCT === "PASS") {
    if (!hasProductEvidence) {
      judgement.PRODUCT = "BLOCKED";
      blockers.push(
        "PRODUCT PASS refused: no product evidence or artifact reference was available to the chief"
      );
      corrected = true;
    } else if (evidence.product.outcome !== "PASS") {
      judgement.PRODUCT = "BLOCKED";
      blockers.push(
        `PRODUCT PASS refused: the product gate is ${evidence.product.outcome}`
      );
      corrected = true;
    } else if (failedChecks.length > 0) {
      judgement.PRODUCT = "BLOCKED";
      blockers.push(
        `PRODUCT PASS refused: integrity checks failed (${failedChecks
          .map((check) => check.id)
          .join(", ")})`
      );
      corrected = true;
    }
  }

  if (judgement.ENGINEERING === "PASS" && evidence.machine.outcome !== "PASS") {
    judgement.ENGINEERING = "BLOCKED";
    blockers.push(
      `ENGINEERING PASS refused: the MACHINE gate is ${evidence.machine.outcome}`
    );
    corrected = true;
  }

  if (p0Issues(evidence.outstanding_issues).length > 0) {
    if (judgement.PRODUCT === "PASS") {
      judgement.PRODUCT = "BLOCKED";
      blockers.push("PRODUCT PASS refused: a P0 product corruption issue is open");
      corrected = true;
    }
    if (judgement.RELEASE === "PASS") {
      judgement.RELEASE = "BLOCKED";
      blockers.push("RELEASE PASS refused: a P0 product corruption issue is open");
      corrected = true;
    }
  }

  if (judgement.RELEASE === "PASS") {
    if (evidence.machine.outcome !== "PASS") {
      judgement.RELEASE = "BLOCKED";
      blockers.push(
        `RELEASE PASS refused: MACHINE gate is ${evidence.machine.outcome}`
      );
      corrected = true;
    }
    if (evidence.product.outcome !== "PASS") {
      judgement.RELEASE = "BLOCKED";
      blockers.push(
        `RELEASE PASS refused: PRODUCT gate is ${evidence.product.outcome}`
      );
      corrected = true;
    }
    if (!evidence.anchor || evidence.anchor.product_gate !== "PASS") {
      judgement.RELEASE = "BLOCKED";
      blockers.push(
        "RELEASE PASS refused: the Product Anchor does not record a passing product gate"
      );
      corrected = true;
    }
  }

  const dimensions = (["PRODUCT", "ENGINEERING", "RELEASE"] as const).map(
    (dimension) => judgement[dimension]
  );
  const overall: V4ChiefVerdict =
    blockers.length > 0
      ? "BLOCKED"
      : dimensions.every((verdict) => verdict === "PASS")
        ? "PASS"
        : dimensions.includes("BLOCKED")
          ? "BLOCKED"
          : "PATCH";

  return { judgement, overall, blockers, corrected };
}
