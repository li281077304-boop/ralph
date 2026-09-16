#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readFile, cp, mkdir } from "node:fs/promises";

import {
  getChiefRunDir,
  loadChiefConfig,
  loadRunState,
  runV3WorkSlice,
  runIntegrationUatPhase,
  createIsolatedWorktree,
  writeJsonAtomic,
  recordUsageLedger,
  summarizeObligations,
  syncObligationsFromProject,
} from "@daonhan/ralph-core";
import { runV3SelectTransport } from "./ralph-chief-v3-select.js";
import { runV3ReviewTransport } from "./ralph-chief-v3-review.js";
import { createV3CodexChiefTransport } from "./ralph-chief-v3-codex.js";
import { runV3RecoveryTransport } from "./ralph-chief-v3-recovery.js";
import {
  externalChiefPreflight,
  runExternalChiefGuiRoundtrip,
} from "./ralph-gui-chief-bridge.js";
import { routeChiefCall } from "./ralph-chief-v3-router.js";

function runStatePath(projectRoot, runId) {
  return join(getChiefRunDir(projectRoot, runId), "RUN_STATE.json");
}

function workConfig(config, runId) {
  const worker = config.worker ?? {};
  return {
    // Finite stage turns are the production default. Native Goal remains an
    // explicit compatibility mode for legacy runs only.
    worker: {
      ...worker,
      agent: worker.agent ?? "codex",
      model: worker.model ?? "gpt-5.6-luna",
      reasoning_effort: worker.reasoning_effort ?? "medium",
      mode: worker.mode ?? "stage",
    },
    commands: config.commands,
    timeout_seconds: config.timeout_seconds,
    run_id: runId,
    gate_allowed_paths: config.gate_allowed_paths,
    required_clean_patterns: config.required_clean_patterns,
    forbidden_paths: config.forbidden_paths,
    protected_paths: config.protected_paths,
    max_diff_bytes: config.max_diff_bytes,
    max_changed_paths: config.max_changed_paths,
    remote: config.remote,
  };
}

async function recordChiefRouteTelemetry(projectRoot, runId, patch) {
  await updateTelemetry(projectRoot, runId, patch);
}

