/**
 * Ralph V4 — Product Anchored domain model.
 *
 * V4 stacks a *product correctness control plane* on top of the V3
 * orchestration. It does not rewrite V3: the machine gate, chief, obligations,
 * recovery, supervisor and devlog all stay where they are. What V4 adds is a
 * vocabulary for the one thing V3 could not express — whether the artifact the
 * user finally receives is actually correct.
 *
 * This module is the single authority for that vocabulary: gate levels and
 * outcomes, product evidence, source provenance, product issues, P0 corruption,
 * and the Product Anchor. It is deliberately free of Git, process and
 * filesystem concerns (mirroring the discipline of `v3/gate-evidence.ts`) so
 * that the supervisor, the chief contract, the run-mode parser and the tests
 * all share one definition instead of re-deriving it.
 *
 * Nothing here changes V3 behaviour. V4 is opt-in: these types are only
 * consulted when the run declares `RUN_MODE: RALPH_V4`.
 */

/* ------------------------------------------------------------------ *
 * Gate levels and outcomes
 * ------------------------------------------------------------------ */

/**
 * The three gates, in the order their evidence outranks one another. A lower
 * gate passing may never be used to excuse a higher gate failing.
 */
export const GATE_LEVELS = ["MACHINE", "PRODUCT", "RELEASE"] as const;
export type GateLevel = (typeof GATE_LEVELS)[number];

/**
 * `NOT_RUN` and `BLOCKED` are first-class outcomes, not errors to be swallowed:
 * an unrun product gate is what let V3 advance to Release on machine evidence
 * alone.
 */
export const GATE_OUTCOMES = ["PASS", "FAIL", "NOT_RUN", "BLOCKED"] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

export function isGateOutcome(value: unknown): value is GateOutcome {
  return (
    typeof value === "string" &&
    (GATE_OUTCOMES as readonly string[]).includes(value)
  );
}

export const RELEASE_READINESS = ["RELEASE_READY", "RELEASE_BLOCKED"] as const;
export type ReleaseReadiness = (typeof RELEASE_READINESS)[number];

/* ------------------------------------------------------------------ *
 * Source provenance
 * ------------------------------------------------------------------ */

/**
 * Where a test/UAT input came from. `GENERATED_OUTPUT` is the dangerous one: a
 * generated result fed back in as input makes a run prove nothing about the
 * source material.
 */
export const SOURCE_ORIGINS = [
  "ORIGINAL_SOURCE",
  "GOLD_SOURCE",
  "GENERATED_OUTPUT",
  "RUNTIME_COPY",
  "UAT_FIXTURE",
  "UNKNOWN",
] as const;
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

export function isSourceOrigin(value: unknown): value is SourceOrigin {
  return (
    typeof value === "string" &&
    (SOURCE_ORIGINS as readonly string[]).includes(value)
  );
}

/** Origins that may legitimately be ingested as ordinary run input. */
export const INGESTIBLE_SOURCE_ORIGINS = [
  "ORIGINAL_SOURCE",
  "GOLD_SOURCE",
  "UAT_FIXTURE",
] as const satisfies readonly SourceOrigin[];

export interface SourceProvenance {
  filename: string;
  /** SHA-256 of the input, so a run can be tied to exact source bytes. */
  sha256: string;
  origin: SourceOrigin;
  /** Immutable-corpus id, when the source belongs to a registered corpus. */
  corpus_id?: string;
  job_id: string;
  /** 1-based generation attempt for this job. */
  attempt: number;
  /** SHA-256 of the produced output, when one exists. */
  output_sha256?: string;
}

/* ------------------------------------------------------------------ *
 * Product evidence (the generic integrity contract)
 * ------------------------------------------------------------------ */

/**
 * Severity of a single integrity check. A `warning` downgrades confidence; an
 * `error` fails the product gate outright.
 */
export const CHECK_SEVERITIES = ["info", "warning", "error"] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

/**
 * One project-declared integrity check over the real artifact.
 *
 * Ralph never hard-codes a domain's rules. A project (e.g. a handout
 * generator) registers checks such as recursive-template detection,
 * long-block duplication or expansion ratio; the harness only knows this
 * shape.
 */
export interface ProductIntegrityCheckResult {
  /** Stable id, e.g. `recursive-template`, `expansion-ratio`. */
  id: string;
  severity: CheckSeverity;
  outcome: "PASS" | "FAIL";
  reason?: string;
}

/** Who actually looked at the artifact. Absence of both is `NOT_RUN`. */
export const INSPECTION_AUTHORS = ["agent", "human"] as const;
export type InspectionAuthor = (typeof INSPECTION_AUTHORS)[number];

/**
 * Durable evidence that someone opened the real thing. `exists: false` is
 * evidence too — of a missing artifact, which fails the product gate rather
 * than skipping it.
 */
export interface ProductEvidence {
  /** Path or URI of the real artifact / user-facing outcome. */
  artifact_ref: string;
  artifact_sha256?: string;
  exists: boolean;
  checks: ProductIntegrityCheckResult[];
  inspected_by: InspectionAuthor;
  inspection_note?: string;
  provenance?: SourceProvenance;
}

/* ------------------------------------------------------------------ *
 * Product issues and P0 corruption
 * ------------------------------------------------------------------ */

