import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getChiefRunDir, getRoundDir } from "./rounds.js";
import { isRunnablePhase } from "./phases.js";
import type { V3Phase } from "./state.js";

/**
 * Execution Backend Router / Adapter contract.
 *
 * This is the *execution* backend layer and is deliberately separate from the
 * Chief Router (`ralph-chief-v3-router.js`, which chooses External Warm →
 * External Recovery → Host Chief). The Chief Router decides *which Chief*;
 * this module decides *which agent/process actually executes a request*.
 *
 * Hard boundary: the Ralph Controller always owns run state, the obligation
 * ledger, handoff generation, hashes, schema validation, the writer lock, the
 * Machine Gate, checkpointing and phase transitions. A backend only executes a
 * request and returns a raw result. Backends therefore receive no state writer
 * here at all — there is no API through which they could mutate authoritative
 * state, and every route decision is recorded by the Controller via an
 * injected durable sink.
 */

/**
 * EXPERIMENTAL — NOT WIRED, production failover DISABLED.
 *
 * This module is a reviewed contract with deterministic tests, not a live
 * capability. It is deliberately not imported by any CLI entry / Controller
 * main loop, and `PRODUCTION_BACKEND_FAILOVER_ENABLED` is a hard `false`
 * constant so an accidental wiring cannot silently enable automatic backend
 * switching in a production path. The regression suite asserts both facts.
 */
export const EXECUTION_BACKEND_WIRING = {
  capability: "EXECUTION_BACKEND_FAILOVER",
  status: "EXPERIMENTAL",
  wired_into_controller: false,
  production_auto_failover: "NOT_ENABLED",
} as const;

/** Hard switch. Nothing may flip this without a deliberate reviewed change. */
export const PRODUCTION_BACKEND_FAILOVER_ENABLED = false;

/** Failover is legal only onto a backend the operator explicitly approved. */
export const FAILOVER_REQUIRES_USER_APPROVAL = true;

/**
 * Durable artifact the Controller must write when a run stops because no
 * approved fallback backend exists. Recorded here so the fail-closed evidence
 * has a fixed, reviewable location even while this module is unwired.
 */
export const BACKEND_STOP_EVIDENCE_FILENAME = "execution_backend_stop.json";

export const EXECUTION_BACKEND_KINDS = [
  "HOST_CODEX",
  "EXTERNAL_AGENT",
] as const;
export type ExecutionBackendKind = (typeof EXECUTION_BACKEND_KINDS)[number];

export const BACKEND_FAILURE_CLASSES = [
  "QUOTA_EXHAUSTED",
  "BACKEND_UNAVAILABLE",
  "TRANSPORT_FAILURE",
  "PROCESS_CRASH",
  "AUTH_FAILURE",
  "EXECUTION_FAILURE",
] as const;
export type BackendFailureClass = (typeof BACKEND_FAILURE_CLASSES)[number];

/**
 * Failures that must never fail the whole run when another configured backend
 * can serve the same request. Everything else is a genuine execution failure.
 */
export const FAILOVER_ELIGIBLE_FAILURES: readonly BackendFailureClass[] = [
  "QUOTA_EXHAUSTED",
  "BACKEND_UNAVAILABLE",
  "TRANSPORT_FAILURE",
];

/**
 * Why a route stopped instead of executing. Every one of these leaves the run
 * on durable `TECHNICAL_OPEN` evidence; none of them permits Ralph to pick a
 * model or provider the operator did not configure and approve.
 */
export const BACKEND_STOP_REASONS = [
  /** Failover-eligible failure, but no operator-approved fallback exists. */
  "NO_APPROVED_FALLBACK_BACKEND",
  /** No available execution backend at all. */
  "NO_EXECUTION_BACKEND_CONFIGURED",
  /** A real execution/auth/crash failure; switching backend would not help. */
  "NON_FAILOVER_FAILURE",
  /** Every approved backend was tried and all of them failed. */
  "APPROVED_BACKENDS_EXHAUSTED",
] as const;
export type BackendStopReason = (typeof BACKEND_STOP_REASONS)[number];

export type ExecutionRequest = {
  run_id: string;
  round: number;
  phase: string;
  task_id: string | null;
  /** Ralph owns prompt/handoff construction; backends treat this as opaque. */
  prompt: string;
};

