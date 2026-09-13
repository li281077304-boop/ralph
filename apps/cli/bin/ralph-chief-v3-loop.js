#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import {
  getChiefRunDir,
  loadChiefConfig,
  loadRunState,
  runV3WorkSlice,
} from "@daonhan/ralph-core";
import { runV3SelectTransport } from "./ralph-chief-v3-select.js";
import { runV3ReviewTransport } from "./ralph-chief-v3-review.js";

function runStatePath(projectRoot, runId) {
  return join(getChiefRunDir(projectRoot, runId), "RUN_STATE.json");
}

function workConfig(config) {
  return {
    worker: config.worker,
    commands: config.commands,
    timeout_seconds: config.timeout_seconds,
    gate_allowed_paths: config.gate_allowed_paths,
    required_clean_patterns: config.required_clean_patterns,
    forbidden_paths: config.forbidden_paths,
    protected_paths: config.protected_paths,
    max_diff_bytes: config.max_diff_bytes,
    max_changed_paths: config.max_changed_paths,
    remote: config.remote,
  };
}

function isWaitingFor(state, kind) {
  return (
    state.phase === "WAITING_FOR_CHIEF" && state.waiting_handoff?.kind === kind
  );
}

function result(status, state, extra = {}) {
  return { status, runState: state, ...extra };
}

function phaseMessage(state) {
  if (state.phase === "SELECT") return "总工正在选择任务";
  if (isWaitingFor(state, "select")) return "正在恢复总工选择";
  if (state.phase === "WORKER") return "Luna Goal 正在施工";
  if (state.phase === "MACHINE_GATE") return "正在进行机器验收";
  if (state.phase === "CHECKPOINT") return "正在创建并推送检查点";
  if (state.phase === "CHIEF_REVIEW") return "外部总工正在独立审查 GitHub";
  if (isWaitingFor(state, "review")) return "正在恢复外部总工审查";
  return undefined;
}

/** Route durable V3 phases; each existing runner owns its own writer lock. */
export async function runV3BigLoop(options) {
  const projectRoot = resolve(options.projectRoot);
  const runId = options.runId;
  const config = options.config ?? loadChiefConfig(options.configPath);
  if (!options.phaseHandlers && config.chief_mode !== "external")
    throw new Error("V3 Big Loop requires chief_mode: external");
  const loadState =
    options.loadState ?? (() => loadRunState(runStatePath(projectRoot, runId)));
  const handlers = options.phaseHandlers ?? {
    select: () =>
      runV3SelectTransport({
        projectRoot,
        runId,
        guiConfig: config.gui_bridge,
      }),
    work: () =>
      runV3WorkSlice({
        projectRoot,
        runId,
        config: workConfig(config),
      }),
    review: () =>
      runV3ReviewTransport({
        projectRoot,
        runId,
        guiConfig: config.gui_bridge,
      }),
  };
  const maxIterations = options.maxIterations ?? config.max_iterations;
  let dispatches = 0;

  while (true) {
    const state = await loadState(projectRoot, runId);
    if (state.round > maxIterations)
      return result("MAX_ITERATIONS_REACHED", state, {
        reason: `max_iterations=${maxIterations}`,
        dispatches,
      });
    if (state.phase === "DONE")
      return result("TASK_PASS", state, { dispatches });
    if (state.phase === "HUMAN_REQUIRED")
      return result("HUMAN_REQUIRED", state, { dispatches });
    if (state.phase === "FAILED")
      return result("FAILED", state, { dispatches });
    if (state.phase === "INTEGRATION_UAT" || state.phase === "FINAL_REVIEW")
      return result("NEXT_PHASE_REQUIRED", state, {
        nextPhase: state.phase,
        dispatches,
      });

    let handler;
    if (state.phase === "SELECT" && state.status === "running")
      handler = handlers.select;
    else if (isWaitingFor(state, "select")) handler = handlers.select;
    else if (
      ["WORKER", "MACHINE_GATE", "CHECKPOINT"].includes(state.phase) &&
      state.status === "running"
    )
      handler = handlers.work;
    else if (state.phase === "CHIEF_REVIEW" && state.status === "running")
      handler = handlers.review;
    else if (isWaitingFor(state, "review")) handler = handlers.review;
    else if (state.phase === "WAITING_FOR_CHIEF")
      throw new Error(
        `V3 Big Loop cannot route WAITING_FOR_CHIEF kind ${String(state.waiting_handoff?.kind)}`
      );
    else
      throw new Error(
        `V3 Big Loop cannot route phase ${state.phase} with status ${state.status}`
      );

    if (typeof handler !== "function")
      throw new Error(`V3 Big Loop has no handler for phase ${state.phase}`);
    options.onProgress?.({
      round: state.round,
      phase: state.phase,
      message: phaseMessage(state),
      state,
    });
    try {
      await handler(state, { projectRoot, runId, config });
      dispatches += 1;
    } catch (error) {
      const current = await loadState(projectRoot, runId).catch(() => state);
      const reason = error instanceof Error ? error.message : String(error);
      if (current.phase === "WAITING_FOR_CHIEF")
        return result("WAITING_FOR_CHIEF", current, { reason, dispatches });
      if (current.phase === "HUMAN_REQUIRED")
        return result("HUMAN_REQUIRED", current, { reason, dispatches });
      if (current.phase === "FAILED")
        return result("FAILED", current, { reason, dispatches });
      throw error;
    }
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--repo", "--run-id", "--config"].includes(arg))
      throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${arg} requires a value`);
    values[arg.slice(2).replaceAll("-", "_")] = value;
  }
  if (!values.repo || !values.run_id)
    throw new Error(
      "Usage: ralph-chief-v3-loop --repo ROOT --run-id ID --config FILE"
    );
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = loadChiefConfig(args.config);
  const outcome = await runV3BigLoop({
    projectRoot: args.repo,
    runId: args.run_id,
    config,
    onProgress: ({ round, message }) => {
      if (message) process.stdout.write(`[第 ${round} 轮] ${message}\n`);
    },
  });
  process.stdout.write(
    `当前状态：${outcome.status}\n停止原因：${outcome.reason ?? outcome.runState.stop_reason ?? "无"}\n下一步：${outcome.nextPhase ? `进入${outcome.nextPhase}阶段` : outcome.status === "TASK_PASS" ? "任务已完成" : outcome.status === "WAITING_FOR_CHIEF" ? "恢复外部总工后重新运行同一命令" : "按当前状态继续或处理阻塞"}\n`
  );
  if (outcome.status === "FAILED" || outcome.status === "HUMAN_REQUIRED")
    process.exitCode = outcome.status === "FAILED" ? 1 : 2;
  return outcome;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `V3_BIG_LOOP_FAILED: ${error?.message ?? String(error)}\n`
    );
    process.exitCode = 1;
  });
}

export { isWaitingFor, runStatePath, workConfig };
