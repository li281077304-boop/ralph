#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { loadChiefConfig, runV3UnattendedTask } from "@daonhan/ralph-core";
import { runV3ReviewTransport } from "./ralph-chief-v3-review.js";

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
      "Usage: ralph-chief-v3-auto --repo ROOT --run-id ID --config FILE"
    );
  return values;
}

export async function runAutoFromConfig(args) {
  const config = loadChiefConfig(args.config);
  if (config.chief_mode !== "external")
    throw new Error("Unattended V3 mode requires chief_mode: external");
  if (config.worker.agent !== "codex" || config.worker.mode !== "native_goal")
    throw new Error(
      "Unattended V3 mode requires worker.agent: codex and worker.mode: native_goal"
    );
  if (config.worker.model !== "gpt-5.6-luna")
    throw new Error("Unattended V3 mode requires worker.model: gpt-5.6-luna");
  if (config.max_total_tokens !== undefined)
    throw new Error(
      "Unattended V3 mode does not accept max_total_tokens; omit it for an uncapped Goal Worker"
    );
  if (!config.gui_bridge?.enabled)
    throw new Error("gui_bridge.enabled must be true for unattended V3 mode");
  return runV3UnattendedTask({
    projectRoot: args.repo,
    runId: args.run_id,
    config,
    reviewRunner: ({ projectRoot, runId }) =>
      runV3ReviewTransport({
        projectRoot,
        runId,
        guiConfig: config.gui_bridge,
      }),
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await runAutoFromConfig(args);
  process.stdout.write(
    `${result.status} phase=${result.runState.phase} task=${result.runState.current_task_id ?? "none"} patches=${result.patchRounds}${result.reason ? ` reason=${result.reason}` : ""}\n`
  );
  return result.status === "TASK_PASS" ? 0 : 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `V3_AUTO_FAILED: ${error?.message ?? String(error)}\n`
    );
    process.exitCode = 1;
  });
}
