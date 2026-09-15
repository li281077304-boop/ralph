#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  createDevlogHandoff,
  validateDevlogHandoff,
  writeDevlogResult,
} from "../packages/core/dist/index.js";

export async function runCodexTask(options) {
  const root = resolve(options.repoRoot);
  const agentTask = options.task ?? (await readFile(options.taskFile, "utf8"));
  const devlogRoot = resolve(options.devlogRoot ?? root);
  const entry = await createDevlogHandoff({
    root: devlogRoot,
    slug: options.slug ?? "codex-task",
    runId: options.runId,
    round: options.round,
    taskId: options.taskId,
    date: options.date,
    context:
      options.context ??
      [
        "CONFIRMED FACT",
        `repo: ${root}`,
        "DECISION",
        "Persist this exact task before invoking Codex.",
      ].join("\n"),
    agentTask,
  });
  await validateDevlogHandoff(entry);
  const binary = options.binary ?? process.env.RALPH_CODEX_BIN ?? "codex";
  const policy = options.executionPolicy ?? {};
  const args = [];
  if (policy.approvalMode) args.push("--ask-for-approval", policy.approvalMode);
  if (policy.sandbox) args.push("--sandbox", policy.sandbox);
  if (policy.bypassApprovalsAndSandbox === true)
    args.push("--dangerously-bypass-approvals-and-sandbox");
  args.push("exec", "--json", "--ephemeral", "-C", root, agentTask);
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(binary, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  await writeDevlogResult(
    entry,
    [
      "TESTED",
      `exit: ${JSON.stringify(exitCode)}`,
      `stderr_tail: ${stderr || "none"}`,
      "REAL-UAT-VERIFIED: NOT-YET-VERIFIED",
    ].join("\n")
  );
  if (exitCode.code !== 0)
    throw new Error(`CODEX_TASK_FAILED: ${stderr || `exit ${exitCode.code}`}`);
  return { stdout, stderr, exitCode, entry };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      ![
        "--repo",
        "--task-file",
        "--slug",
        "--run-id",
        "--round",
        "--task-id",
        "--devlog-root",
      ].includes(arg)
    )
      throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${arg} requires a value`);
    values[arg.slice(2).replaceAll("-", "_")] = value;
  }
  if (!values.repo || !values.task_file)
    throw new Error(
      "Usage: codex-task --repo ROOT --task-file FILE [--slug SLUG]"
    );
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = await runCodexTask({
    repoRoot: args.repo,
    taskFile: args.task_file,
    slug: args.slug,
    runId: args.run_id,
    round: args.round ? Number(args.round) : undefined,
    taskId: args.task_id,
    devlogRoot: args.devlog_root,
  });
  process.stdout.write(result.stdout);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `CODEX_TASK_FAILED: ${error?.message ?? String(error)}\n`
    );
    process.exitCode = 1;
  });
}
