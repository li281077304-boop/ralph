#!/usr/bin/env node

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireActiveWriterLock,
  applyChiefRecoveryDecision,
  buildRecentDevlogContext,
  createDevlogHandoff,
  getChiefRunDir,
  parseChiefRecoveryDecision,
  prepareChiefRecovery,
  releaseActiveWriterLock,
  RECOVERY_OPEN_MARKER,
  RECOVERY_CLOSE_MARKER,
  validateDevlogHandoff,
  writeDevlogDecision,
  writeDevlogResult,
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
    "Only BUSINESS_DECISION, CREDENTIAL_OR_SECRET, EXTERNAL_AUTHORIZATION, USER_ONLY_INPUT, SOURCE_CONFIRMATION, or IRREVERSIBLE_EXTERNAL_ACTION may use HUMAN_BLOCK.",
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
  const devlogRoot = options.devlogRoot ?? projectRoot;
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
    const request = {
      identity: preparation.workerBlockHash,
      message: chiefRecoveryPrompt(preparation),
      closingMarker: RECOVERY_CLOSE_MARKER,
      runId: options.runId,
      round: preparation.runState.round,
      handoffHash: preparation.workerBlockHash,
    };
    const devlogEntry = await createDevlogHandoff({
      root: devlogRoot,
      slug: `chief-recovery-round-${preparation.runState.round}`,
      runId: options.runId,
      round: preparation.runState.round,
      taskId: preparation.runState.current_task_id ?? undefined,
      handoffHash: preparation.workerBlockHash,
      context: [
        "USER OBSERVATION",
        "The current Worker attempt reported a technical block requiring independent recovery planning.",
        "CONFIRMED FACT",
        `run_id: ${options.runId}`,
        `round: ${preparation.runState.round}`,
        `task_id: ${preparation.runState.current_task_id ?? "none"}`,
        "TECHNICAL ASSESSMENT",
        "Recovery must preserve the blocked evidence and choose a new executable technical route.",
        "REJECTED ASSUMPTIONS",
        "A technical block is not evidence that a user business decision is required.",
        "DECISION",
        "Chief Recovery receives a durable handoff before every invocation.",
        "UNKNOWN / OPEN RISKS",
        await buildRecentDevlogContext(devlogRoot),
      ].join("\n"),
      agentTask: request.message,
    });
    await validateDevlogHandoff(devlogEntry);
    let response;
    try {
      response = await transport(request);
    } catch (error) {
      await writeDevlogResult(
        devlogEntry,
        [
          "TESTED",
          `result: ${error instanceof Error ? error.message : String(error)}`,
          "chief_route: CHIEF_RECOVERY",
          `run_id: ${options.runId}`,
          `round: ${preparation.runState.round}`,
          "REAL-UAT-VERIFIED: NOT-YET-VERIFIED",
        ].join("\n")
      );
      throw error;
    }
    await writeDevlogResult(
      devlogEntry,
      [
        "TESTED",
        "chief_route: CHIEF_RECOVERY",
        `run_id: ${options.runId}`,
        `round: ${preparation.runState.round}`,
        "REAL-UAT-VERIFIED: NOT-YET-VERIFIED",
      ].join("\n")
    );
    if (!response || typeof response.reply !== "string")
      throw new Error("Chief Recovery transport returned no reply");
    const decision = parseChiefRecoveryDecision(
      extractMarkedJsonBlock(
        response.reply,
        RECOVERY_OPEN_MARKER,
        RECOVERY_CLOSE_MARKER
      )
    );
    const applied = await applyChiefRecoveryDecision(
      projectRoot,
      options.runId,
      decision
    );
    await writeDevlogDecision(
      devlogEntry,
      [
        "CONFIRMED CONCLUSION",
        `action: ${decision.action}`,
        `run_id: ${options.runId}`,
        `round: ${preparation.runState.round}`,
      ].join("\n")
    );
    return {
      ...applied,
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
