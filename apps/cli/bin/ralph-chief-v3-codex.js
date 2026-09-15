#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { getChiefRunDir, runStage, STAGES } from "@daonhan/ralph-core";

function roundDirectory(projectRoot, runId, round) {
  return join(
    getChiefRunDir(projectRoot, runId),
    "rounds",
    String(round).padStart(3, "0")
  );
}

/**
 * Execute one independent Codex Chief request. The protocol prompt and its
 * parsing remain in the V3 SELECT/REVIEW transports; this adapter only runs
 * the fresh, read-only Codex invocation and returns its final text.
 */
export async function runV3CodexChiefRoundtrip(options) {
  const projectRoot = options.projectRoot;
  const runId = options.runId ?? options.request?.runId;
  const request = options.request;
  const round = Number(options.round ?? request?.round);
  if (!projectRoot || !runId || !request || typeof request.message !== "string")
    throw new Error(
      "Codex Chief request requires projectRoot, runId, and message"
    );
  if (!Number.isInteger(round) || round < 1)
    throw new Error("Codex Chief request requires a positive round");

  const logName = options.logName ?? "codex-chief.ndjson";
  const roundDir = roundDirectory(projectRoot, runId, round);
  await mkdir(roundDir, { recursive: true });
  const logPath = join(roundDir, logName);
  const chief = options.chiefConfig ?? {};
  const stage = {
    ...STAGES.chief,
    agent: "codex",
    ...(chief.model ? { model: chief.model } : {}),
    ...(chief.reasoning_effort
      ? { reasoningEffort: chief.reasoning_effort }
      : {}),
  };
  const execute = options.runStage ?? runStage;
  const result = await execute(
    stage,
    request.message,
    projectRoot,
    round,
    undefined,
    logPath,
    {
      agent: "codex",
      model: chief.model,
      reasoningEffort: chief.reasoning_effort,
      codexUserConfig: false,
      readOnlyWorkspace: true,
      dockerSocket: "off",
    }
  );
  if (!result || typeof result.text !== "string")
    throw new Error("Chief transport returned no reply");
  return {
    reply: result.text,
    ...(result.meta ?? {}),
    chief_log_path: logPath,
  };
}

export function createV3CodexChiefTransport(options) {
  return (request) => runV3CodexChiefRoundtrip({ ...options, request });
}
