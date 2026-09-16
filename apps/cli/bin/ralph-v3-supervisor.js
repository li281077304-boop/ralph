#!/usr/bin/env node

import { spawn as nodeSpawn } from "node:child_process";
import { join, resolve } from "node:path";

import {
  getChiefRunDir,
  loadRunState,
  writeJsonAtomic,
} from "@daonhan/ralph-core";

function statePath(projectRoot, runId) {
  return join(getChiefRunDir(resolve(projectRoot), runId), "RUN_STATE.json");
}

function isTerminal(state) {
  return (
    state.phase === "DONE" ||
    state.phase === "WAITING_FOR_HUMAN" ||
    state.phase === "HUMAN_REQUIRED" ||
    (state.status === "paused" && state.stop_reason)
  );
}

async function readStateSafe(path) {
  try {
    return await loadRunState(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * A deliberately thin process supervisor. It never interprets business
 * rules; durable RUN_STATE is the only completion/stop authority.
 */
export async function runV3Supervisor(options) {
  const projectRoot = resolve(options.projectRoot);
  const runId = options.runId;
  const runPath = statePath(projectRoot, runId);
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const controller =
    options.controller ??
    join(projectRoot, "apps/cli/bin/ralph-chief-v3-loop.js");
  const controllerArgs = options.controllerArgs ?? [];
  const maxRestarts = options.maxRestarts ?? 1000;
  const restartDelayMs = Math.max(0, options.restartDelayMs ?? 1000);
  const startedAt = new Date().toISOString();
  const events = [];
  let restartCount = 0;

  while (true) {
    const before = await readStateSafe(runPath);
    if (before && isTerminal(before)) {
      return { status: before.phase, runState: before, restartCount, events };
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
    const after = await readStateSafe(runPath);
    const event = {
      at: new Date().toISOString(),
      attempt: restartCount + 1,
      exit,
      phase: after?.phase ?? null,
      status: after?.status ?? null,
    };
    events.push(event);
    await writeJsonAtomic(
      join(getChiefRunDir(projectRoot, runId), "SUPERVISOR_STATE.json"),
      {
        version: 1,
        run_id: runId,
        started_at: startedAt,
        updated_at: event.at,
        restart_count: restartCount,
        last_exit: exit,
        events,
      }
    );
    if (after && isTerminal(after))
      return { status: after.phase, runState: after, restartCount, events };
    if (restartCount >= maxRestarts)
      return {
        status: "SUPERVISOR_RESTART_BUDGET_EXHAUSTED",
        runState: after,
        restartCount,
        events,
      };
    restartCount += 1;
    if (restartDelayMs > 0) await sleep(restartDelayMs);
  }
}

export { statePath, isTerminal };

if (process.argv[1] && process.argv[1].endsWith("ralph-v3-supervisor.js")) {
  const cliArgs = process.argv.slice(2);
  const values = {};
  for (let index = 0; index < cliArgs.length; index += 1) {
    const arg = cliArgs[index];
    if (!["--repo", "--run-id", "--config"].includes(arg)) {
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
    runV3Supervisor({
      projectRoot,
      runId,
      controllerArgs: [
        "--repo",
        projectRoot,
        "--run-id",
        runId,
        "--config",
        configPath,
      ],
    })
      .then((result) => {
        process.stdout.write(
          `SUPERVISOR_${result.status} restarts=${result.restartCount}\n`
        );
        if (result.status === "SUPERVISOR_RESTART_BUDGET_EXHAUSTED")
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