/** The fixed priority ladder. A lower level may never block a higher one. */
export const ISSUE_PRIORITIES = ["P0", "P1", "P2", "P3", "P4", "P5"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** The recognized shapes of product corruption. */
export const P0_CORRUPTION_KINDS = [
  "SEVERE_DUPLICATION",
  "RECURSIVE_CONTENT",
  "MASS_CONTENT_LOSS",
  "DATA_CROSS_WIRING",
  "ROLE_MIXUP",
  "WRONG_TEMPLATE_OR_USER_DATA",
  "UNUSABLE_OUTPUT",
  "IRREVERSIBLE_SOURCE_DAMAGE",
] as const;
export type P0CorruptionKind = (typeof P0_CORRUPTION_KINDS)[number];

export interface ProductIssue {
  priority: IssuePriority;
  summary: string;
  /** Set only on a P0 corruption issue. */
  corruption?: P0CorruptionKind;
}

/* ------------------------------------------------------------------ *
 * Gate records
 * ------------------------------------------------------------------ */

export interface MachineGateRecord {
  level: "MACHINE";
  outcome: GateOutcome;
  /** Reference to the durable V3 machine-gate artifact, when one exists. */
  evidence_ref?: string;
  failures: string[];
}

export interface ProductGateRecord {
  level: "PRODUCT";
  outcome: GateOutcome;
  evidence?: ProductEvidence;
  issues: ProductIssue[];
  reason?: string;
}

export interface ReleaseGateRecord {
  level: "RELEASE";
  outcome: GateOutcome;
  reason?: string;
}

export type GateRecord =
  | MachineGateRecord
  | ProductGateRecord
  | ReleaseGateRecord;

/* ------------------------------------------------------------------ *
 * Product Anchor
 * ------------------------------------------------------------------ */

export const GOAL_DRIFT_CHECKS = ["PASS", "FAIL"] as const;
export type GoalDriftCheck = (typeof GOAL_DRIFT_CHECKS)[number];

/**
 * Work that keeps the *machine* healthy without touching what the user
 * receives. Sustained recent work of only these kinds, while the product gate
 * is still unverified, is `GOAL_DRIFT`.
 */
export const PERIPHERAL_WORK_KINDS = [
  "SNAPSHOT",
  "MUTEX",
  "PORT",
  "PACKAGING_METADATA",
  "HASHES",
  "REPORT_WORDING",
  "PERIPHERAL_RECOVERY",
] as const;
export type PeripheralWorkKind = (typeof PERIPHERAL_WORK_KINDS)[number];

/**
 * The periodic checkpoint every run must answer. It exists to stop a run
 * grinding on the machine while the product rots.
 */
export interface ProductAnchor {
  round: number;
  sha: string;
  /** What the user finally receives that is concretely better than last round. */
  user_value_delta: string;
  /** Reference to the newest real artifact / user-facing outcome. */
  product_artifact: string;
  product_gate: GateOutcome;
  product_issues: string[];
  source_provenance?: SourceProvenance;
  goal_drift_check: GoalDriftCheck;
  next_highest_value_action: string;
}

/* ------------------------------------------------------------------ *
 * V4 signals and states
 * ------------------------------------------------------------------ */

/**
 * The blocking conditions V4 can raise. Each maps to a supervisor decision in
 * a later slice; the vocabulary lives here so every consumer agrees on it.
 */
export const V4_SIGNALS = [
  "PRODUCT_ANCHOR_REQUIRED",
  "GOAL_DRIFT",
  "P0_PRODUCT_CORRUPTION",
  "UAT_INPUT_INVALID",
] as const;
export type V4Signal = (typeof V4_SIGNALS)[number];

/**
 * On P0 the supervisor must reprioritise to this chain and suppress
 * release/packaging/performance/UI work until it completes.
 */
export const P0_OBLIGATION_CHAIN = [
  "TRACE_PRODUCT_LINEAGE",
  "ROOT_CAUSE",
  "CHIEF_REVIEW",
  "MINIMAL_FIX",
  "PRODUCT_REGRESSION",
] as const;
export type P0Obligation = (typeof P0_OBLIGATION_CHAIN)[number];

/**
 * Work classes that P0 puts on hold. Named so the suppression is testable
 * rather than implied by prose.
 */
export const P0_SUPPRESSED_WORK = [
  "RELEASE",
  "INSTALLER",
  "PACKAGING",
  "PERFORMANCE",
  "UI_POLISH",
  "RESTART_STRESS",
  "NEW_FEATURE",
] as const;
export type P0SuppressedWork = (typeof P0_SUPPRESSED_WORK)[number];

/* ------------------------------------------------------------------ *
 * Run journal
 * ------------------------------------------------------------------ */

/**
 * The per-round durable journal contract. Field names are the literal keys the
 * journal must carry; they are persisted into the devlog, not just printed.
 */
export interface RunJournalEntry {
  ROUND: number;
  SHA: string;
  USER_VALUE_DELTA: string;
  MACHINE_GATE: GateOutcome;
  PRODUCT_ARTIFACT: string;
  PRODUCT_GATE: GateOutcome;
  PRODUCT_ISSUES: string[];
  SOURCE_PROVENANCE: string;
  GOAL_DRIFT_CHECK: GoalDriftCheck;
  NEXT_HIGHEST_VALUE_ACTION: string;
}
