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
  defaultChiefConfig,
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
  type WaitingHandoff,
  type SelectWaitingHandoff,
  type ReviewWaitingHandoff,
  type FutureWaitingHandoff,
} from "./v3/state.js";
export { assertRunState, assertProjectState } from "./v3/state-invariants.js";
export {
  writeJsonAtomic,
  writeTextAtomic,
  writeJsonImmutable,
  writeTextImmutable,
} from "./v3/atomic-json.js";
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
export {
  PROJECT_STATE_RELATIVE_PATH,
  PROJECT_PLAN_RELATIVE_PATH,
  projectStatePath,
  projectPlanPath,
  canonicalizeValue,
  canonicalizeProjectState,
  hashProjectState,
  getReadyTasks,
  renderProjectPlan,
  loadProjectStateFromProject,
  saveProjectStateToProject,
} from "./v3/project-plan.js";
export {
  SELECT_HANDOFF_KIND,
  parseChiefSelectDecision,
  validateChiefSelectDecision,
  prepareSelectHandoff,
  applySelectDecision,
  type SelectAction,
  type ReferenceDecision,
  type ReferenceCheck,
  type ChiefSelectDecision,
  type SelectHandoff,
  type SelectPreparation,
} from "./v3/select.js";
export {
  REVIEW_HANDOFF_KIND,
  REVIEW_OPEN_MARKER,
  REVIEW_CLOSE_MARKER,
  parseChiefReviewDecision,
  validateChiefReviewDecision,
  prepareReviewHandoff,
  applyReviewDecision,
  verifyReviewCheckpoint,
  type ChiefReviewDecision,
  type ReviewHandoff,
  type ReviewStage,
  type ReviewPreparation,
  type ReviewRemoteUrlResolver,
} from "./v3/review.js";
export {
  buildWorkerPrompt,
  runWorkerPhase,
  resumeTechnicalBlockedWorker,
  type V3WorkerConfig,
  type V3WorkerRunner,
  type WorkerPhaseResult,
} from "./v3/worker.js";
export {
  finiteWorkerArgs,
  runFiniteCodexWorker,
  type FiniteWorkerOptions,
} from "./v3/finite-worker.js";
export {
  GOAL_STATUSES,
  NativeCodexGoalTransport,
  pauseGoalForShutdown,
  runNativeGoalWorker,
  type GoalStatus,
  type GoalRecord,
  type GoalTransport,
  type GoalWaitResult,
  type GoalWaitOptions,
  type GoalObservation,
  type GoalWorkerArtifact,
  type GoalLivenessArtifact,
  type GoalStallArtifact,
  type GoalWorkerResult,
} from "./v3/goal-worker.js";
export {
  runMachineGatePhase,
  type V3GateConfig,
  type MachineGatePhaseResult,
} from "./v3/machine-gate.js";
export {
  runCheckpointPhase,
  type V3CheckpointConfig,
  type CheckpointResult,
} from "./v3/checkpoint.js";
export {
  runV3WorkSlice,
  type V3WorkConfig,
  type V3WorkResult,
} from "./v3/work.js";
export { createIsolatedWorktree } from "./v3/isolation.js";
export {
  recordUsageLedger,
  summarizeUsageLedger,
  usageLedgerPath,
  type UsageLedgerEntry,
  type UsageLedgerSummary,
} from "./usage-ledger.js";
export {
  runAutonomousObligationLoop,
  type AutonomousEvent,
  type AutonomousObligation,
  type AutonomousState,
  type AutonomousHandlers,
  type AutonomousTelemetry,
} from "./v3/autonomous-loop.js";
export {
  OBLIGATION_STATUSES,
  HUMAN_CATEGORIES,
  summarizeObligations,
  syncObligationsFromProject,
  loadObligationLedger,
  saveObligationLedger,
  loadHumanBacklog,
  addHumanBacklogItem,
  markObligationHumanBlocked,
  resolveHumanBacklogItem,
  obligationsPath,
  humanBacklogPath,
  type Obligation,
  type ObligationStatus,
  type HumanCategory,
  type ObligationLedger,
  type HumanBacklog,
  type HumanBacklogItem,
} from "./v3/obligations.js";
export {
  HUMAN_CATEGORIES as HUMAN_BOUNDARY_CATEGORIES,
  HUMAN_SCOPES,
  isHumanCategory,
  isHumanScope,
  assertHumanCategory,
  isTechnicalHumanReason,
  validateHumanRequiredItem,
  validateHumanResponse,
  compileMinimalHumanRequired,
  filterUnresolvedHumanCandidates,
  evaluateHumanBoundary,
  humanResponseAppliesTo,
  humanRequiredPath,
  humanRequiredMarkdownPath,
  humanResponsesPath,
  persistHumanRequired,
  persistHumanResponse,
  ingestHumanResponse,
  humanResponseAuditValue,
  type HumanCategory as HumanBoundaryCategory,
  type HumanScope,
  type HumanRequiredItem,
  type HumanResponse,
  type HumanCandidate,
  type HumanBoundaryStatus,
  type HumanGateCounts,
} from "./v3/human-boundary.js";
export {
  RECOVERY_OPEN_MARKER,
  RECOVERY_CLOSE_MARKER,
  HUMAN_REASON_CATEGORIES,
  parseChiefRecoveryDecision,
  prepareChiefRecovery,
  applyChiefRecoveryDecision,
  persistWorkerBlock,
  stableFailureSignature,
  normalizeFailureSignature,
  recordFailureSignature,
  type FailureSignatureRecord,
  type RecoveryAction,
  type ChiefRecoveryDecision,
  type RecoveryPreparation,
} from "./v3/recovery.js";
export {
  buildRecentDevlogContext,
  createDevlogHandoff,
  validateSemanticContext,
  validateDevlogHandoff,
  writeDevlogDecision,
  writeDevlogResult,
  type DevlogEntry,
  type DevlogHandoffOptions,
} from "./devlog.js";
export {
  runIntegrationUatPhase,
  type IntegrationUatAction,
  type IntegrationUatOutcome,
  type IntegrationUatResult,
  type V3IntegrationUatConfig,
} from "./v3/integration-uat.js";
