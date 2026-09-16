import type { ObligationStatus } from "./obligations.js";
import { HUMAN_CATEGORIES } from "./human-boundary.js";
import {
  compileMinimalHumanRequired,
  evaluateHumanBoundary,
  isTechnicalHumanReason,
  persistHumanRequired,
} from "./human-boundary.js";

export type AutonomousEvent =
  | { type: "WORK_COMPLETE"; liveness?: string }
  | { type: "TECHNICAL_FAILURE"; signature: string; message?: string }
  | {
      type: "HUMAN_BLOCK";
      category: string;
      message: string;
      options?: string[];
      technical?: boolean;
    }
  | { type: "GATE_PASS" }
  | { type: "GATE_FAIL"; signature?: string };

export type AutonomousObligation = {
  id: string;
  status: ObligationStatus;
  priority?: number;
  created_at?: string;
  attempts?: number;
  failure_signatures?: string[];
  active_goal?: { thread_id?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type AutonomousState = {
  version: 1;
  run_id: string;
  phase: string;
  status: string;
  round: number;
  obligations: AutonomousObligation[];
  human_backlog: Array<Record<string, unknown>>;
  failure_reason?: string;
  stop_reason?: string;
  [key: string]: unknown;
};

export type AutonomousTelemetry = {
  chief_recovery_count: number;
  recovery_success_count: number;
  transport_disconnect_count: number;
  human_interrupt_count: number;
};

export type AutonomousHandlers = {
  worker?: (
    obligation: AutonomousObligation
  ) => Promise<AutonomousEvent> | AutonomousEvent;
  chiefRecovery?: (
    obligation: AutonomousObligation,
    context: {
      failureSignature: string;
      freshContext: true;
      previousDiagnosis?: string;
      previousStrategy?: string[];
    }
  ) =>
    | Promise<{
        action: "RETRY_WORKER" | "RUN_MACHINE_GATE" | "HUMAN_BLOCK";
        [key: string]: unknown;
      }>
    | {
        action: "RETRY_WORKER" | "RUN_MACHINE_GATE" | "HUMAN_BLOCK";
        [key: string]: unknown;
      };
  gate?: (
    obligation: AutonomousObligation
  ) => Promise<AutonomousEvent> | AutonomousEvent;
  pauseGoal?: (
    threadId: string
  ) => Promise<{ status?: string; confirmed?: boolean }>;
};

const HUMAN_CATEGORY_SET = new Set<string>(HUMAN_CATEGORIES);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sortObligations(
  items: AutonomousObligation[]
): AutonomousObligation[] {
  return [...items].sort(
    (a, b) =>
      (b.priority ?? 0) - (a.priority ?? 0) ||
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
      a.id.localeCompare(b.id)
  );
}

function failureSignature(item: AutonomousObligation): string {
  return item.failure_signatures?.at(-1) ?? "unknown:technical-failure";
}

function saveTransition(
  state: AutonomousState,
  saveState: (state: AutonomousState) => Promise<void> | void
): Promise<void> {
  return Promise.resolve(saveState(clone(state)));
}

function setStatus(
  state: AutonomousState,
  id: string,
  status: ObligationStatus
): void {
  const item = state.obligations.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`obligation not found: ${id}`);
  item.status = status;
  item.updated_at = new Date().toISOString();
}

function protocolFailure(state: AutonomousState, reason: string): void {
  state.phase = "FAILED";
  state.status = "failed";
  state.failure_reason = reason;
}

function validRecoveryDecision(decision: unknown): decision is {
  action: "RETRY_WORKER" | "RUN_MACHINE_GATE" | "HUMAN_BLOCK";
  summary?: string;
  technical_diagnosis?: string;
  worker_task?: string;
  verification_strategy?: string[];
  human_question?: string;
  human_required_reason?: string;
  human_category?: string;
  category?: string;
  human_options?: string[];
} {
  if (!decision || typeof decision !== "object") return false;
  const value = decision as Record<string, unknown>;
  if (
    !["RETRY_WORKER", "RUN_MACHINE_GATE", "HUMAN_BLOCK"].includes(
      String(value.action)
    )
  )
    return false;
  const nonEmpty = (field: string) =>
    typeof value[field] === "string" &&
    Boolean((value[field] as string).trim());
  if (value.action === "RETRY_WORKER") {
    return (
      nonEmpty("summary") &&
      nonEmpty("technical_diagnosis") &&
      nonEmpty("worker_task") &&
      Array.isArray(value.verification_strategy) &&
      value.verification_strategy.length > 0 &&
      value.verification_strategy.every(
        (item) => typeof item === "string" && item.trim()
      )
    );
  }
  if (value.action === "RUN_MACHINE_GATE")
    return nonEmpty("summary") && nonEmpty("technical_diagnosis");
  return (
    nonEmpty("summary") &&
    nonEmpty("human_question") &&
    nonEmpty("human_required_reason") &&
    HUMAN_CATEGORY_SET.has(String(value.category ?? value.human_category)) &&
    !isTechnicalHumanReason(value.human_required_reason) &&
    (!value.human_options ||
      (Array.isArray(value.human_options) &&
        value.human_options.every((item) => typeof item === "string")))
  );
}

function refreshResolvedBacklog(state: AutonomousState): void {
  const resolved = new Set(
    state.human_backlog
      .filter((item) => item.status === "RESOLVED" || item.resolved === true)
      .map((item) => String(item.obligation_id ?? item.id))
  );
  if (!resolved.size) return;
  state.obligations = state.obligations.map((item) =>
    resolved.has(item.id) || resolved.has(String(item.id))
      ? { ...item, status: "RUNNABLE", human_backlog_id: undefined }
      : item
  );
  state.human_backlog = state.human_backlog.filter(
    (item) => !(item.status === "RESOLVED" || item.resolved === true)
  );
}

/**
 * Deterministic, storage-agnostic obligation controller. Production V3 phases
 * remain responsible for Git, Goal, Gate, and Chief evidence; this seam owns
 * only scheduling and global terminal-state policy.
 */
export async function runAutonomousObligationLoop(options: {
  projectRoot: string;
  runId: string;
  loadState: () => Promise<AutonomousState>;
  saveState: (state: AutonomousState) => Promise<void> | void;
  handlers: AutonomousHandlers;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  maxRepeatedFailureSignatures?: number;
  onProgress?: (event: {
    obligation_id?: string;
    phase: string;
    state: AutonomousState;
  }) => void;
}): Promise<{
  status: "DONE" | "WAITING_FOR_HUMAN" | "TECHNICAL_OPEN" | "FAILED" | "PAUSED";
  state: AutonomousState;
  telemetry: AutonomousTelemetry;
}> {
  void options.projectRoot;
  void options.runId;
  void options.now;
  void options.sleep;
  let state = clone(await options.loadState());
  const telemetry: AutonomousTelemetry = {
    chief_recovery_count: 0,
    recovery_success_count: 0,
    transport_disconnect_count: 0,
    human_interrupt_count: 0,
  };
  const maxRepeats = Math.max(1, options.maxRepeatedFailureSignatures ?? 3);
  refreshResolvedBacklog(state);
  await saveTransition(state, options.saveState);

  const pauseIfRequested = async (
    item?: AutonomousObligation
  ): Promise<boolean> => {
    if (!options.signal?.aborted) return false;
    telemetry.human_interrupt_count += 1;
    const threadId = item?.active_goal?.thread_id;
    if (threadId && options.handlers.pauseGoal) {
      const confirmation = await options.handlers.pauseGoal(threadId);
      if (confirmation.status !== "paused" || confirmation.confirmed !== true) {
        protocolFailure(state, "Goal pause confirmation failed");
        await saveTransition(state, options.saveState);
        return true;
      }
    }
    state.status = "paused";
    state.phase = "WORKER";
    state.stop_reason = String(options.signal.reason ?? "SIGINT");
    await saveTransition(state, options.saveState);
    return true;
  };

  while (true) {
    if (await pauseIfRequested())
      return {
        status: state.status === "paused" ? "PAUSED" : "FAILED",
        state,
        telemetry,
      };
    const boundary = evaluateHumanBoundary(
      state.obligations.map((item) => item.status)
    );
    if (boundary.terminal === "DONE") {
      state.phase = "DONE";
      state.status = "done";
      await saveTransition(state, options.saveState);
      return { status: "DONE", state, telemetry };
    }
    if (boundary.terminal === "WAITING_FOR_HUMAN") {
      state.phase = "WAITING_FOR_HUMAN";
      state.status = "waiting";
      state.stop_reason = "no runnable or technical obligations remain";
      await saveTransition(state, options.saveState);
      return { status: "WAITING_FOR_HUMAN", state, telemetry };
    }
    const technical = sortObligations(
      state.obligations.filter((item) => item.status === "TECHNICAL_OPEN")
    )[0];
    const runnable = sortObligations(
      state.obligations.filter((item) => item.status === "RUNNABLE")
    )[0];
    const item = technical ?? runnable;
    if (!item) {
      state.phase = "TECHNICAL_OPEN";
      state.status = "running";
      state.stop_reason = "obligation state requires reconciliation";
      await saveTransition(state, options.saveState);
      return { status: "TECHNICAL_OPEN", state, telemetry };
    }
    options.onProgress?.({
      obligation_id: item.id,
      phase: technical ? "CHIEF_RECOVERY" : "WORKER",
      state: clone(state),
    });

    if (technical) {
      if (!options.handlers.chiefRecovery) {
        await saveTransition(state, options.saveState);
        return { status: "TECHNICAL_OPEN", state, telemetry };
      }
      telemetry.chief_recovery_count += 1;
      const decision = await options.handlers.chiefRecovery(item, {
        failureSignature: failureSignature(item),
        freshContext: true,
        previousDiagnosis:
          typeof item.latest_diagnosis === "string"
            ? item.latest_diagnosis
            : undefined,
        previousStrategy: Array.isArray(item.latest_strategy)
          ? (item.latest_strategy as string[])
          : undefined,
      });
      if (!validRecoveryDecision(decision)) {
        const raw = decision as Record<string, unknown>;
        if (
          raw.action === "HUMAN_BLOCK" &&
          isTechnicalHumanReason(raw.human_required_reason)
        ) {
          item.failure_signatures = [
            ...new Set([
              ...(item.failure_signatures ?? []),
              `technical:${String(raw.human_required_reason)}`,
            ]),
          ];
          item.attempts = (item.attempts ?? 0) + 1;
          setStatus(state, item.id, "TECHNICAL_OPEN");
          await saveTransition(state, options.saveState);
          return { status: "TECHNICAL_OPEN", state, telemetry };
        }
        protocolFailure(
          state,
          "malformed or mismatched CHIEF_RECOVERY protocol"
        );
        await saveTransition(state, options.saveState);
        return { status: "FAILED", state, telemetry };
      }
      if (decision.action === "HUMAN_BLOCK") {
        const category = String(decision.human_category ?? decision.category);
        if (
          !HUMAN_CATEGORY_SET.has(category) ||
          typeof decision.human_question !== "string" ||
          !decision.human_question.trim()
        ) {
          protocolFailure(
            state,
            "CHIEF_RECOVERY HUMAN_BLOCK requires canonical evidence"
          );
          await saveTransition(state, options.saveState);
          return { status: "FAILED", state, telemetry };
        }
        const compiled = compileMinimalHumanRequired([
          {
            id: `human:${state.run_id}:${item.id}`,
            obligation_id: item.id,
            category,
            confirmed_facts: [],
            blocker_reason: String(decision.human_required_reason ?? ""),
            question: String(decision.human_question),
            minimum_answer: String(decision.human_question),
            options: Array.isArray(decision.human_options)
              ? decision.human_options
              : [],
            evidence_paths: [],
            resume_action: "Resolve this item to resume the obligation",
            affected_obligations: [item.id],
            context: { run_id: state.run_id, round: state.round },
            scope: "RUN",
            requires_human_judgment: true,
          },
        ]);
        if (compiled.length !== 1) {
          protocolFailure(state, "HUMAN_BLOCK candidate was auto-resolvable");
          await saveTransition(state, options.saveState);
          return { status: "FAILED", state, telemetry };
        }
        await persistHumanRequired(options.projectRoot, state.run_id, compiled);
        setStatus(state, item.id, "HUMAN_BLOCKED");
        state.human_backlog.push({
          ...compiled[0],
          reason: compiled[0].blocker_reason,
        });
        await saveTransition(state, options.saveState);
        continue;
      }
      if (decision.action === "RETRY_WORKER") {
        item.latest_diagnosis = String(decision.technical_diagnosis);
        item.latest_strategy = Array.isArray(decision.verification_strategy)
          ? decision.verification_strategy
          : [];
        item.last_recovery_action = decision.action;
        setStatus(state, item.id, "RUNNABLE");
        state.round += 1;
        state.phase = "WORKER";
        telemetry.recovery_success_count += 1;
        await saveTransition(state, options.saveState);
        continue;
      }
      const gateEvent = options.handlers.gate?.(item);
      const gate = gateEvent ? await gateEvent : undefined;
      if (gate?.type === "GATE_PASS") {
        setStatus(state, item.id, "PASS");
        telemetry.recovery_success_count += 1;
        await saveTransition(state, options.saveState);
        continue;
      }
      const signature = gate?.type === "GATE_FAIL" ? gate.signature : undefined;
      if (signature)
        item.failure_signatures = [
          ...new Set([...(item.failure_signatures ?? []), signature]),
        ];
      await saveTransition(state, options.saveState);
      return { status: "TECHNICAL_OPEN", state, telemetry };
    }

    if (!options.handlers.worker) {
      protocolFailure(state, "worker handler is missing");
      await saveTransition(state, options.saveState);
      return { status: "FAILED", state, telemetry };
    }
    let event: AutonomousEvent;
    try {
      event = await options.handlers.worker(item);
    } catch (error) {
      if (await pauseIfRequested(item))
        return {
          status: state.status === "paused" ? "PAUSED" : "FAILED",
          state,
          telemetry,
        };
      event = { type: "TECHNICAL_FAILURE", signature: String(error) };
    }
    if (await pauseIfRequested(item))
      return {
        status: state.status === "paused" ? "PAUSED" : "FAILED",
        state,
        telemetry,
      };
    if (event.type === "HUMAN_BLOCK") {
      if (event.technical || !HUMAN_CATEGORY_SET.has(event.category)) {
        if (event.technical) {
          item.failure_signatures = [
            ...new Set([
              ...(item.failure_signatures ?? []),
              `technical:${event.message}`,
            ]),
          ];
          item.attempts = (item.attempts ?? 0) + 1;
          setStatus(state, item.id, "TECHNICAL_OPEN");
          await saveTransition(state, options.saveState);
          continue;
        }
        protocolFailure(state, `invalid human category: ${event.category}`);
        await saveTransition(state, options.saveState);
        return { status: "FAILED", state, telemetry };
      }
      const compiled = compileMinimalHumanRequired([
        {
          id: item.id,
          obligation_id: item.id,
          category: event.category,
          blocker_reason: event.message,
          question: event.message,
          minimum_answer: event.message,
          options: event.options ?? [],
          resume_action: "Resolve this item to resume the obligation",
          affected_obligations: [item.id],
          scope: "RUN",
          requires_human_judgment: true,
        },
      ]);
      if (compiled.length !== 1) {
        protocolFailure(state, "HUMAN_BLOCK candidate was auto-resolvable");
        await saveTransition(state, options.saveState);
        return { status: "FAILED", state, telemetry };
      }
      await persistHumanRequired(options.projectRoot, state.run_id, compiled);
      setStatus(state, item.id, "HUMAN_BLOCKED");
      state.human_backlog.push({
        ...compiled[0],
        reason: compiled[0].blocker_reason,
      });
      await saveTransition(state, options.saveState);
      continue;
    }
    if (event.type === "TECHNICAL_FAILURE") {
      item.failure_signatures = [
        ...new Set([...(item.failure_signatures ?? []), event.signature]),
      ];
      item.attempts = (item.attempts ?? 0) + 1;
      if (/disconnect/i.test(event.signature))
        telemetry.transport_disconnect_count += 1;
      setStatus(state, item.id, "TECHNICAL_OPEN");
      await saveTransition(state, options.saveState);
      if ((item.attempts ?? 0) >= maxRepeats)
        return { status: "TECHNICAL_OPEN", state, telemetry };
      continue;
    }
    if (event.type !== "WORK_COMPLETE") {
      protocolFailure(state, "worker returned an invalid event");
      await saveTransition(state, options.saveState);
      return { status: "FAILED", state, telemetry };
    }
    if (event.liveness === "reconnected")
      telemetry.transport_disconnect_count += 1;
    const gate = options.handlers.gate
      ? await options.handlers.gate(item)
      : ({ type: "GATE_PASS" } as const);
    if (gate.type === "GATE_PASS") {
      setStatus(state, item.id, "PASS");
      await saveTransition(state, options.saveState);
      continue;
    }
    if (gate.type === "GATE_FAIL" && gate.signature)
      item.failure_signatures = [
        ...new Set([...(item.failure_signatures ?? []), gate.signature]),
      ];
    setStatus(state, item.id, "TECHNICAL_OPEN");
    await saveTransition(state, options.saveState);
    return { status: "TECHNICAL_OPEN", state, telemetry };
  }
}
