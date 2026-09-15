import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { acquireActiveWriterLock, releaseActiveWriterLock } from "./lock.js";
import { getChiefRunDir } from "./rounds.js";
import { loadRunState, saveRunState, type RunState } from "./state.js";
import {
  runWorkerPhase,
  type V3WorkerConfig,
  type V3WorkerRunner,
} from "./worker.js";
import { runMachineGatePhase } from "./machine-gate.js";
import { runCheckpointPhase } from "./checkpoint.js";
import { dispatchPhase } from "./phases.js";
import type { MachineGateOptions, MachineGateResult } from "../machine-gate.js";
import type { GoalTransport } from "./goal-worker.js";

export type V3WorkConfig = V3WorkerConfig & {
  commands?: string[];
  timeout_seconds?: number;
  gate_allowed_paths?: string[];
  required_clean_patterns?: string[];
  remote?: string;
  devlogRoot?: string;
};

export type V3WorkResult = {
  runState: RunState;
  gate?: MachineGateResult;
  checkpoint?: Record<string, unknown>;
};

function runPath(root: string, runId: string): string {
  return join(getChiefRunDir(root, runId), "RUN_STATE.json");
}

export async function runV3WorkSlice(options: {
  projectRoot: string;
  runId: string;
  config: V3WorkConfig;
  devlogRoot?: string;
  runAgent?: V3WorkerRunner;
  /** Test seam for a protocol-level fake; production leaves this undefined. */
  goalTransport?: GoalTransport;
  runGate?: (
    workspaceDir: string,
    options: MachineGateOptions
  ) => Promise<MachineGateResult>;
}): Promise<V3WorkResult> {
  const projectRoot = resolve(options.projectRoot);
  const statePath = runPath(projectRoot, options.runId);
  const lock = await acquireActiveWriterLock(projectRoot, {
    run_id: options.runId,
    run_state_path: statePath,
  });
  try {
    try {
      let state = await loadRunState(statePath);
      if (state.phase === "CHIEF_REVIEW" && state.status === "running")
        return { runState: state };
      if (!["WORKER", "MACHINE_GATE", "CHECKPOINT"].includes(state.phase))
        throw new Error(`V3 work runner cannot execute phase ${state.phase}`);
      let gate: MachineGateResult | undefined;
      if (state.phase === "WORKER") {
        const worker = (await dispatchPhase(state, {
          WORKER: () =>
            runWorkerPhase({
              projectRoot,
              runId: options.runId,
              config: options.config,
              devlogRoot: options.devlogRoot ?? options.config.devlogRoot,
              runAgent: options.runAgent,
              goalTransport: options.goalTransport,
            }),
        })) as Awaited<ReturnType<typeof runWorkerPhase>>;
        state = worker.runState;
        if (state.phase === "FAILED") return { runState: state };
      }
      if (state.phase === "MACHINE_GATE") {
        const gated = (await dispatchPhase(state, {
          MACHINE_GATE: () =>
            runMachineGatePhase({
              projectRoot,
              runId: options.runId,
              config: options.config,
              runGate: options.runGate,
            }),
        })) as Awaited<ReturnType<typeof runMachineGatePhase>>;
        state = gated.runState;
        gate = gated.gate;
        if (state.phase === "FAILED") return { runState: state, gate };
      }
      if (state.phase === "CHECKPOINT") {
        // A crash can occur after the gate artifact is durable but before the
        // checkpoint phase is resumed. Reuse that exact result; do not rerun a
        // command merely because the process restarted.
        try {
          const gatePath = join(
            getChiefRunDir(projectRoot, options.runId),
            "rounds",
            String(state.round).padStart(3, "0"),
            "machine_gate.json"
          );
          const persisted = JSON.parse(
            await readFile(gatePath, "utf8")
          ) as Record<string, unknown>;
          if (
            typeof persisted.passed === "boolean" &&
            Array.isArray(persisted.commands)
          ) {
            gate = {
              passed: persisted.passed,
              commands: persisted.commands as MachineGateResult["commands"],
              ...(Array.isArray(persisted.trackedChanges)
                ? { trackedChanges: persisted.trackedChanges as string[] }
                : {}),
            };
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const checkpoint = (await dispatchPhase(state, {
          CHECKPOINT: () =>
            runCheckpointPhase({
              projectRoot,
              runId: options.runId,
              config: { remote: options.config.remote },
              gate,
            }),
        })) as Awaited<ReturnType<typeof runCheckpointPhase>>;
        return {
          runState: checkpoint.runState,
          gate,
          checkpoint: checkpoint.checkpoint,
        };
      }
      return { runState: state, gate };
    } catch (error) {
      const current = await loadRunState(statePath).catch(() => undefined);
      if (
        current &&
        (current.phase === "WORKER" || current.phase === "MACHINE_GATE")
      ) {
        const reason = error instanceof Error ? error.message : String(error);
        await saveRunState(statePath, {
          ...current,
          phase: "FAILED",
          status: "failed",
          failure_reason: reason,
          updated_at: new Date().toISOString(),
        });
      }
      throw error;
    }
  } finally {
    await releaseActiveWriterLock(projectRoot, lock);
  }
}
