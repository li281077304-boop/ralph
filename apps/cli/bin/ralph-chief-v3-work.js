#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { loadChiefConfig, runV3WorkSlice } from "@daonhan/ralph-core";

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
      "Usage: ralph-chief-v3-work --repo ROOT --run-id ID --config FILE"
    );
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = loadChiefConfig(args.config);
  const result = await runV3WorkSlice({
    projectRoot: args.repo,
    runId: args.run_id,
    config: {
      worker: config.worker,
      commands: config.commands,
      timeout_seconds: config.timeout_seconds,
      gate_allowed_paths: config.gate_allowed_paths,
      forbidden_paths: config.forbidden_paths,
      protected_paths: config.protected_paths,
      max_diff_bytes: config.max_diff_bytes,
      max_changed_paths: config.max_changed_paths,
    },
  });
  process.stdout.write(
    `V3_WORK_${result.runState.phase} task=${result.runState.current_task_id ?? "none"}\n`
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `V3_WORK_FAILED: ${error?.message ?? String(error)}\n`
    );
    process.exitCode = 1;
  });
}
