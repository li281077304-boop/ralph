/**
 * Ralph V4 — Product Anchored policy.
 *
 * Every judgement V4 makes about *product* correctness lives here as a pure
 * function, so the supervisor, the chief contract, the run-mode gate and the
 * tests all reach the same verdict from the same evidence.
 *
 * The governing rule (V4 doctrine §1): a lower layer can never override a
 * higher-layer failure. `deriveReleaseReadiness` is the enforcement point — it
 * refuses `RELEASE_READY` unless Machine Gate *and* Product Gate both passed,
 * whatever else is green.
 */

import {
  P0_OBLIGATION_CHAIN,
  PERIPHERAL_WORK_KINDS,
  isSourceOrigin,
  type GateOutcome,
  type GoalDriftCheck,
  type IssuePriority,
  type MachineGateRecord,
  type P0CorruptionKind,
  type P0Obligation,
  type PeripheralWorkKind,
  type ProductEvidence,
  type ProductGateRecord,
  type ProductIssue,
  type ReleaseReadiness,
  type RunJournalEntry,
  type SourceProvenance,
  type SourceOrigin,
  type V4Signal,
} from "./domain.js";

/* ------------------------------------------------------------------ *
 * Gate 3 — release readiness
 * ------------------------------------------------------------------ */

export interface ReleaseReadinessVerdict {
  readiness: ReleaseReadiness;
  /** Human-readable reasons the release is blocked; empty when ready. */
  blockers: string[];
}

/**
 * The only place `RELEASE_READY` is ever produced.
 *
 * `NOT_RUN` is treated exactly like `FAIL` here: an unverified product gate is
 * not a partial pass, it is the absence of the very evidence that would justify
 * a release. This is the inversion V4 exists to make — under V3, machine
 * evidence alone could carry a run to release.
 */
export function deriveReleaseReadiness(
  machine: MachineGateRecord | GateOutcome,
  product: ProductGateRecord | GateOutcome
): ReleaseReadinessVerdict {
  const machineOutcome = typeof machine === "string" ? machine : machine.outcome;
  const productOutcome = typeof product === "string" ? product : product.outcome;

  const blockers: string[] = [];
  if (machineOutcome !== "PASS")
    blockers.push(`MACHINE gate is ${machineOutcome}; a release requires PASS`);
  if (productOutcome !== "PASS")
    blockers.push(
      `PRODUCT gate is ${productOutcome}; machine evidence cannot stand in for a correct artifact`
    );

  return {
    readiness: blockers.length === 0 ? "RELEASE_READY" : "RELEASE_BLOCKED",
    blockers,
  };
}

/* ------------------------------------------------------------------ *
 * Product gate derivation
 * ------------------------------------------------------------------ */

/** The default number of consecutive `NOT_RUN` rounds that forces an anchor. */
export const PRODUCT_ANCHOR_NOT_RUN_THRESHOLD = 2;

export function isP0Issue(issue: ProductIssue): boolean {
  return issue.priority === "P0";
}

export function p0Issues(issues: readonly ProductIssue[]): ProductIssue[] {
  return issues.filter(isP0Issue);
}

/**
 * Turn raw evidence and issues into the Product Gate verdict.
 *
 * Order matters: a P0 corruption issue outranks everything, missing evidence is
 * `NOT_RUN` (not a silent pass), and a failed integrity check fails the gate.
 * Like `v3/gate-evidence.ts`, anything unprovable fails closed.
 */
export function deriveProductGateRecord(
  issues: readonly ProductIssue[],
  evidence?: ProductEvidence
): ProductGateRecord {
  const list = [...issues];

  if (p0Issues(list).length > 0) {
    return {
      level: "PRODUCT",
      outcome: "FAIL",
      evidence,
      issues: list,
      reason: "P0 product corruption recorded",
    };
  }

  if (!evidence) {
    return {
      level: "PRODUCT",
      outcome: "NOT_RUN",
      issues: list,
      reason: "no product evidence recorded; the real artifact was never inspected",
    };
  }

  if (!evidence.exists) {
    return {
      level: "PRODUCT",
      outcome: "FAIL",
      evidence,
      issues: list,
      reason: `artifact not found at ${evidence.artifact_ref}`,
    };
  }

  const failed = evidence.checks.filter((check) => check.outcome === "FAIL");
  if (failed.length > 0) {
    return {
      level: "PRODUCT",
      outcome: "FAIL",
      evidence,
      issues: list,
      reason: `integrity checks failed: ${failed
        .map((check) => check.id)
        .join(", ")}`,
    };
  }

  if (list.some((issue) => issue.priority === "P1" || issue.priority === "P2")) {
    return {
      level: "PRODUCT",
      outcome: "BLOCKED",
      evidence,
      issues: list,
      reason: "P1/P2 product issues are open against the artifact",
    };
  }

  return { level: "PRODUCT", outcome: "PASS", evidence, issues: list };
}

