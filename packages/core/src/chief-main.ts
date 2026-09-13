import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadChiefConfig,
  type ChiefConfig,
  type ChiefMode,
} from "./chief-config.js";
import {
  runChiefLoop,
  type ChiefLoopConfig,
  type ExternalChiefBridge,
} from "./chief-loop.js";

export type RunChiefOptions = {
  cliVersion?: string;
  externalChiefBridge?: ExternalChiefBridge;
};

/** CLI entry used by apps/cli/bin/ralph-chief.js. */
export async function runChief(
  argv: string[],
  _options: RunChiefOptions = {}
): Promise<void> {
  const flags = parseChiefFlags(argv);
  if (flags.help) {
    process.stdout.write(
      "ralph-chief — GPT Chief / Worker local orchestration loop\n\n" +
        "Usage:\n" +
        "  ralph-chief run --task TASK.md [--repo PATH] [--config ACCEPTANCE.yaml]\n" +
        "  ralph-chief resume RUN_ID [--repo PATH] [--verdict PATH]\n\n" +
        "The Worker edits the repo, machine gates run independently, and the Chief\n" +
        "returns PASS, PATCH, RETURN, or HUMAN_REQUIRED as strict JSON.\n" +
        "Use --chief-mode external to pause at WAITING_FOR_CHIEF without calling a local Chief model.\n"
    );
    return;
  }
  const workspaceDir = resolve(flags.repo ?? process.cwd());
  const here = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(here, "..");
  const result =
    flags.command === "resume"
      ? await resumeChief(workspaceDir, packageDir, flags, _options)
      : await startChief(workspaceDir, packageDir, flags, _options);
  setExitCode(result.state.status);
}

type ChiefFlags = {
  help: boolean;
  command: "run" | "resume";
  task?: string;
  runId?: string;
  repo?: string;
  config?: string;
  verdictPath?: string;
  chiefMode?: ChiefMode;
  maxIterations?: number;
  maxTotalTokens?: number;
};

function parseChiefFlags(argv: string[]): ChiefFlags {
  const command = argv[0] === "resume" ? "resume" : "run";
  const flags: ChiefFlags = { help: false, command };
  let start = command === "resume" || argv[0] === "run" ? 1 : 0;
  if (command === "resume" && argv[1] && !argv[1].startsWith("-")) {
    flags.runId = argv[1];
    start = 2;
  }
  for (let index = start; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "--task") flags.task = requiredValue(argv, ++index, arg);
    else if (arg === "--run-id")
      flags.runId = requiredValue(argv, ++index, arg);
    else if (arg === "--repo") flags.repo = requiredValue(argv, ++index, arg);
    else if (arg === "--config")
      flags.config = requiredValue(argv, ++index, arg);
    else if (arg === "--verdict")
      flags.verdictPath = requiredValue(argv, ++index, arg);
    else if (arg === "--chief-mode") {
      const mode = requiredValue(argv, ++index, arg);
      if (mode !== "codex" && mode !== "external")
        throw new Error("--chief-mode must be codex or external");
      flags.chiefMode = mode;
    } else if (arg === "--max-iterations")
      flags.maxIterations = positiveNumber(
        requiredValue(argv, ++index, arg),
        arg
      );
    else if (arg === "--max-total-tokens")
      flags.maxTotalTokens = positiveNumber(
        requiredValue(argv, ++index, arg),
        arg
      );
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (command === "resume" && !flags.runId && !flags.help)
    throw new Error("ralph-chief resume requires RUN_ID");
  return flags;
}

async function startChief(
  workspaceDir: string,
  packageDir: string,
  flags: ChiefFlags,
  options: RunChiefOptions
) {
  if (!flags.task) throw new Error("ralph-chief requires --task TASK.md");
  const taskPath = resolve(flags.task);
  const configPath = flags.config
    ? resolve(flags.config)
    : defaultAcceptancePath(workspaceDir);
  const loaded = configPath ? loadChiefConfig(configPath) : undefined;
  const task = readFileSync(taskPath, "utf8");
  const config = toLoopConfig(task, loaded, flags);
  return runChiefLoop({
    workspaceDir,
    packageDir,
    ralphDir: resolve(process.env.RALPH_DOCKER_CONTEXT ?? packageDir),
    config,
    runId: flags.runId,
    taskPath,
    acceptancePath: configPath,
    externalChiefBridge: options.externalChiefBridge,
  });
}

async function resumeChief(
  workspaceDir: string,
  packageDir: string,
  flags: ChiefFlags,
  options: RunChiefOptions
) {
  const runId = flags.runId!;
  const runDir = join(workspaceDir, ".ralph", "chief-runs", runId);
  const taskSnapshot = join(runDir, "task_snapshot.md");
  const configSnapshot = join(runDir, "config_snapshot.json");
  if (!existsSync(taskSnapshot) || !existsSync(configSnapshot))
    throw new Error(`Chief run snapshot not found: ${runDir}`);
  const task = readFileSync(taskSnapshot, "utf8");
  const snapshot = JSON.parse(
    readFileSync(configSnapshot, "utf8")
  ) as ChiefLoopConfig;
  const configPath = flags.config ? resolve(flags.config) : undefined;
  const loaded = configPath ? loadChiefConfig(configPath) : undefined;
  const config = loaded
    ? toLoopConfig(task, loaded, flags)
    : {
        ...snapshot,
        task,
        chiefMode: flags.chiefMode ?? snapshot.chiefMode ?? "external",
      };
  if (config.chiefMode !== "external")
    throw new Error("Only external Chief runs can be resumed with a verdict");
  const acceptancePath = configPath ?? defaultAcceptancePath(workspaceDir);
  return runChiefLoop({
    workspaceDir,
    packageDir,
    ralphDir: resolve(process.env.RALPH_DOCKER_CONTEXT ?? packageDir),
    config,
    taskPath: existsSync(join(workspaceDir, "TASK.md"))
      ? join(workspaceDir, "TASK.md")
      : undefined,
    acceptancePath,
    resumeRunId: runId,
    verdictPath: flags.verdictPath,
    externalChiefBridge: options.externalChiefBridge,
  });
}

function setExitCode(status: string): void {
  if (status === "PASS") return;
  if (status === "HUMAN_REQUIRED") process.exitCode = 2;
  else if (status === "WAITING_FOR_CHIEF") process.exitCode = 3;
  else process.exitCode = 1;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}
function positiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${flag} must be a positive integer`);
  return value;
}
function defaultAcceptancePath(repo: string): string | undefined {
  for (const name of ["ACCEPTANCE.yaml", "ACCEPTANCE.yml", "ACCEPTANCE.json"]) {
    const path = join(repo, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}
function toLoopConfig(
  task: string,
  loaded: ChiefConfig | undefined,
  flags: ChiefFlags
): ChiefLoopConfig {
  return {
    task,
    chiefMode: flags.chiefMode ?? loaded?.chief_mode,
    maxIterations: flags.maxIterations ?? loaded?.max_iterations,
    maxTotalTokens: flags.maxTotalTokens ?? loaded?.max_total_tokens,
    timeoutSeconds: loaded?.timeout_seconds,
    commands: loaded?.commands,
    uatCommands: loaded?.uat_commands,
    forbiddenPaths: loaded?.forbidden_paths,
    requiredCleanPatterns: loaded?.required_clean_patterns,
    protectedPaths: loaded?.protected_paths,
    maxDiffBytes: loaded?.max_diff_bytes,
    maxChangedPaths: loaded?.max_changed_paths,
    chief: loaded?.chief,
    worker: loaded?.worker,
    guiBridge: loaded?.gui_bridge,
  };
}
