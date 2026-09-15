#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  acquireActiveWriterLock,
  applyChiefRecoveryDecision,
  getChiefRunDir,
  loadChiefConfig,
  loadRunState,
  parseChiefRecoveryDecision,
  prepareChiefRecovery,
  releaseActiveWriterLock,
} from "@daonhan/ralph-core";
import { createV3CodexChiefTransport } from "./ralph-chief-v3-codex.js";
import { extractMarkedJsonBlock } from "./ralph-gui-bridge.js";
import {
  RECOVERY_CLOSE_MARKER,
  RECOVERY_OPEN_MARKER,
} from "@daonhan/ralph-core";

function runStatePath(projectRoot, runId) {
  return join(getChiefRunDir(projectRoot, runId), "RUN_STATE.json");
}

export function chiefRecoveryPrompt(preparation) {
  return [
    "你是 Ralph V3 的技术总工，负责恢复 Worker 的技术阻塞。",
    "Worker 的技术失败、测试失败、环境限制或实现路线失败都不等于 HUMAN_REQUIRED。请独立检查仓库和证据，给出下一步可执行技术动作。",
    "只有业务决策、凭证/秘密、外部授权、用户独有输入或不可逆外部操作才可 HUMAN_REQUIRED。",
    "不要修改代码，不要修改 Git、RUN_STATE 或任何状态文件。只返回严格 JSON 机器区块。",
    "",
    `run_id: ${preparation.runState.run_id}`,
    `round: ${preparation.runState.round}`,
    `task_id: ${preparation.runState.current_task_id}`,
    `project_state_hash: ${preparation.handoff.project_state_hash}`,
    `worker_block_hash: ${preparation.workerBlockHash}`,
    "",
    "## RECOVERY HANDOFF",
    preparation.handoffContent,
    "",
    RECOVERY_OPEN_MARKER,
    JSON.stringify(
      {
        action: "RETRY_WORKER",
        summary: "",
        technical_diagnosis: "",
        worker_task: "",
        verification_strategy: [],
        why_previous_approach_failed: "",
        why_next_approach_should_work: "",
        human_question: "",
        human_options: [],
        human_required_reason: "",
        run_id: preparation.runState.run_id,
        round: preparation.runState.round,
        task_id: preparation.runState.current_task_id,
        worker_block_hash: preparation.workerBlockHash,
        project_state_hash: preparation.handoff.project_state_hash,
      },
      null,
      2
    ),
    RECOVERY_CLOSE_MARKER,
  ].join("\n");
}

export async function runV3RecoveryTransport(options) {
  const projectRoot = resolve(options.projectRoot);
  const runId = options.runId;
  const statePath = runStatePath(projectRoot, runId);
  const lock = await acquireActiveWriterLock(projectRoot, {
    run_id: runId,
    run_state_path: statePath,
  });
  try {
    const state = await loadRunState(statePath);
    const preparation = await prepareChiefRecovery(projectRoot, runId);
    const transport =
      options.transport ??
      createV3CodexChiefTransport({
        projectRoot,
        runId,
        chiefConfig: options.chiefConfig ?? {},
        logName: "codex-chief-recovery.ndjson",
        timeout_seconds: options.timeout_seconds,
      });
    const result = await transport({
      identity: preparation.workerBlockHash,
      message: chiefRecoveryPrompt(preparation),
      closingMarker: RECOVERY_CLOSE_MARKER,
      runId,
      round: state.round,
      handoffHash: preparation.workerBlockHash,
    });
    if (!result || typeof result.reply !== "string")
      throw new Error("Chief transport returned no reply");
    const raw = extractMarkedJsonBlock(
      result.reply,
      RECOVERY_OPEN_MARKER,
      RECOVERY_CLOSE_MARKER
    );
    const decision = parseChiefRecoveryDecision(raw);
    return {
      ...(await applyChiefRecoveryDecision(projectRoot, runId, decision)),
      recovered: false,
    };
  } finally {
    await releaseActiveWriterLock(projectRoot, lock);
  }
}

export { runStatePath };