/* ------------------------------------------------------------------ *
 * Product Anchor cadence
 * ------------------------------------------------------------------ */

export interface ProductAnchorRequirement {
  required: boolean;
  signal?: V4Signal;
  reason?: string;
}

/**
 * `PRODUCT_ANCHOR_REQUIRED` fires once the product gate has gone unrun for the
 * threshold number of consecutive rounds. This is the anti-drift stop: a run
 * that has not looked at its own output for two rounds may not keep expanding.
 */
export function evaluateProductAnchorRequirement(
  consecutiveNotRunRounds: number,
  threshold: number = PRODUCT_ANCHOR_NOT_RUN_THRESHOLD
): ProductAnchorRequirement {
  if (consecutiveNotRunRounds >= threshold)
    return {
      required: true,
      signal: "PRODUCT_ANCHOR_REQUIRED",
      reason: `PRODUCT gate has been NOT_RUN for ${consecutiveNotRunRounds} consecutive rounds (threshold ${threshold})`,
    };
  return { required: false };
}

/* ------------------------------------------------------------------ *
 * Goal drift
 * ------------------------------------------------------------------ */

function isPeripheral(kind: string): kind is PeripheralWorkKind {
  return (PERIPHERAL_WORK_KINDS as readonly string[]).includes(kind);
}

export interface GoalDriftInput {
  /** Work kinds performed since the last Product Anchor, newest last. */
  recentWorkKinds: readonly string[];
  /** The current product gate outcome, if one has ever been produced. */
  productGateOutcome?: GateOutcome;
}

/**
 * `GOAL_DRIFT` = recent work only ever maintained the machine, while the
 * product gate is still unverified. Sustained snapshot/mutex/port/packaging
 * polishing is exactly the shape of the incident V4 was written for.
 */
export function evaluateGoalDrift(input: GoalDriftInput): GoalDriftCheck {
  if (input.productGateOutcome === "PASS") return "PASS";
  const work = input.recentWorkKinds;
  if (work.length === 0) return "PASS";
  return work.every(isPeripheral) ? "FAIL" : "PASS";
}

/* ------------------------------------------------------------------ *
 * USER_VALUE_DELTA audit
 * ------------------------------------------------------------------ */

export interface UserValueDeltaAudit {
  ok: boolean;
  reasons: string[];
}

/**
 * Machine evidence is not user value. A delta that only reports test counts,
 * coverage, a refactor or a hash match has said nothing about what the user
 * receives, so it is rejected.
 */
const NON_USER_VALUE_PATTERNS: readonly [RegExp, string][] = [
  [/\bcoverage\b/i, "coverage is machine evidence, not user value"],
  [
    /\b\d+\s+(more\s+)?tests?\b/i,
    "a test count is machine evidence, not user value",
  ],
  [/\btest(s)?\s+(count|suite)\b/i, "a test count is machine evidence"],
  [
    /\brefactor(ed|ing)?\b/i,
    "a refactor is not a user-visible change by itself",
  ],
  [
    /\bhash(es)?\s+(match|matches|matched|consistent|identical|unchanged)\b/i,
    "a hash match is machine evidence",
  ],
  [/覆盖率/, "覆盖率属于机器证据，不是用户价值"],
  [/(增加了?|新增)?\s*\d+\s*个?\s*测试/, "测试数量不是用户价值"],
  [/重构(完成|了)/, "重构本身不是用户可见价值"],
];

