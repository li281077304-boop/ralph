import { createHash } from "node:crypto";

import { isRunnablePhase } from "./phases.js";
import type { V3Phase } from "./state.js";

/**
 * The permanent Supervisor restart matrix.
 *
 * The Supervisor owns Controller *process lifecycle* only. It never interprets
 * business rules and never writes run state; `RUN_STATE.json` remains the sole
 * authority on whether work still exists.
 *
 * The rule that matters most: a durable, legal waiting state is NOT a crash.
 * Restarting a Controller that is correctly parked on an external dependency
 * produces no progress and an unbounded restart spin (observed in production:
 * 231 restarts, all parked in WAITING_FOR_CHIEF). A waiting state is therefore
 * stable unless durable evidence says a deterministic autonomous recovery
 * action is still pending.
 */

export type SupervisorDispositionKind =
  | "STABLE_DONE"
  | "STABLE_WAIT"
  | "STABLE_PAUSE"
  | "STABLE_TERMINAL"
  | "STABLE_TECHNICAL_OPEN"
  | "RESTART";

export type SupervisorDisposition = {
  kind: SupervisorDispositionKind;
  /** Whether the Controller may be started again. */
  restart: boolean;
  reason: string;
};

export type SupervisorRunSnapshot = {
  phase: string;
  status: string;
  stop_reason?: string;
  failure_reason?: string;
};

export type SupervisorEvaluationInput = {
  runState?: SupervisorRunSnapshot;
  /** Durable controller telemetry, used only for recovery-action evidence. */
  telemetry?: Record<string, unknown>;
};

/** Legal non-restart stop reasons for a deliberately paused run. */
export const CONTROLLED_STOP_REASONS = [
  "CONTROLLED_PAUSE",
  "USER_STOP",
  "INTENTIONAL_EXIT",
] as const;

function disposition(
  kind: SupervisorDispositionKind,
  reason: string
): SupervisorDisposition {
  return { kind, restart: kind === "RESTART", reason };
}

export function evaluateSupervisorDisposition(
  input: SupervisorEvaluationInput
): SupervisorDisposition {
  const state = input.runState;
  if (!state)
    return disposition(
      "RESTART",
      "no durable run state yet; controller has not started"
    );

  const phase = state.phase;
  const status = state.status;

  if (phase === "DONE")
    return disposition(
      "STABLE_DONE",
      "run reached DONE; nothing left to supervise"
    );

  if (phase === "FAILED")
    return disposition(
      "STABLE_TERMINAL",
      `run is durably FAILED (${state.failure_reason ?? "no reason recorded"}); it needs an explicit operator reset, not a restart`
    );

  // An explicit pause outranks the phase it paused in: CONTROLLED_PAUSE,
  // USER_STOP and INTENTIONAL_EXIT are deliberate operator decisions.
  if (status === "paused")
    return disposition(
      "STABLE_PAUSE",
      `run is deliberately paused in ${phase} (${state.stop_reason ?? "no stop reason recorded"})`
    );

  if (phase === "WAITING_FOR_HUMAN" || phase === "HUMAN_REQUIRED")
    return disposition(
      "STABLE_WAIT",
      "run is parked on a human decision; restarting cannot resolve it"
    );

  if (phase === "WAITING_FOR_CHIEF") {
    // Phase name alone is not enough: a pending deterministic recovery action
    // must still be executed, otherwise the wait is genuinely external.
    const pending = input.telemetry?.chief_recovery_pending === true;
    if (pending)
      return disposition(
        "RESTART",
        "WAITING_FOR_CHIEF with an unattempted autonomous recovery action recorded"
      );
    return disposition(
      "STABLE_WAIT",
      "WAITING_FOR_CHIEF with all autonomous recovery exhausted; waiting on an external Chief/backend dependency"
    );
  }

  if (!isRunnablePhase(phase as V3Phase))
    return disposition(
      "STABLE_WAIT",
      `phase ${phase} is not runnable; no autonomous execution remains`
    );

  return disposition(
    "RESTART",
    `durable state still requires execution (${phase}/${status})`
  );
}

/**
 * Bounded exponential backoff. `baseMs` is the caller's configured delay, so an
 * explicit 0 keeps deterministic tests instant while production backs off.
 */
export function supervisorRestartBackoffMs(
  restartCount: number,
  options: { baseMs?: number; maxMs?: number } = {}
): number {
  const base = Math.max(0, options.baseMs ?? 1000);
  const max = Math.max(base, options.maxMs ?? 60_000);
  if (restartCount <= 0) return 0;
  if (base === 0) return 0;
  return Math.min(max, base * 2 ** (restartCount - 1));
}

/**
 * Stable identity of a failure episode. Two restarts that leave the run in the
 * same durable state and die the same way are the same failure, which is what
 * makes rapid-restart detection possible.
 */
export function supervisorFailureFingerprint(input: {
  runState?: SupervisorRunSnapshot;
  exit?: { code?: number | null; signal?: string | null } | null;
}): string {
  const state = input.runState;
  const canonical = JSON.stringify({
    phase: state?.phase ?? null,
    status: state?.status ?? null,
    stop_reason: state?.stop_reason ?? null,
    failure_reason: state?.failure_reason ?? null,
    exit_code: input.exit?.code ?? null,
    exit_signal: input.exit?.signal ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
