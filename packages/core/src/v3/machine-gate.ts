import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  runMachineGate,
  type MachineGateOptions,
  type MachineGateResult,
} from "../machine-gate.js";
import { GitGuard, workspaceFingerprint } from "../git-guard.js";
import { getChiefRunDir, getRoundDir } from "./rounds.js";
import { loadRunState, saveRunState, type RunState } from "./state.js";
import { writeJsonAtomic } from "./atomic-json.js";
import {
  evaluateRequiredGateEvidence,
  normalizeRequiredCommands,
  requiredGateFailureSummary,
  type GateEvidenceFailure,
} from "./gate-evidence.js";

export type V3GateConfig = {
  commands?: string[];
  timeout_seconds?: number;
  gate_allowed_paths?: string[];
  required_clean_patterns?: string[];
};

export type MachineGatePhaseResult = {
  runState: RunState;
  gate?: MachineGateResult;
  policyFailure?: string;
  /** Present when a REQUIRED command failed, timed out, never ran, or its
   * evidence was missing/malformed. The run must not advance past the gate. */
  requiredGateFailure?: {
    signature: string;
    failures: GateEvidenceFailure[];
  };
};

function runPath(root: string, runId: string): string {
  return join(getChiefRunDir(root, runId), "RUN_STATE.json");
}
function gatePath(root: string, runId: string, round: number): string {
  return join(
    getRoundDir(getChiefRunDir(root, runId), round),
    "machine_gate.json"
  );
}
function patternMatches(path: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const pattern = raw.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!pattern) return false;
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^(?:${escaped})(?:/|$)`).test(path);
  });
}
function requiredCleanMatches(path: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const pattern = raw.replaceAll("\\", "/").replace(/\/$/, "");
    if (!pattern) return false;
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
      .join(".*");
    return (
      new RegExp(`^(?:${escaped})(?:/|$)`).test(path) ||
      new RegExp(`(?:^|/)${escaped}$`).test(path)
    );
  });
}
function failState(state: RunState, reason: string): RunState {
  return {
    ...state,
    phase: "FAILED",
    status: "failed",
    failure_reason: reason,
    updated_at: new Date().toISOString(),
  };
}

/**
 * A failed REQUIRED command is a technical block, not a policy violation and
 * not a reason to abandon the run. Routing to CHIEF_RECOVERY keeps the
 * obligation TECHNICAL_OPEN so the Big Loop can diagnose and retry the Worker,
 * and the gate is re-executed from scratch on the next attempt.
 */
function recoveryState(state: RunState, reason: string): RunState {
  return {
    ...state,
    phase: "CHIEF_RECOVERY",
    status: "running",
    failure_reason: reason,
    updated_at: new Date().toISOString(),
  };
}
async function readArtifact(
  path: string
): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function gateFromArtifact(value: Record<string, unknown>): MachineGateResult {
  if (
    typeof value.passed !== "boolean" ||
    !Array.isArray(value.commands) ||
    !value.before_workspace_fingerprint ||
    !value.after_workspace_fingerprint ||
    typeof value.before_branch !== "string" ||
    typeof value.after_branch !== "string" ||
    typeof value.policy_passed !== "boolean" ||
    !Array.isArray(value.policy_violations) ||
    value.policy_violations.some((item) => typeof item !== "string")
  )
    throw new Error("machine_gate.json is malformed");
  return {
    passed: value.passed,
    commands: value.commands as MachineGateResult["commands"],
    ...(Array.isArray(value.trackedChanges)
      ? { trackedChanges: value.trackedChanges as string[] }
      : {}),
  };
}

export async function runMachineGatePhase(options: {
  projectRoot: string;
  runId: string;
  config: V3GateConfig;
  runGate?: (
    workspaceDir: string,
    options: MachineGateOptions
  ) => Promise<MachineGateResult>;
}): Promise<MachineGatePhaseResult> {
  const path = runPath(options.projectRoot, options.runId);
  const state = await loadRunState(path);
  if (state.phase !== "MACHINE_GATE" || state.status !== "running")
    throw new Error("V3 Machine Gate requires MACHINE_GATE/running state");
  const roundDir = getRoundDir(
    getChiefRunDir(options.projectRoot, options.runId),
    state.round
  );
  await mkdir(roundDir, { recursive: true });
  const outputPath = gatePath(options.projectRoot, options.runId, state.round);
  const guard = new GitGuard(options.projectRoot);
  const before = guard.snapshot();
  const workerEvidencePath = join(roundDir, "worker_evidence.json");
  const workerEvidence = await readArtifact(workerEvidencePath);
  const existing = await readArtifact(outputPath);
  // A PASSING gate artifact may be re-proven so that a crash between the gate
  // and the checkpoint does not re-run commands. A FAILED artifact is never
  // reusable evidence: the run was blocked because the required commands did
  // not pass, so the only honest way forward is to execute them again on the
  // current workspace. Re-using a failure would make "repair and re-gate"
  // impossible and would pin the run in a permanent block.
  const reusable =
    existing !== undefined && existing.required_gate_passed === true;
  if (
    !reusable &&
    (!workerEvidence ||
      workerEvidence.completed !== true ||
      JSON.stringify(workerEvidence.after_workspace_fingerprint) !==
        JSON.stringify(workspaceFingerprint(before)) ||
      workerEvidence.after_branch !== before.branch)
  ) {
    const failed = failState(
      state,
      "Machine Gate requires a matching completed Worker evidence artifact"
    );
    await saveRunState(path, failed);
    return { runState: failed, policyFailure: failed.failure_reason };
  }
  if (!workerEvidence) throw new Error("Machine Gate requires Worker evidence");
  // An artifact that predates the required-command contract cannot be trusted
  // by inspection, so it is regenerated: the configured commands are genuinely
  // re-executed below rather than re-interpreted from weaker evidence.
  if (reusable) {
    const expected = existing.after_workspace_fingerprint;
    if (
      expected &&
      JSON.stringify(expected) !== JSON.stringify(workspaceFingerprint(before))
    )
      throw new Error("machine gate recovery workspace fingerprint mismatch");
    const gate = gateFromArtifact(existing);
    const beforeBranch = existing.before_branch;
    const afterBranch = existing.after_branch;
    if (
      typeof beforeBranch !== "string" ||
      typeof afterBranch !== "string" ||
      beforeBranch !== afterBranch ||
      afterBranch !== before.branch ||
      !workerEvidence ||
      workerEvidence.completed !== true ||
      workerEvidence.after_branch !== afterBranch
    ) {
      throw new Error("machine gate recovery branch evidence mismatch");
    }
    if (!existing.policy_passed) {
      const violations = existing.policy_violations as string[];
      const failed = failState(
        state,
        `Machine Gate policy failure: ${violations.join(", ")}`
      );
      await saveRunState(path, failed);
      return {
        runState: failed,
        gate,
        policyFailure: failed.failure_reason,
      };
    }
    // Resuming at the gate boundary must re-prove the required commands from
    // the durable artifact. A recorded failure here can never be skipped just
    // because the process restarted.
    const resumedVerdict = evaluateRequiredGateEvidence(
      existing,
      options.config.commands
    );
    if (!resumedVerdict.ok) {
      const blocked = recoveryState(
        state,
        `Machine Gate required command failure: ${requiredGateFailureSummary(resumedVerdict)}`
      );
      await saveRunState(path, blocked);
      return {
        runState: blocked,
        gate,
        requiredGateFailure: {
          signature: resumedVerdict.signature,
          failures: resumedVerdict.failures,
        },
      };
    }
    const next: RunState = {
      ...state,
      phase: "CHECKPOINT",
      status: "running",
      updated_at: new Date().toISOString(),
    };
    await saveRunState(path, next);
    return { runState: next, gate };
  }
  const runGate = options.runGate ?? runMachineGate;
  const gate = await runGate(options.projectRoot, {
    commands: options.config.commands ?? [],
    // UAT is a distinct V3 phase; normal MACHINE_GATE never runs it.
    uatCommands: [],
    timeoutMs: (options.config.timeout_seconds ?? 1800) * 1000,
    allowedGeneratedPaths: options.config.gate_allowed_paths ?? [],
  });
  const after = guard.snapshot();
  const trackedChanges = guard.trackedChangedPaths(before, after);
  const allowed = options.config.gate_allowed_paths ?? [];
  const requiredClean = options.config.required_clean_patterns ?? [];
  const disallowed = trackedChanges.filter(
    (path) => !patternMatches(path, allowed)
  );
  const workerChanged = Array.isArray(workerEvidence.changed_paths)
    ? (workerEvidence.changed_paths as string[])
    : [];
  const requiredCleanViolations = [
    ...new Set([...workerChanged, ...trackedChanges]),
  ]
    .filter((path) => requiredCleanMatches(path, requiredClean))
    .map((path) => `required_clean:${path}`);
  const artifactValue = {
    version: 1,
    ...gate,
    trackedChanges: trackedChanges.length
      ? trackedChanges
      : gate.trackedChanges,
    before_workspace_fingerprint: workspaceFingerprint(before),
    after_workspace_fingerprint: workspaceFingerprint(after),
    before_branch: before.branch,
    after_branch: after.branch,
    created_at: new Date().toISOString(),
  };
  if (after.head !== before.head) disallowed.push("HEAD");
  if (after.branch !== before.branch) disallowed.push("branch");
  disallowed.push(...requiredCleanViolations);
  const policyPassed = disallowed.length === 0;
  const artifactWithPolicy = {
    ...artifactValue,
    policy_passed: policyPassed,
    policy_violations: disallowed,
  };
  const configuredCommands = normalizeRequiredCommands(options.config.commands);
  const requiredVerdict = evaluateRequiredGateEvidence(
    { ...artifactWithPolicy, required_commands: configuredCommands },
    configuredCommands
  );
  const artifactWithEvidence = {
    ...artifactWithPolicy,
    required_commands: configuredCommands,
    required_gate_passed: requiredVerdict.ok,
    required_gate_failures: requiredVerdict.failures,
    gate_outcome: policyPassed && requiredVerdict.ok ? "PASS" : "FAILED",
  };
  await writeJsonAtomic(outputPath, artifactWithEvidence);
  if (!policyPassed) {
    const failed = failState(
      state,
      `Machine Gate policy failure: ${disallowed.join(", ")}`
    );
    await saveRunState(path, failed);
    return {
      runState: failed,
      gate: { ...gate, trackedChanges: disallowed },
      policyFailure: failed.failure_reason,
    };
  }
  // Fail closed: a REQUIRED command that failed, timed out, never ran, or has
  // missing/malformed evidence blocks checkpoint, commit, push and every later
  // phase. `policy_passed` is deliberately not consulted here.
  if (!requiredVerdict.ok) {
    const blocked = recoveryState(
      state,
      `Machine Gate required command failure: ${requiredGateFailureSummary(requiredVerdict)}`
    );
    await saveRunState(path, blocked);
    return {
      runState: blocked,
      gate,
      requiredGateFailure: {
        signature: requiredVerdict.signature,
        failures: requiredVerdict.failures,
      },
    };
  }
  const next = {
    ...state,
    phase: "CHECKPOINT" as const,
    status: "running" as const,
    head_evidence: {
      ...(state.head_evidence ?? {}),
      head: after.head,
      diff_hash: workspaceFingerprint(after).trackedDiffHash,
    },
    updated_at: new Date().toISOString(),
  };
  await saveRunState(path, next);
  return { runState: next, gate };
}