export function auditUserValueDelta(text: string): UserValueDeltaAudit {
  const trimmed = text.trim();
  const reasons: string[] = [];
  if (!trimmed) reasons.push("USER_VALUE_DELTA is empty");
  for (const [pattern, reason] of NON_USER_VALUE_PATTERNS)
    if (pattern.test(trimmed)) reasons.push(reason);
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ *
 * Source provenance
 * ------------------------------------------------------------------ */

export interface ProvenanceVerdict {
  valid: boolean;
  signal?: V4Signal;
  reason?: string;
}

/**
 * A generated output fed back in as ordinary input proves nothing about the
 * source material, so it is void unless the run explicitly declares a
 * re-ingestion test.
 */
export function evaluateSourceProvenance(
  provenance: SourceProvenance | undefined,
  options: { reingestionTest?: boolean } = {}
): ProvenanceVerdict {
  if (!provenance)
    return {
      valid: false,
      reason: "no source provenance recorded for this job",
    };
  if (!isSourceOrigin(provenance.origin))
    return {
      valid: false,
      signal: "UAT_INPUT_INVALID",
      reason: `unknown source origin: ${String(provenance.origin)}`,
    };
  if (provenance.origin === "GENERATED_OUTPUT" && !options.reingestionTest)
    return {
      valid: false,
      signal: "UAT_INPUT_INVALID",
      reason:
        "input origin is GENERATED_OUTPUT; a generated result may only be re-ingested by an explicit REINGESTION_TEST",
    };
  return { valid: true };
}

/* ------------------------------------------------------------------ *
 * P0 reprioritisation
 * ------------------------------------------------------------------ */

export interface P0Reprioritisation {
  active: boolean;
  chain: readonly P0Obligation[];
  /** Head of the chain: the obligation that must be worked next. */
  next?: P0Obligation;
}

/**
 * When P0 corruption is present, the obligation order is not a suggestion — it
 * replaces the current plan, and the caller suppresses every work class in
 * `P0_SUPPRESSED_WORK` until the chain completes.
 */
export function deriveP0Reprioritisation(
  issues: readonly ProductIssue[]
): P0Reprioritisation {
  const corruption = p0Issues(issues);
  if (corruption.length === 0)
    return { active: false, chain: P0_OBLIGATION_CHAIN };
  return {
    active: true,
    chain: P0_OBLIGATION_CHAIN,
    next: P0_OBLIGATION_CHAIN[0],
  };
}

/** Corruption kinds present, for the lineage trace to open from. */
export function p0CorruptionKinds(
  issues: readonly ProductIssue[]
): P0CorruptionKind[] {
  return p0Issues(issues)
    .map((issue) => issue.corruption)
    .filter((kind): kind is P0CorruptionKind => Boolean(kind));
}

/* ------------------------------------------------------------------ *
 * Run journal
 * ------------------------------------------------------------------ */

const PRIORITY_ORDER: readonly IssuePriority[] = [
  "P0",
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
];

export function sortIssuesByPriority(
  issues: readonly ProductIssue[]
): ProductIssue[] {
  return [...issues].sort(
    (a, b) =>
      PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)
  );
}

export interface BuildJournalInput {
  round: number;
  sha: string;
  userValueDelta: string;
  machineGate: GateOutcome;
  productArtifact: string;
  productGate: GateOutcome;
  productIssues: readonly ProductIssue[];
  sourceProvenance?: SourceProvenance;
  goalDriftCheck: GoalDriftCheck;
  nextHighestValueAction: string;
}

function renderProvenance(provenance: SourceProvenance | undefined): string {
  if (!provenance) return "none";
  const origin: SourceOrigin = provenance.origin;
  return `${origin} ${provenance.filename} sha256:${provenance.sha256} job:${provenance.job_id} attempt:${provenance.attempt}`;
}

export function buildRunJournalEntry(input: BuildJournalInput): RunJournalEntry {
  return {
    ROUND: input.round,
    SHA: input.sha,
    USER_VALUE_DELTA: input.userValueDelta,
    MACHINE_GATE: input.machineGate,
    PRODUCT_ARTIFACT: input.productArtifact,
    PRODUCT_GATE: input.productGate,
    PRODUCT_ISSUES: sortIssuesByPriority(input.productIssues).map(
      (issue) =>
        `${issue.priority}${issue.corruption ? `/${issue.corruption}` : ""} ${issue.summary}`
    ),
    SOURCE_PROVENANCE: renderProvenance(input.sourceProvenance),
    GOAL_DRIFT_CHECK: input.goalDriftCheck,
    NEXT_HIGHEST_VALUE_ACTION: input.nextHighestValueAction,
  };
}

/** Stable, greppable serialisation of the journal contract. */
export function renderRunJournal(entry: RunJournalEntry): string {
  const issues = entry.PRODUCT_ISSUES.length
    ? entry.PRODUCT_ISSUES.map((issue) => `  - ${issue}`).join("\n")
    : "  - none";
  return [
    `ROUND: ${entry.ROUND}`,
    `SHA: ${entry.SHA}`,
    "",
    `USER_VALUE_DELTA: ${entry.USER_VALUE_DELTA}`,
    "",
    `MACHINE_GATE: ${entry.MACHINE_GATE}`,
    "",
    `PRODUCT_ARTIFACT: ${entry.PRODUCT_ARTIFACT}`,
    "",
    `PRODUCT_GATE: ${entry.PRODUCT_GATE}`,
    "",
    "PRODUCT_ISSUES:",
    issues,
    "",
    `SOURCE_PROVENANCE: ${entry.SOURCE_PROVENANCE}`,
    "",
    `GOAL_DRIFT_CHECK: ${entry.GOAL_DRIFT_CHECK}`,
    "",
    `NEXT_HIGHEST_VALUE_ACTION: ${entry.NEXT_HIGHEST_VALUE_ACTION}`,
  ].join("\n");
}
