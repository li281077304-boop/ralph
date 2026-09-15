#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  createDevlogHandoff,
  recordUsageLedger,
  validateDevlogHandoff,
  writeDevlogResult,
} from "../packages/core/dist/index.js";

export async function runCodexTask(options) {
  const root = resolve(options.repoRoot);
  const agentTask = options.task ?? (await readFile(options.taskFile, "utf8"));
  const minimal = options.minimalContext === true || options.testMode === true;
  let context = options.context;
  if (options.contextFile)
    context = await readFile(options.contextFile, "utf8");
  if (!context && !minimal) throw new Error("DEVLOG_CONTEXT_REQUIRED");
  const devlogRoot = resolve(options.devlogRoot ?? root);
  const entry = await createDevlogHandoff({
    root: devlogRoot,
    slug: options.slug ?? "codex-task",
    runId: options.runId,
    round: options.round,
    taskId: options.taskId,
    date: options.date,
    context:
      context ??
      [
        "USER OBSERVATION",
        "Explicit test-mode handoff has no discussion context requirement.",
        "CONFIRMED FACT",
        `repo: ${root}`,
        "TECHNICAL ASSESSMENT",
        "This is an explicitly minimal mechanical smoke invocation.",
        "REJECTED ASSUMPTIONS",
        "Minimal mode is not a formal development context.",
        "DECISION",
        "Persist and validate the exact task before invoking Codex.",
        "UNKNOWN / OPEN RISKS",
        "No formal product decision is being made in this test.",
      ].join("\n"),
    mode: minimal ? "minimal" : "formal",
    agentTask,
  });
  await validateDevlogHandoff(entry);
  const binary = options.binary ?? process.env.RALPH_CODEX_BIN ?? "codex";
  const role = options.role ?? "worker";
  if (!["worker", "chief"].includes(role))
    throw new Error(`Unsupported Codex task role: ${role}`);
  const model =
    options.model ?? (role === "chief" ? "gpt-5.6-sol" : "gpt-5.6-luna");
  const reasoningEffort =
    options.reasoningEffort ?? (role === "chief" ? "high" : "medium");
  const policy = options.executionPolicy ?? {};
  const args = [];
  if (policy.approvalMode) args.push("--ask-for-approval", policy.approvalMode);
  if (policy.sandbox) args.push("--sandbox", policy.sandbox);
  if (policy.bypassApprovalsAndSandbox === true)
    args.push("--dangerously-bypass-approvals-and-sandbox");
  args.push("exec", "--json", "--ephemeral", "-C", root);
  if (model) args.push("--model", model);
  if (reasoningEffort)
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  args.push(agentTask);
  const spawnImpl = options.spawnImpl ?? spawn;
  const startedAt = Date.now();
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
  let usage;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch {
      // The task result is intentionally returned raw; malformed lines are
      // diagnosed by the existing Codex process result handling.
    }
  }
  const inputTokens =
    typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
  const cachedInputTokens =
    typeof usage?.cached_input_tokens === "number"
      ? usage.cached_input_tokens
      : null;
  const outputTokens =
    typeof usage?.output_tokens === "number" ? usage.output_tokens : null;
  const totalTokens =
    typeof usage?.total_tokens === "number"
      ? usage.total_tokens
      : inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null;
  await recordUsageLedger(root, {
    timestamp: new Date().toISOString(),
    role: "codex_task",
    provider: "codex",
    model,
    reasoning_effort: reasoningEffort,
    phase: "DIRECT_TASK",
    run_id: options.runId ?? null,
    round: options.round ?? null,
    duration: Date.now() - startedAt,
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    tokens_available: [
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
    ].some((value) => value !== null),
    fallback_from: null,
    failure_signature: exitCode.code !== 0 ? "CODEX_TASK_FAILED" : null,
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
        "--role",
        "--model",
        "--reasoning-effort",
        "--context-file",
        "--minimal-context",
      ].includes(arg)
    )
      throw new Error(`Unknown argument: ${arg}`);
    if (arg === "--minimal-context") {
      values.minimal_context = true;
      continue;
    }
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
    role: args.role,
    model: args.model,
    reasoningEffort: args.reasoning_effort,
    contextFile: args.context_file,
    minimalContext: args.minimal_context === true,
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