/** External-first route with deterministic host fallback. */
export function createExternalFirstChiefTransport({
  primary,
  fallback,
  onPrimaryAttempt,
  onPrimarySuccess,
  onFallback,
}) {
  return async (request) => {
    await onPrimaryAttempt?.(request);
    try {
      const result = await primary(request);
      if (!result || typeof result.reply !== "string")
        throw new Error("Chief transport returned no reply");
      await onPrimarySuccess?.(request, result);
      return result;
    } catch (error) {
      await onFallback?.(request, error);
      return fallback(request, error);
    }
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

const DEFAULT_CHIEF_RETRY_INTERVAL_MS = 15_000;
const DEFAULT_CHIEF_WAIT_BUDGET_MS = 180_000;

function waitingKind(state) {
  if (state.phase !== "WAITING_FOR_CHIEF") return undefined;
  if (state.waiting_handoff?.kind === "select") return "select";
  if (state.waiting_handoff?.kind === "review") return "review";
  throw new Error(
    `V3 Big Loop cannot route WAITING_FOR_CHIEF kind ${String(state.waiting_handoff?.kind)}`
  );
}

function isTransientChiefError(error) {
  const code = error?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "ASSISTANT_REPLY_TIMEOUT" ||
    code === "ASSISTANT_REPLY_INCOMPLETE" ||
    /ASSISTANT_REPLY_TIMEOUT|ASSISTANT_REPLY_INCOMPLETE/.test(message)
  );
}

async function updateTelemetry(projectRoot, runId, patch) {
  const path = join(getChiefRunDir(projectRoot, runId), "telemetry.json");
  let current = {};
  try {
    current = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const next = { version: 1, ...current, ...patch };
  if (!next.run_started_at) next.run_started_at = new Date().toISOString();
  await writeJsonAtomic(path, next);
  return next;
}

function phaseMessage(state) {
  if (state.phase === "SELECT") return "总工正在选择任务";
  if (isWaitingFor(state, "select")) return "正在恢复总工选择";
  if (state.phase === "WORKER") return "Luna Goal 正在施工";
  if (state.phase === "MACHINE_GATE") return "正在进行机器验收";
  if (state.phase === "CHECKPOINT") return "正在创建并推送检查点";
  if (state.phase === "CHIEF_REVIEW") return "外部总工正在独立审查 GitHub";
  if (isWaitingFor(state, "review")) return "正在恢复外部总工审查";
  if (state.phase === "INTEGRATION_UAT") return "正在进行集成验收";
  if (state.phase === "FINAL_REVIEW") return "外部总工正在进行最终审查";
  if (state.phase === "CHIEF_RECOVERY") return "技术总工正在恢复 Worker";
  if (state.phase === "WAITING_FOR_HUMAN") return "等待处理人工待办";
  return undefined;
}
function telemetryPhaseKey(phase) {
  if (phase === "INTEGRATION_UAT") return "uat";
  if (phase === "CHIEF_REVIEW" || phase === "FINAL_REVIEW") return "review";
  if (phase === "WORKER") return "worker";
  return String(phase).toLowerCase();
}

export function resolveChiefStrategy(config, options = {}) {
  const directHostOverride =
    options.directHostOverride === true || options.cliChiefMode === "codex";
  if (
    config.chief_mode === "codex" &&
    !directHostOverride &&
    !options.phaseHandlers
  ) {
    return {
      resolved_chief_strategy: "CONFIGURATION_ERROR",
      external_warm_enabled: false,
      external_recovery_enabled: false,
      host_fallback_enabled: false,
      direct_host_override: false,
      override_source: null,
      error:
        "CONFIGURATION_ERROR: chief_mode: codex requires an explicit direct-host override; production defaults to External-first",
    };
  }
  if (config.chief_mode === "codex") {
    return {
      resolved_chief_strategy: "DIRECT_HOST",
      external_warm_enabled: false,
      external_recovery_enabled: false,
      host_fallback_enabled: false,
      direct_host_override: true,
      override_source:
        options.cliChiefMode === "codex" ? "cli" : "explicit_option",
    };
  }
  return {
    resolved_chief_strategy: "EXTERNAL_FIRST",
    external_warm_enabled: true,
    external_recovery_enabled: Boolean(options.externalRecovery),
    host_fallback_enabled: true,
    direct_host_override: false,
    override_source: null,
  };
}

/** Route durable V3 phases; each existing runner owns its own writer lock. */
export async function runV3BigLoop(options) {
  let projectRoot = resolve(options.projectRoot);
  const runId = options.runId;
  if (options.isolatedWorktree) {
    const isolation = await createIsolatedWorktree({
      projectRoot,
      runId,
      baseCommit: options.baseCommit,
      worktreePath: options.worktreePath,
    });
    const sourceRun = join(projectRoot, ".ralph", "chief-runs", runId);
    const targetRun = join(
      isolation.worktreePath,
      ".ralph",
      "chief-runs",
      runId
    );
    await mkdir(join(targetRun, ".."), { recursive: true });
    await cp(sourceRun, targetRun, { recursive: true, force: false }).catch(
      (error) => {
        if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
      }
    );
    projectRoot = isolation.worktreePath;
  }
  const config = options.config ?? loadChiefConfig(options.configPath);
  if (
    !options.phaseHandlers &&
    !["codex", "external"].includes(config.chief_mode)
  )
    throw new Error("V3 Big Loop requires chief_mode: codex or external");
  const chiefStrategy = resolveChiefStrategy(config, options);
  await writeJsonAtomic(
    join(getChiefRunDir(projectRoot, runId), "CHIEF_STRATEGY.json"),
    {
      version: 1,
      run_id: runId,
      ...chiefStrategy,
      resolved_at: new Date().toISOString(),
    }
  );
  if (chiefStrategy.error) {
    const error = new Error(chiefStrategy.error);
    error.code = "CONFIGURATION_ERROR";
    throw error;
  }
  const codexTransport = (logName, fallbackFrom) =>
    createV3CodexChiefTransport({
      projectRoot,
      runId,
      chiefConfig: config.chief,
      logName,
      fallbackFrom,
      timeout_seconds: config.timeout_seconds,
    });
  const hostFallbackFrom =
    config.chief_mode === "external" ? "external" : undefined;
  let externalRound = null;
  const externalTransport = (request) => {
    externalRound = Number.isInteger(request?.round) ? request.round : null;
    return runExternalChiefGuiRoundtrip(config.gui_bridge, request);
  };
  const runChiefPhase = async (route, externalRun, hostRun) => {
    if (config.chief_mode === "codex") {
      await recordChiefRouteTelemetry(projectRoot, runId, {
        chief_provider: "host_codex",
        [`${route}_host_sol_used`]: true,
      });
      return hostRun();
    }
    const startedAt = Date.now();
    let routeRecord;
    const routed = await routeChiefCall({
      requestedRole: route,
      warmPreflight: async () => externalChiefPreflight(config.gui_bridge),
      recover: options.externalRecovery
        ? async (preflight) =>
            options.externalRecovery({
              projectRoot,
              runId,
              route,
              preflight,
            })
        : undefined,
      external: async () => {
        await recordChiefRouteTelemetry(projectRoot, runId, {
          chief_provider: "external",
          [`${route}_external_attempted`]: true,
        });
        return externalRun();
      },
      host: async (error) => {
        const failure = error?.code ?? error?.message ?? null;
        await recordChiefRouteTelemetry(projectRoot, runId, {
          chief_provider: "host_codex_fallback",
          [`${route}_fallback_reason`]: failure,
          [`${route}_host_sol_fallbacks`]: 1,
        });
        return hostRun();
      },
      record: async (record) => {
        routeRecord = record;
        await recordChiefRouteTelemetry(projectRoot, runId, {
          [`${route}_chief_route`]: record,
          [`${route}_external_recovery_attempted`]:
            record.external_recovery.attempted,
          [`${route}_external_recovery_success`]:
            record.external_recovery.success,
          ...(record.failure_code ? { [`${route}_external_failures`]: 1 } : {}),
        });
      },
    });
    if (routeRecord?.selected_route?.startsWith("EXTERNAL")) {
      await recordChiefRouteTelemetry(projectRoot, runId, {
        [`${route}_external_successes`]: 1,
      });
    }
    if (routeRecord?.external_warm?.success || routeRecord?.failure_code) {
      await recordUsageLedger(projectRoot, {
        timestamp: new Date().toISOString(),
        role: "external_chief",
        provider: "external",
        model: null,
        reasoning_effort: null,
        phase: route.toUpperCase(),
        run_id: runId,
        round: externalRound,
        duration: Date.now() - startedAt,
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        tokens_available: false,
        fallback_from: null,
        failure_signature: routeRecord.failure_code,
      });
    }
    return routed;
  };
  const loadState =
    options.loadState ?? (() => loadRunState(runStatePath(projectRoot, runId)));
  const handlers = options.phaseHandlers ?? {
    select: () =>
      runChiefPhase(
        "select",
        () =>
          runV3SelectTransport({
            projectRoot,
            runId,
            devlogRoot: options.devlogRoot ?? projectRoot,
            guiConfig: config.gui_bridge,
            transport: externalTransport,
          }),
        () =>
          runV3SelectTransport({
            projectRoot,
            runId,
            devlogRoot: options.devlogRoot ?? projectRoot,
            guiConfig: config.gui_bridge,
            transport: codexTransport(
              "codex-chief-select.ndjson",
              hostFallbackFrom
            ),
          })
      ),
    work: () =>
      runV3WorkSlice({
        projectRoot,
        runId,
        devlogRoot: options.devlogRoot ?? projectRoot,
        config: workConfig(config, runId),
      }),
    review: () =>
      runChiefPhase(
        "review",
        () =>
          runV3ReviewTransport({
            projectRoot,
            runId,
            devlogRoot: options.devlogRoot ?? projectRoot,
            guiConfig: config.gui_bridge,
            reviewStage: "chief",
            transport: externalTransport,
          }),
        () =>
          runV3ReviewTransport({
            projectRoot,
            runId,
            devlogRoot: options.devlogRoot ?? projectRoot,
            guiConfig: config.gui_bridge,
            reviewStage: "chief",
            transport: codexTransport(
              "codex-chief-review.ndjson",
              hostFallbackFrom
            ),
          })
      ),
    uat: () =>
      runIntegrationUatPhase({
        projectRoot,
        runId,
        config: {
          uat_commands: config.uat_commands,
          timeout_seconds: config.timeout_seconds,
          gate_allowed_paths: config.gate_allowed_paths,
        },
      }),
    finalReview: () =>
      runChiefPhase(
        "final_review",
        () =>
          runV3ReviewTransport({
            projectRoot,
            runId,
            devlogRoot: options.devlogRoot ?? projectRoot,
            guiConfig: config.gui_bridge,
            reviewStage: "final",
            transport: externalTransport,
          }),
        () =>
          runV3ReviewTransport({
            projectRoot,
            runId,
            devlogRoot: options.devlogRoot ?? projectRoot,
            guiConfig: config.gui_bridge,
            reviewStage: "final",
            transport: codexTransport(
              "codex-chief-final-review.ndjson",
              hostFallbackFrom
            ),
          })
      ),
    recovery: () =>
      runChiefPhase(
        "recovery",
        () =>
          runV3RecoveryTransport({
            projectRoot,
            runId,
            chiefConfig: config.chief,
            timeout_seconds: config.timeout_seconds,
            transport: externalTransport,
          }),
        () =>
          runV3RecoveryTransport({
            projectRoot,
            runId,
            chiefConfig: config.chief,
            timeout_seconds: config.timeout_seconds,
            transport: codexTransport(
              "codex-chief-recovery.ndjson",
              hostFallbackFrom
            ),
          })
      ),
  };
  const maxIterations = options.maxIterations ?? config.max_iterations;
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const now = options.now ?? (() => Date.now());
  const retryIntervalMs = Math.max(
    0,
    options.chiefRetryIntervalMs ??
      config.chief_retry_interval_ms ??
      DEFAULT_CHIEF_RETRY_INTERVAL_MS
  );
  const waitBudgetMs = Math.max(
    0,
    options.chiefWaitBudgetMs ??
      (config.timeout_seconds ?? DEFAULT_CHIEF_WAIT_BUDGET_MS / 1000) * 1000
  );
  let dispatches = 0;
  let waitContext;
  let chiefRetryCount = 0;
  const resumedAt = new Date().toISOString();
  const initialTelemetry = await updateTelemetry(projectRoot, runId, {
    run_id: runId,
    run_last_resumed_at: resumedAt,
  });
  chiefRetryCount = Number(initialTelemetry.chief_retry_count) || 0;

  while (true) {
    const state = await loadState(projectRoot, runId);
    try {
      const obligations = await syncObligationsFromProject(projectRoot, runId);
      await updateTelemetry(
        projectRoot,
        runId,
        summarizeObligations(obligations)
      );
    } catch {
      // Legacy runs may not have V3 project state before SELECT creates it.
    }
    if (state.phase !== "WAITING_FOR_CHIEF") waitContext = undefined;
    if (state.round > maxIterations)
      return result("MAX_ITERATIONS_REACHED", state, {
        reason: `max_iterations=${maxIterations}`,
        dispatches,
      });
    if (state.phase === "DONE")
      return result("TASK_PASS", state, { dispatches });
    if (state.phase === "WAITING_FOR_HUMAN")
      return result("WAITING_FOR_HUMAN", state, { dispatches });
    if (state.phase === "HUMAN_REQUIRED")
      return result("HUMAN_REQUIRED", state, { dispatches });
    if (state.phase === "FAILED")
      return result("FAILED", state, { dispatches });
    if (
      (state.phase === "INTEGRATION_UAT" && !handlers.uat) ||
      (state.phase === "FINAL_REVIEW" && !handlers.finalReview)
    )
      return result("NEXT_PHASE_REQUIRED", state, {
        nextPhase: state.phase,
        dispatches,
      });

    const currentWaitingKind = waitingKind(state);
    if (currentWaitingKind && waitContext?.kind !== currentWaitingKind) {
      waitContext = {
        kind: currentWaitingKind,
        startedAt: now(),
      };
    }

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
    else if (state.phase === "INTEGRATION_UAT" && state.status === "running")
      handler = handlers.uat;
    else if (state.phase === "FINAL_REVIEW" && state.status === "running")
      handler = handlers.finalReview;
    else if (state.phase === "CHIEF_RECOVERY" && state.status === "running")
      handler = handlers.recovery;
    else if (
      isWaitingFor(state, "review") &&
      state.waiting_handoff?.review_stage === "final" &&
      handlers.finalReview
    )
      handler = handlers.finalReview;
    else if (isWaitingFor(state, "review")) handler = handlers.review;
    else if (state.phase === "WAITING_FOR_CHIEF")
      throw new Error("V3 Big Loop cannot route WAITING_FOR_CHIEF");
    else
      throw new Error(
        `V3 Big Loop cannot route phase ${state.phase} with status ${state.status}`
      );

    if (typeof handler !== "function")
      throw new Error(`V3 Big Loop has no handler for phase ${state.phase}`);
    await updateTelemetry(projectRoot, runId, {
      [`${telemetryPhaseKey(state.phase)}_started_at`]:
        new Date().toISOString(),
    });
    options.onProgress?.({
      round: state.round,
      phase: state.phase,
      message: phaseMessage(state),
      state,
    });
    try {
      await handler(state, { projectRoot, runId, config });
      dispatches += 1;
      await updateTelemetry(projectRoot, runId, {
        [`${telemetryPhaseKey(state.phase)}_finished_at`]:
          new Date().toISOString(),
      });
    } catch (error) {
      const current = await loadState(projectRoot, runId).catch(() => state);
      const reason = error instanceof Error ? error.message : String(error);
      if (current.phase === "HUMAN_REQUIRED")
        return result("HUMAN_REQUIRED", current, { reason, dispatches });
      if (current.phase === "FAILED")
        return result("FAILED", current, { reason, dispatches });
      const currentKind = waitingKind(current);
      if (currentKind && isTransientChiefError(error)) {
        if (!waitContext || waitContext.kind !== currentKind) {
          waitContext = { kind: currentKind, startedAt: now() };
        }
        const elapsed = Math.max(0, now() - waitContext.startedAt);
        const remaining = waitBudgetMs - elapsed;
        if (remaining <= 0) {
          const exhaustedAt = new Date().toISOString();
          await updateTelemetry(projectRoot, runId, {
            chief_retry_count: chiefRetryCount,
            chief_last_error: reason,
            chief_wait_budget_exhausted_at: exhaustedAt,
            chief_wait_budget_exhausted: true,
          });
          return result("WAITING_FOR_CHIEF", current, {
            reason,
            dispatches,
            waitBudgetExhausted: true,
            chiefRetryCount,
          });
        }
        chiefRetryCount += 1;
        await updateTelemetry(projectRoot, runId, {
          chief_retry_count: chiefRetryCount,
          chief_last_error: reason,
          chief_last_retry_at: new Date().toISOString(),
          chief_wait_budget_ms: waitBudgetMs,
          chief_wait_started_at: new Date(waitContext.startedAt).toISOString(),
          chief_wait_budget_exhausted: false,
        });
        const delay = Math.min(retryIntervalMs, remaining);
        if (delay > 0) await sleep(delay);
        continue;
      }
      if (current.phase === "WAITING_FOR_CHIEF")
        return result("WAITING_FOR_CHIEF", current, {
          reason,
          dispatches,
          waitBudgetExhausted: false,
          chiefRetryCount,
        });
      throw error;
    }
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--repo", "--run-id", "--config", "--chief-mode"].includes(arg))
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
  if (args.chief_mode !== undefined) {
    if (!["codex", "external"].includes(args.chief_mode))
      throw new Error("--chief-mode must be codex or external");
    config.chief_mode = args.chief_mode;
  }
  const outcome = await runV3BigLoop({
    projectRoot: args.repo,
    runId: args.run_id,
    config,
    cliChiefMode: args.chief_mode,
    directHostOverride: args.chief_mode === "codex",
    devlogRoot: process.env.RALPH_DEVLOG_ROOT ?? args.repo,
    onProgress: ({ round, message }) => {
      if (message) process.stdout.write(`[第 ${round} 轮] ${message}\n`);
    },
  });
  process.stdout.write(
    `当前状态：${outcome.status}\n停止原因：${outcome.reason ?? outcome.runState.stop_reason ?? "无"}\n下一步：${outcome.nextPhase ? `进入${outcome.nextPhase}阶段` : outcome.status === "TASK_PASS" ? "任务已完成" : outcome.status === "WAITING_FOR_CHIEF" ? (outcome.waitBudgetExhausted ? "等待预算耗尽，状态已落盘，可恢复" : "外部总工暂时不可用，状态已落盘") : "按当前状态继续或处理阻塞"}\n`
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
