#!/usr/bin/env node

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireActiveWriterLock,
  applyChiefRecoveryDecision,
  getChiefRunDir,
  parseChiefRecoveryDecision,
  prepareChiefRecovery,
  releaseActiveWriterLock,
  RECOVERY_CLOSE_MARKER,
} from "@daonhan/ralph-core";
import { createV3CodexChiefTransport } from "./ralph-chief-v3-codex.js";
import { extractMarkedJsonBlock } from "./ralph-gui-bridge.js";

function runStatePath(projectRoot, runId) {
  return join(getChiefRunDir(projectRoot, runId), "RUN_STATE.json");
}

export function chiefRecoveryPrompt(preparation) {
  return [
    "You are Ralph V3 CHIEF_RECOVERY. Use a fresh read-only Host Codex context.",
    "Technical tests, builds, missing commands, UI/loopback, sandbox, stalls, and disconnects must remain technical and must never become HUMAN_BLOCK.",
    "Only BUSINESS_DECISION, CREDENTIAL_OR_SECRET, EXTERNAL_AUTHORIZATION, USER_ONLY_INPUT, or IRREVERSIBLE_EXTERNAL_ACTION may use HUMAN_BLOCK.",
    "Do not modify code, Git, RUN_STATE, or evidence. Return exactly one marked JSON block.",
    `run_id: ${preparation.runState.run_id}`,
    `round: ${preparation.runState.round}`,
    `task_id: ${preparation.runState.current_task_id}`,
    `project_state_hash: ${preparation.handoff.project_state_hash}`,
    `worker_block_hash: ${preparation.workerBlockHash}`,
    "",
    preparation.handoffContent,
  ].join("\n");
}

export async function runV3RecoveryTransport(options) {
  const projectRoot = resolve(options.projectRoot);
  const statePath = runStatePath(projectRoot, options.runId);
  const lock = await acquireActiveWriterLock(projectRoot, {
    run_id: options.runId,
    run_state_path: statePath,
  });
  try {
    const preparation = await prepareChiefRecovery(projectRoot, options.runId);
    const transport =
      options.transport ??
      ((request) =>
        createV3CodexChiefTransport({
          projectRoot,
          runId: options.runId,
          chiefConfig: {
            agent: "codex",
            model: "gpt-5.6-sol",
            reasoning_effort: "high",
          },
          logName: "codex-chief-recovery.ndjson",
          timeout_seconds: options.timeout_seconds,
        })(request));
    const response = await transport({
      identity: preparation.workerBlockHash,
      message: chiefRecoveryPrompt(preparation),
      closingMarker: RECOVERY_CLOSE_MARKER,
      runId: options.runId,
      round: preparation.runState.round,
      handoffHash: preparation.workerBlockHash,
    });
    if (!response || typeof response.reply !== "string")
      throw new Error("Chief Recovery transport returned no reply");
    const decision = parseChiefRecoveryDecision(
      extractMarkedJsonBlock(
        response.reply,
        RECOVERY_OPEN_MARKER,
        RECOVERY_CLOSE_MARKER
      )
    );
    return {
      ...(await applyChiefRecoveryDecision(
        projectRoot,
        options.runId,
        decision
      )),
      recovered: false,
    };
  } finally {
    await releaseActiveWriterLock(projectRoot, lock);
  }
}

export { runStatePath };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stderr.write("Use ralph-chief-v3-loop to dispatch CHIEF_RECOVERY.\n");
}