export type ExecutionBackendResult = {
  backend: ExecutionBackendKind;
  /** Raw backend output. Ralph validates it; the backend makes no claim. */
  reply?: string;
  meta?: Record<string, unknown>;
  failure?: BackendFailureClass;
  message?: string;
};

export interface ExecutionBackend {
  readonly kind: ExecutionBackendKind;
  /** False when the backend is not configured for this machine at all. */
  readonly available: boolean;
  /**
   * True only when the operator explicitly approved this backend as a failover
   * *target*. Absent/false means the backend may never be selected as a
   * replacement for a failing primary — Ralph must stop instead.
   */
  readonly approvedForFailover?: boolean;
  run(request: ExecutionRequest): Promise<ExecutionBackendResult>;
}

export type BackendAttempt = {
  backend: ExecutionBackendKind;
  outcome: "SUCCESS" | "FAILURE";
  failure_class?: BackendFailureClass;
  message?: string;
};

export type BackendRouteRecord = {
  run_id: string;
  round: number;
  phase: string;
  task_id: string | null;
  original_backend: ExecutionBackendKind | null;
  selected_backend: ExecutionBackendKind | null;
  failure_class?: BackendFailureClass;
  failure_message?: string;
  failover: boolean;
  same_run_id: true;
  same_phase: string;
  same_task_id: string | null;
  attempts: BackendAttempt[];
  /** Whether the request was served, or the route stopped fail-closed. */
  disposition: "EXECUTED" | "STOPPED";
  stop_reason?: BackendStopReason;
  /** Present whenever the route stopped: the run stays technically open. */
  obligation?: "TECHNICAL_OPEN";
  /** True when only an operator decision (approve a fallback) can unblock. */
  requires_human_approval?: boolean;
  /** The failover targets the operator had actually approved. */
  approved_fallback_backends: ExecutionBackendKind[];
  /** Configured but unapproved candidates that were deliberately NOT used. */
  withheld_backends: ExecutionBackendKind[];
  /** Structural proof the router never invents an unconfigured provider. */
  auto_selected_new_provider: false;
  recorded_at: string;
};

export type ExecutionRouteOutcome = {
  result?: ExecutionBackendResult;
  route: BackendRouteRecord;
  /** True when every approved backend was tried and none succeeded. */
  exhausted: boolean;
  /** True when the route stopped without executing the request. */
  stopped: boolean;
  stop_reason?: BackendStopReason;
  /** Durable fail-closed evidence, mirroring `recordStop` when it is wired. */
  stop_evidence?: BackendStopEvidence;
};

/**
 * Durable record written when a route stops fail-closed. It exists so a stopped
 * run leaves evidence rather than a silent gap, and so an operator can see that
 * Ralph did not choose a provider on its own.
 */
export type BackendStopEvidence = {
  kind: "EXECUTION_BACKEND_STOP";
  run_id: string;
  round: number;
  phase: string;
  task_id: string | null;
  disposition: "STOPPED";
  stop_reason: BackendStopReason;
  failure_class?: BackendFailureClass;
  failure_message?: string;
  obligation: "TECHNICAL_OPEN";
  requires_human_approval: boolean;
  approved_fallback_backends: ExecutionBackendKind[];
  withheld_backends: ExecutionBackendKind[];
  attempted_backends: BackendAttempt[];
  auto_selected_new_provider: false;
  recorded_at: string;
};

export function buildBackendStopEvidence(
  route: BackendRouteRecord
): BackendStopEvidence {
  return {
    kind: "EXECUTION_BACKEND_STOP",
    run_id: route.run_id,
    round: route.round,
    phase: route.phase,
    task_id: route.task_id,
    disposition: "STOPPED",
    stop_reason: route.stop_reason ?? "NON_FAILOVER_FAILURE",
    ...(route.failure_class ? { failure_class: route.failure_class } : {}),
    ...(route.failure_message
      ? { failure_message: route.failure_message }
      : {}),
    obligation: "TECHNICAL_OPEN",
    requires_human_approval: route.requires_human_approval === true,
    approved_fallback_backends: route.approved_fallback_backends,
    withheld_backends: route.withheld_backends,
    attempted_backends: route.attempts,
    auto_selected_new_provider: false,
    recorded_at: route.recorded_at,
  };
}

/** The configured failover targets an operator explicitly approved. */
export function approvedFailoverBackends(
  backends: readonly ExecutionBackend[]
): ExecutionBackend[] {
  return backends.filter(
    (backend, index) => index > 0 && backend.approvedForFailover === true
  );
}

