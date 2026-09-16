#!/usr/bin/env node

import { spawn as nodeSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateSupervisorDisposition,
  getChiefRunDir,
  loadRunState,
  supervisorFailureFingerprint,
  supervisorRestartBackoffMs,
  writeJsonAtomic,
} from "@daonhan/ralph-core";

function statePath(projectRoot, runId) {
  return join(getChiefRunDir(resolve(projectRoot), runId), "RUN_STATE.json");
}

/**
 * Backwards-compatible projection of the restart matrix. Prefer
 * `evaluateSupervisorDisposition` when the reason matters.
 */
function isTerminal(state) {
  return !evaluateSupervisorDisposition({ runState: state }).restart;
}

async function readStateSafe(path) {
  try {
    return await loadRunState(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readTelemetrySafe(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return undefined;
  }
}

/**
 * A deliberately thin process supervisor. It never interprets business rules
 * and never writes run state; durable RUN_STATE plus the restart matrix decide
 * whether the Controller is started again.
 *
 * The matrix exists because restarting a Controller that is legally parked on
 * an external dependency produces no progress and an unbounded restart spin.
 * Only durable evidence of a pending autonomous recovery action, or durable
 * work that still requires execution, justifies a restart.
 */
export async function runV3Supervisor(options) {
  const projectRoot = resolve(options.projectRoot);
  const runId = options.runId;
  const runDir = getChiefRunDir(projectRoot, runId);
  const runPath = statePath(projectRoot, runId);
  const telemetryPath = join(runDir, "telemetry.json");
  const supervisorStatePath = join(runDir, "SUPERVISOR_STATE.json");
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const controller =
    options.controller ??
    process.env.RALPH_V3_CONTROLLER ??
    join(dirname(fileURLToPath(import.meta.url)), "ralph-chief-v3-loop.js");
  const controllerArgs = options.controllerArgs ?? [];
  const maxRestarts = options.maxRestarts ?? 1000;
  const restartDelayMs = Math.max(0, options.restartDelayMs ?? 1000);
  const maxRestartDelayMs = Math.max(
    restartDelayMs,
    options.maxRestartDelayMs ?? 60_000
  );
  const rapidRestartWindowMs = Math.max(
    0,
    options.rapidRestartWindowMs ?? 10_000
  );
  const maxRapidRestarts = Math.max(1, options.maxRapidRestarts ?? 5);
  const now = options.now ?? (() => Date.now());
  const startedAt = new Date().toISOString();
  const events = [];
  let restartCount = 0;
  let lastExit = null;
  let lastDisposition;
  let lastFingerprint;
  let consecutiveIdentical = 0;
  let lastRestartAt;
  let lastBackoffMs = 0;

  const persist = async (extra = {}) => {
    await writeJsonAtomic(supervisorStatePath, {
      version: 1,
      run_id: runId,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
      restart_count: restartCount,
      last_exit: lastExit,
      events,
      last_disposition: lastDisposition,
      last_fingerprint: lastFingerprint,
      consecutive_identical_failures: consecutiveIdentical,
      last_backoff_ms: lastBackoffMs,
      ...extra,
    });
  };

  while (true) {
    const before = await readStateSafe(runPath);
    const telemetry = await readTelemetrySafe(telemetryPath);
    const decision = evaluateSupervisorDisposition({
      runState: before,
      telemetry,
    });
    lastDisposition = {
      kind: decision.kind,
      restart: decision.restart,
      reason: decision.reason,
    };
    if (!decision.restart) {
      const status = before?.phase ?? "STABLE";
      await persist({
        stopped_reason: decision.reason,
        technical_open: decision.kind.endsWith("TECHNICAL_OPEN"),
      });
      return {
        status,
        disposition: decision,
        runState: before,
        restartCount,
        events,
      };
    }

    const child = spawnImpl(process.execPath, [controller, ...controllerArgs], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...(options.childEnv ?? {}),
        RALPH_SUPERVISED: "1",
        RALPH_RUN_ID: runId,
      },
      stdio: options.stdio ?? "inherit",
    });
    const exit = await new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    lastExit = exit;
    const after = await readStateSafe(runPath);
    const fingerprint = supervisorFailureFingerprint({
      runState: after,
      exit,
    });
    events.push({
      at: new Date().toISOString(),
      attempt: restartCount + 1,
      exit,
      phase: after?.phase ?? null,
      status: after?.status ?? null,
      fingerprint,
    });

    // The child may have completed the run or parked it legally. Decide from
    // durable state before counting anything as a restart.
    const settled = evaluateSupervisorDisposition({
      runState: after,
      telemetry: await readTelemetrySafe(telemetryPath),
    });
    lastFingerprint = fingerprint;
    if (!settled.restart) {
      lastDisposition = {
        kind: settled.kind,
        restart: settled.restart,
        reason: settled.reason,
      };
      await persist({
        stopped_reason: settled.reason,
        technical_open: settled.kind.endsWith("TECHNICAL_OPEN"),
      });
      return {
        status: after?.phase ?? "STABLE",
        disposition: settled,
        runState: after,
        restartCount,
        events,
      };
    }

    if (restartCount >= maxRestarts) {
      lastDisposition = {
        kind: "STABLE_TECHNICAL_OPEN",
        restart: false,
        reason: `restart budget exhausted after ${restartCount} restarts`,
      };
      await persist({
        stopped_reason: lastDisposition.reason,
        technical_open: true,
      });
      return {
        status: "SUPERVISOR_RESTART_BUDGET_EXHAUSTED",
        disposition: lastDisposition,
        runState: after,
        restartCount,
        events,
      };
    }

    restartCount += 1;
    lastBackoffMs = supervisorRestartBackoffMs(restartCount, {
      baseMs: restartDelayMs,
      maxMs: maxRestartDelayMs,
    });

    const at = now();
    const rapid =
      lastRestartAt !== undefined && at - lastRestartAt <= rapidRestartWindowMs;
    consecutiveIdentical =
      rapid && fingerprint === lastFingerprint ? consecutiveIdentical + 1 : 1;
    lastFingerprint = fingerprint;
    lastRestartAt = at;
    if (consecutiveIdentical >= maxRapidRestarts) {
      // A crash loop is a technical condition, never a human business question.
      // Stop burning restarts and leave the run's durable state untouched so a
      // later attempt (or an operator) can still make progress.
      const reason = `bounded backoff: ${consecutiveIdentical} identical rapid controller failures with no durable progress`;
      lastDisposition = {
        kind: "STABLE_TECHNICAL_OPEN",
        restart: false,
        reason,
      };
      await persist({ stopped_reason: reason, technical_open: true });
      return {
        status: "SUPERVISOR_BACKED_OFF",
        disposition: lastDisposition,
        runState: after,
        restartCount,
        events,
      };
    }

    await persist();
    if (lastBackoffMs > 0) await sleep(lastBackoffMs);
  }
}

