import type { RunState, V3Phase } from "./state.js";

export type PhaseHandler = (state: RunState) => unknown | Promise<unknown>;
export interface PhaseDefinition {
  phase: V3Phase;
  runnable: boolean;
  handlerKey?: string;
}

const definitions: readonly PhaseDefinition[] = [
  { phase: "SELECT", runnable: true, handlerKey: "SELECT" },
  { phase: "WORKER", runnable: true, handlerKey: "WORKER" },
  { phase: "MACHINE_GATE", runnable: true, handlerKey: "MACHINE_GATE" },
  { phase: "CHECKPOINT", runnable: true, handlerKey: "CHECKPOINT" },
  { phase: "CHIEF_REVIEW", runnable: true, handlerKey: "CHIEF_REVIEW" },
  { phase: "INTEGRATION_UAT", runnable: true, handlerKey: "INTEGRATION_UAT" },
  { phase: "FINAL_REVIEW", runnable: true, handlerKey: "FINAL_REVIEW" },
  { phase: "CHIEF_RECOVERY", runnable: true, handlerKey: "CHIEF_RECOVERY" },
  { phase: "WAITING_FOR_CHIEF", runnable: false },
  { phase: "WAITING_FOR_HUMAN", runnable: false },
  { phase: "HUMAN_REQUIRED", runnable: false },
  { phase: "DONE", runnable: false },
  { phase: "FAILED", runnable: false },
];

export const PHASE_REGISTRY: ReadonlyMap<V3Phase, PhaseDefinition> = new Map(
  definitions.map((entry) => [entry.phase, entry])
);
export function phaseDefinition(phase: V3Phase): PhaseDefinition {
  return PHASE_REGISTRY.get(phase)!;
}
export function isRunnablePhase(phase: V3Phase): boolean {
  return phaseDefinition(phase).runnable;
}

export async function dispatchPhase(
  state: RunState,
  handlers: Readonly<Record<string, PhaseHandler>>
): Promise<unknown> {
  const definition = PHASE_REGISTRY.get(state.phase);
  if (!definition) throw new Error(`phase is not registered: ${state.phase}`);
  if (!definition.runnable || !definition.handlerKey)
    throw new Error(`phase is not runnable: ${state.phase}`);
  const handler = handlers[definition.handlerKey];
  if (!handler)
    throw new Error(`no handler registered for phase: ${state.phase}`);
  return handler(state);
}