export function isFailoverEligible(failure: BackendFailureClass): boolean {
  return FAILOVER_ELIGIBLE_FAILURES.includes(failure);
}

/**
 * Classify a backend failure from whatever the adapter surfaced. Classification
 * is intentionally lexical and total: an unrecognizable failure is an
 * EXECUTION_FAILURE, never silently treated as failover-eligible.
 */
export function classifyBackendFailure(error: unknown): BackendFailureClass {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(
            (error as { message?: unknown } | null)?.message ?? error ?? ""
          );
  const text = `${code} ${message}`;

  if (
    /AUTH_FAILURE|AUTHENTICATION|UNAUTHORIZED|FORBIDDEN|INVALID[_ ]?API[_ ]?KEY|\b401\b|\b403\b|not logged in|login required/i.test(
      text
    )
  )
    return "AUTH_FAILURE";
  if (
    /QUOTA|RATE[_ ]?LIMIT|INSUFFICIENT|USAGE[_ ]?LIMIT|\b429\b|too many requests|额度|配额|exceeded your current/i.test(
      text
    )
  )
    return "QUOTA_EXHAUSTED";
  if (
    /EXTERNAL_NOT_CONFIGURED|NOT_CONFIGURED|UNAVAILABLE|ENOENT|not found|command not found|ECONNREFUSED|no such file|未配置|不可用/i.test(
      text
    )
  )
    return "BACKEND_UNAVAILABLE";
  if (
    /TRANSPORT|ETIMEDOUT|ECONNRESET|EPIPE|SOCKET|TIMEOUT|hang up|network|disconnect/i.test(
      text
    )
  )
    return "TRANSPORT_FAILURE";
  if (/SIGKILL|SIGSEGV|SIGABRT|PROCESS_CRASH|killed|core dumped/i.test(text))
    return "PROCESS_CRASH";
  return "EXECUTION_FAILURE";
}

/**
 * Attempt the configured backends in declaration order. The first backend is
 * the primary; later backends are failover targets *only when the operator
 * explicitly approved them*.
 *
 * Fail-closed rule: a failover-eligible failure with no approved fallback
 * stops the route. The run is left on durable `TECHNICAL_OPEN` evidence
 * (`recordStop`) and no backend is selected — Ralph never invents a model or
 * provider, and `selected_backend` stays `null`. A non-eligible failure also
 * stops the route, because switching backend would not repair it.
 */