export { statePath, isTerminal };

if (process.argv[1] && process.argv[1].endsWith("ralph-v3-supervisor.js")) {
  const cliArgs = process.argv.slice(2);
  const values = {};
  for (let index = 0; index < cliArgs.length; index += 1) {
    const arg = cliArgs[index];
    if (!["--repo", "--run-id", "--config", "--chief-mode"].includes(arg)) {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      process.exitCode = 2;
      break;
    }
    const value = cliArgs[++index];
    if (!value || value.startsWith("--")) {
      process.stderr.write(`${arg} requires a value\n`);
      process.exitCode = 2;
      break;
    }
    values[arg.slice(2).replaceAll("-", "_")] = value;
  }
  const projectRoot = values.repo;
  const runId = values.run_id;
  const configPath = values.config;
  if (!projectRoot || !runId || !configPath) {
    process.stderr.write(
      "Usage: ralph-v3-supervisor --repo ROOT --run-id ID --config FILE\n"
    );
    process.exitCode = 2;
  } else {
    const controllerArgs = [
      "--repo",
      projectRoot,
      "--run-id",
      runId,
      "--config",
      configPath,
    ];
    if (values.chief_mode !== undefined)
      controllerArgs.push("--chief-mode", values.chief_mode);
    runV3Supervisor({
      projectRoot,
      runId,
      controllerArgs,
    })
      .then((result) => {
        process.stdout.write(
          `SUPERVISOR_${result.status} restarts=${result.restartCount}\n`
        );
        if (
          result.status === "SUPERVISOR_RESTART_BUDGET_EXHAUSTED" ||
          result.status === "SUPERVISOR_BACKED_OFF"
        )
          process.exitCode = 1;
      })
      .catch((error) => {
        process.stderr.write(
          `SUPERVISOR_FAILED: ${error?.message ?? String(error)}\n`
        );
        process.exitCode = 1;
      });
  }
}
