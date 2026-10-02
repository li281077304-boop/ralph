import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFlags,
  printConfig,
  printHelp,
  printVersion,
} from "./cli-help.js";
import {
  CODEX_USER_CONFIG_REQUIRES_CODEX,
  resolveAgentSelection,
} from "./agents/index.js";
import { detachAndExit } from "./detach.js";
import { runLoop } from "./loop.js";
import type { Stage } from "./stages.js";
import { evaluateV4Preflight, v4PreflightError } from "./v4/preflight.js";
import {
  RUN_MODE_ENV_VAR,
  resolveRunMode,
  resolveV4Capabilities,
} from "./v4/run-mode.js";

/**
 * Only tokens that actually look like a plan/PRD path are read — a bare word
 * that happens to match a file in the working directory must not be ingested.
 */
const PLAN_PATH_HINT = /[\\/]|\.(md|markdown|txt)$/i;

/**
 * The task text a run may carry its `RUN_MODE` declaration in: the inputs
 * string itself (a task can be handed inline) plus the contents of any
 * plan/PRD file it names.
 */
function collectRunModeInputs(inputs: string): string {
  const parts = [inputs];
  for (const candidate of inputs.split(/\s+/)) {
    if (!candidate || !PLAN_PATH_HINT.test(candidate)) continue;
    try {
      if (existsSync(candidate)) parts.push(readFileSync(candidate, "utf8"));
    } catch {
      // Unreadable path: the mode simply stays undeclared. V4 is opt-in, so a
      // failure to find the declaration must fall back to V3, never guess.
    }
  }
  return parts.join("\n");
}

export type RunBinConfig = {
  /** Bin name for usage/version/config output (e.g. "ralph-afk"). */
  bin: string;
  /** Positional-arg usage string (e.g. "<plan-and-prd> <iterations>"). */
  usage: string;
  /** One-line description for --help. */
  desc: string;
  /** Stage chain; first stage is the gate. */
  stages: [Stage, ...Stage[]];
  /**
   * Whether the bin takes a leading input positional before <iterations>.
   * `true`  → argv is `<inputs> <iterations>` (ralph-afk; inputs = rest[0]).
   * `false` → argv is `<iterations>`          (ralph-ghafk; inputs = "").
   */
  takesInputArg: boolean;
  cliVersion?: string;
};

/**
 * Shared entry for the AFK bins: parse flags, handle --version/--help/--print-config,
 * resolve the workspace / docker-context / package dirs, validate the positional args,
 * optionally fork into the background (--detach), then drive runLoop.
 */
export async function runBin(argv: string[], cfg: RunBinConfig): Promise<void> {
  const flags = parseFlags(argv);

  if (flags.version) {
    printVersion(cfg.bin, cfg.cliVersion);
    return;
  }
  if (flags.help) {
    printHelp(cfg.bin, cfg.usage, cfg.desc);
    return;
  }

  const selection = resolveAgentSelection(flags.agent, process.env.RALPH_AGENT);
  if (flags.codexUserConfig && selection.agent !== "codex") {
    throw new Error(CODEX_USER_CONFIG_REQUIRES_CODEX);
  }

  // run-bin.js ships in the same dist/ dir as the bin entrypoints, so ".." is
  // the installed @daonhan/ralph-core package dir (which holds templates/).
  const here = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(here, "..");
  const workspaceDir = resolve(process.env.RALPH_WORKSPACE ?? process.cwd());
  const ralphDir = resolve(process.env.RALPH_DOCKER_CONTEXT ?? packageDir);

  const detachLogPath = flags.detach
    ? (flags.log ??
      join(workspaceDir, ".ralph-tmp", "logs", `detached-${process.pid}.log`))
    : undefined;

  if (flags.printConfig) {
    printConfig(cfg.bin, workspaceDir, ralphDir, packageDir, {
      cliVersion: cfg.cliVersion,
      noKeepAlive: flags.noKeepAlive,
      maxRetries: flags.maxRetries,
      detach: flags.detach,
      detachLogPath,
      notify: flags.notify,
      agent: selection.agent,
      agentSource: selection.source,
      codexUserConfig: flags.codexUserConfig,
    });
    return;
  }

  const inputs = cfg.takesInputArg ? flags.rest[0] : "";
  const iterationsArg = cfg.takesInputArg ? flags.rest[1] : flags.rest[0];
  if ((cfg.takesInputArg && !inputs) || !iterationsArg) {
    console.error(`Usage: ${cfg.bin} ${cfg.usage}`);
    console.error(`       ${cfg.bin} --help`);
    process.exit(1);
  }
  const iterations = Number.parseInt(iterationsArg, 10);
  if (!Number.isFinite(iterations) || iterations < 1) {
    console.error(`Invalid iterations: ${iterationsArg}`);
    process.exit(1);
  }

  if (flags.detach && detachLogPath) {
    detachAndExit({
      logPath: detachLogPath,
      argv,
      binEntry: process.argv[1],
    });
  }

  const runMode = resolveRunMode({
    env: process.env[RUN_MODE_ENV_VAR],
    inputs: collectRunModeInputs(inputs ?? ""),
  });

  // V4 gate: refuse to start another round of development while the product
  // anchor is overdue. This is the seam where the V4 decision layer actually
  // affects a run — without it the rule set would be advisory only.
  const capabilities = resolveV4Capabilities(runMode);
  if (capabilities.productAnchor) {
    const preflight = await evaluateV4Preflight({
      workspaceDir,
      runId: process.env.RALPH_RUN_ID ?? "default",
    });
    if (preflight.blocked) throw new Error(v4PreflightError(preflight));
  }

  await runLoop({
    stages: cfg.stages,
    runMode,
    inputs: inputs ?? "",
    iterations,
    ralphDir,
    workspaceDir,
    packageDir,
    noKeepAlive: flags.noKeepAlive,
    maxRetries: flags.maxRetries,
    notify: flags.notify,
    bin: cfg.bin,
    cliVersion: cfg.cliVersion,
    agent: selection.agent,
    codexUserConfig: flags.codexUserConfig,
  });
}
