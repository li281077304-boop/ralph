#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { inspectV3Status } from "@daonhan/ralph-core";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!["--repo", "--run-id"].includes(arg))
      throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${arg} requires a value`);
    values[arg.slice(2).replaceAll("-", "_")] = value;
  }
  if (!values.repo || !values.run_id)
    throw new Error("Usage: ralph-chief-v3-status --repo ROOT --run-id ID");
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const status = await inspectV3Status(args.repo, args.run_id);
  process.stdout.write(`${JSON.stringify(status)}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `V3_STATUS_FAILED: ${error?.message ?? String(error)}\n`
    );
    process.exitCode = 1;
  });
}