export async function routeExecutionRequest(
  options: {
    runId: string;
    round: number;
    phase: string;
    taskId: string | null;
    backends: readonly ExecutionBackend[];
    recordRoute?: (record: BackendRouteRecord) => Promise<void> | void;
    /** Durable sink for fail-closed stop evidence. */
    recordStop?: (evidence: BackendStopEvidence) => Promise<void> | void;
    now?: () => string;
  },
  request: Omit<ExecutionRequest, "run_id" | "round" | "phase" | "task_id">
): Promise<ExecutionRouteOutcome> {
  const now = options.now ?? (() => new Date().toISOString());
  const identity: ExecutionRequest = {
    run_id: options.runId,
    round: options.round,
    phase: options.phase,
    task_id: options.taskId,
    prompt: request.prompt,
  };
  const attempts: BackendAttempt[] = [];
  const candidates = options.backends.filter((backend) => backend.available);
  const [primary, ...rest] = candidates;
  const approvedFallbacks = rest.filter(
    (backend) => backend.approvedForFailover === true
  );
  const withheldBackends = rest
    .filter((backend) => backend.approvedForFailover !== true)
    .map((backend) => backend.kind);
  const order = primary ? [primary, ...approvedFallbacks] : [];
  const original = primary?.kind ?? null;

  const finalize = async (
    outcome: Omit<ExecutionRouteOutcome, "route" | "stopped"> & {
      stopped: boolean;
      stopReason?: BackendStopReason;
      failure?: BackendAttempt;
    }
  ): Promise<ExecutionRouteOutcome> => {
    // A route that failed over and then succeeded must still record *why* it
    // failed over, otherwise the durable evidence loses the quota/unavailable
    // signal that caused the switch. When a failure is passed explicitly it is
    // the triggering one (including a synthetic signal such as "no backend is
    // configured at all"); otherwise the last failed attempt is used.
    const lastFailure =
      outcome.failure ??
      [...attempts].reverse().find((attempt) => attempt.outcome === "FAILURE");
    const route: BackendRouteRecord = {
      run_id: options.runId,
      round: options.round,
      phase: options.phase,
      task_id: options.taskId,
      original_backend: original,
      selected_backend: outcome.result?.backend ?? null,
      failover: attempts.length > 1,
      same_run_id: true,
      same_phase: options.phase,
      same_task_id: options.taskId,
      attempts,
      disposition: outcome.stopped ? "STOPPED" : "EXECUTED",
      approved_fallback_backends: approvedFallbacks.map(
        (backend) => backend.kind
      ),
      withheld_backends: withheldBackends,
      auto_selected_new_provider: false,
      recorded_at: now(),
      ...(outcome.stopReason !== undefined
        ? {
            stop_reason: outcome.stopReason,
            obligation: "TECHNICAL_OPEN" as const,
            requires_human_approval:
              outcome.stopReason === "NO_APPROVED_FALLBACK_BACKEND",
          }
        : {}),
      ...(lastFailure?.failure_class
        ? {
            failure_class: lastFailure.failure_class,
            failure_message: lastFailure.message,
          }
        : {}),
    };
    await options.recordRoute?.(route);
    const stopEvidence =
      route.disposition === "STOPPED" ? buildBackendStopEvidence(route) : null;
    if (stopEvidence) await options.recordStop?.(stopEvidence);
    return {
      route,
      exhausted: outcome.exhausted,
      stopped: outcome.stopped,
      ...(outcome.stopReason !== undefined
        ? { stop_reason: outcome.stopReason }
        : {}),
      ...(stopEvidence ? { stop_evidence: stopEvidence } : {}),
      ...(outcome.result ? { result: outcome.result } : {}),
    };
  };

  if (!primary)
    return finalize({
      exhausted: true,
      stopped: true,
      stopReason: "NO_EXECUTION_BACKEND_CONFIGURED",
      failure: {
        backend: "HOST_CODEX",
        outcome: "FAILURE",
        failure_class: "BACKEND_UNAVAILABLE",
        message: "no execution backend is configured",
      },
    });

  for (const backend of order) {
    let result: ExecutionBackendResult;
    try {
      result = await backend.run(identity);
    } catch (error) {
      result = {
        backend: backend.kind,
        failure: classifyBackendFailure(error),
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!result.failure) {
      attempts.push({ backend: backend.kind, outcome: "SUCCESS" });
      return finalize({ exhausted: false, stopped: false, result });
    }
    const attempt: BackendAttempt = {
      backend: backend.kind,
      outcome: "FAILURE",
      failure_class: result.failure,
      message: result.message,
    };
    attempts.push(attempt);
    if (!isFailoverEligible(result.failure))
      return finalize({
        exhausted: false,
        stopped: true,
        stopReason: "NON_FAILOVER_FAILURE",
        failure: attempt,
      });
    if (backend === order[order.length - 1])
      return finalize(
        approvedFallbacks.length
          ? {
              exhausted: true,
              stopped: true,
              stopReason: "APPROVED_BACKENDS_EXHAUSTED",
              failure: attempt,
            }
          : {
              exhausted: false,
              stopped: true,
              stopReason: "NO_APPROVED_FALLBACK_BACKEND",
              failure: attempt,
            }
      );
  }
  // Unreachable: the loop always returns on the last candidate.
  return finalize({
    exhausted: true,
    stopped: true,
    stopReason: "APPROVED_BACKENDS_EXHAUSTED",
  });
}

export type RoundArtifacts = {
  workerCompleted: boolean;
  gateRequiredPassed: boolean;
  checkpointCommitted: boolean;
  selectDecisionRecorded: boolean;
  reviewDecisionRecorded: boolean;
  finalReviewDecisionRecorded: boolean;
  recoveryDecisionRecorded: boolean;
  integrationUatPassed: boolean;
};

function roundArtifactPath(
  projectRoot: string,
  runId: string,
  round: number,
  name: string
): string {
  return join(getRoundDir(getChiefRunDir(projectRoot, runId), round), name);
}

async function readOptionalRecord(
  path: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

/**
 * Read the durable artifacts of one round so a failover decision can be made
 * without re-running work that is already recorded.
 */
export async function inspectRoundArtifacts(options: {
  projectRoot: string;
  runId: string;
  round: number;
}): Promise<RoundArtifacts> {
  const path = (name: string) =>
    roundArtifactPath(options.projectRoot, options.runId, options.round, name);
  const [worker, gate, checkpoint, select, review, finalReview, recovery, uat] =
    await Promise.all([
      readOptionalRecord(path("worker_evidence.json")),
      readOptionalRecord(path("machine_gate.json")),
      readOptionalRecord(path("checkpoint.json")),
      readOptionalRecord(path("select_decision.json")),
      readOptionalRecord(path("review_decision.json")),
      readOptionalRecord(path("final_review_decision.json")),
      readOptionalRecord(path("recovery_decision.json")),
      readOptionalRecord(path("integration_uat.json")),
    ]);
  return {
    workerCompleted: worker?.completed === true,
    gateRequiredPassed: gate?.required_gate_passed === true,
    checkpointCommitted: checkpoint?.pushed === true,
    selectDecisionRecorded: typeof select?.action === "string",
    reviewDecisionRecorded: typeof review?.action === "string",
    finalReviewDecisionRecorded: typeof finalReview?.action === "string",
    recoveryDecisionRecorded: typeof recovery?.action === "string",
    integrationUatPassed: uat?.passed === true,
  };
}

export type BackendDispatchDecision = {
  dispatch: boolean;
  reason: string;
  /** The durable artifact that already satisfies the phase, when any. */
  satisfied_by?: string;
};

/**
 * Decide whether a backend may be asked to execute the current phase, or
 * whether durable state already records that work. This is the
 * no-duplicate-execution guard used before any backend failover.
 */
export function evaluateBackendDispatch(input: {
  runState: { phase: string; status?: string };
  artifacts: RoundArtifacts;
}): BackendDispatchDecision {
  const { phase } = input.runState;
  const artifacts = input.artifacts;
  const satisfied = (
    reason: string,
    artifact: string
  ): BackendDispatchDecision => ({
    dispatch: false,
    reason,
    satisfied_by: artifact,
  });

  switch (phase) {
    case "WORKER":
      return artifacts.workerCompleted
        ? satisfied(
            "Worker already completed for this round; not repeating it",
            "worker_evidence.json"
          )
        : {
            dispatch: true,
            reason: "Worker has no completed evidence for this round",
          };
    case "MACHINE_GATE":
      return artifacts.gateRequiredPassed
        ? satisfied(
            "Machine Gate already passed its required commands; not repeating it",
            "machine_gate.json"
          )
        : {
            dispatch: true,
            reason: "Machine Gate has no passing required evidence",
          };
    case "CHECKPOINT":
      return artifacts.checkpointCommitted
        ? satisfied(
            "Checkpoint already committed and pushed; not repeating it",
            "checkpoint.json"
          )
        : { dispatch: true, reason: "no committed checkpoint for this round" };
    case "SELECT":
      return artifacts.selectDecisionRecorded
        ? satisfied(
            "a durable select decision already exists; not resending the handoff",
            "select_decision.json"
          )
        : { dispatch: true, reason: "no durable select decision yet" };
    case "CHIEF_REVIEW":
      return artifacts.reviewDecisionRecorded
        ? satisfied(
            "a durable Chief review decision already exists; not resending the handoff",
            "review_decision.json"
          )
        : { dispatch: true, reason: "no durable Chief review decision yet" };
    case "FINAL_REVIEW":
      return artifacts.finalReviewDecisionRecorded
        ? satisfied(
            "a durable final review decision already exists; not resending the handoff",
            "final_review_decision.json"
          )
        : { dispatch: true, reason: "no durable final review decision yet" };
    case "CHIEF_RECOVERY":
      return artifacts.recoveryDecisionRecorded
        ? satisfied(
            "a durable recovery decision already exists; not resending the handoff",
            "recovery_decision.json"
          )
        : { dispatch: true, reason: "no durable recovery decision yet" };
    case "INTEGRATION_UAT":
      return artifacts.integrationUatPassed
        ? satisfied(
            "integration UAT already passed; not repeating it",
            "integration_uat.json"
          )
        : { dispatch: true, reason: "integration UAT has no passing evidence" };
    default:
      return isRunnablePhase(phase as V3Phase)
        ? { dispatch: true, reason: `${phase} is runnable` }
        : {
            dispatch: false,
            reason: `${phase} does not require a backend`,
          };
  }
}
