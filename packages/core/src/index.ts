export { runAfk } from "./main.js";
export { runGhAfk } from "./gh-main.js";
export { runChief } from "./chief-main.js";
export {
  runChiefLoop,
  type ChiefLoopConfig,
  type ChiefLoopOptions,
  type ExternalChiefBridge,
  type ExternalChiefBridgeContext,
  type ChiefRunResult,
  type ChiefRunState,
  type ChiefRunStatus,
} from "./chief-loop.js";
export {
  parseChiefDecision,
  parseExternalChiefVerdict,
  type ChiefDecision,
  type ChiefVerdict,
  type ExternalChiefVerdict,
} from "./chief.js";
export {
  loadChiefConfig,
  type ChiefConfig,
  type ChiefAgentConfig,
  type ChiefGuiBridgeConfig,
  type ChiefMode,
} from "./chief-config.js";
export {
  runMachineGate,
  type MachineGateOptions,
  type MachineGateResult,
  type GateCommandResult,
} from "./machine-gate.js";
export {
  GitGuard,
  workspaceFingerprint,
  type AcceptanceControls,
  type RepoSnapshot,
  type WorkspaceFingerprint,
  type GuardViolation,
} from "./git-guard.js";
export type {
  AgentName,
  AgentSelection,
  AgentSelectionSource,
  StageMeta,
} from "./agents/index.js";
export { runLoop, type LoopOptions } from "./loop.js";
export { STAGES, type Stage } from "./stages.js";
export {
  renderTemplate,
  type RenderOptions,
  type RenderVars,
} from "./render.js";
export { ensureImage, runStage } from "./runner.js";
export {
  RUN_STATE_VERSION,
  PROJECT_STATE_VERSION,
  V3_PHASES,
  parseRunState,
  parseProjectState,
  hydrateRunState,
  hydrateProjectState,
  loadRunState,
  loadProjectState,
  saveRunState,
  saveProjectState,
  type RunState,
  type ProjectState,
  type ProjectTask,
  type V3Phase,
} from "./v3/state.js";
export { assertRunState, assertProjectState } from "./v3/state-invariants.js";
export { writeJsonAtomic, writeTextAtomic } from "./v3/atomic-json.js";
export {
  PHASE_REGISTRY,
  phaseDefinition,
  isRunnablePhase,
  dispatchPhase,
  type PhaseDefinition,
  type PhaseHandler,
} from "./v3/phases.js";
export {
  ROUND_ARTIFACTS,
  getChiefRunDir,
  roundName,
  getRoundDir,
  getRoundArtifactPath,
  type RoundArtifact,
} from "./v3/rounds.js";
export {
  ActiveWriterLockError,
  activeWriterLockPath,
  inspectActiveWriterLock,
  acquireActiveWriterLock,
  refreshActiveWriterLock,
  releaseActiveWriterLock,
  clearStaleActiveWriterLock,
  type ActiveWriterLock,
  type LockInspection,
  type LockKind,
} from "./v3/lock.js";
