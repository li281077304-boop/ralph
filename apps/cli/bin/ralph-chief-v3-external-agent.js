#!/usr/bin/env node
/**
 * External-Agent backend adapter for Ralph V3.
 *
 * Purpose: let a non-Codex agent (WorkBuddy / any external agent) serve as the
 * Chief and/or Worker backend for an *already existing* run, without creating a
 * new run and without replaying earlier Worker / Gate / checkpoint phases.
 *
 * Design constraints (deliberate):
 *  - It never writes Ralph durable state by itself. It only supplies the
 *    `transport` / `runAgent` seams that the official V3 phase runners already
 *    expose, so every state transition, schema check, hash binding, writer lock
 *    and devlog record is still produced by Ralph itself.
 *  - It never re-runs the Worker, the Machine Gate or the checkpoint. The
 *    review/select runners resume from the durable handoff already on disk.
 *  - The supplied reply is parsed exactly like a browser/GUI Chief reply, so a
 *    malformed or mis-bound verdict fails Ralph's own validation.
 *
 * Usage:
 *   ralph-chief-v3-external-agent.js --repo ROOT --run-id ID --config FILE
 *        --phase review|final_review|select  --reply-file FILE
 *        | --phase worker --agent-reply-file FILE
 *
 * --reply-file  : raw external-agent reply text. It must contain the standard
 *                 marked JSON block (<<<CHIEF_REVIEW_JSON>>> ... etc).
 * --verdict     : alternative to --reply-file; a bare JSON verdict object that
 *                 this adapter wraps in the phase's markers.
 */

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getChiefRunDir,
  loadChiefConfig,
  loadRunState,
  runIntegrationUatPhase,
  runV3WorkSlice,
} from "@daonhan/ralph-core";

import {
  runV3ReviewTransport,
  REVIEW_OPEN_MARKER,
  REVIEW_CLOSE_MARKER,
} from "./ralph-chief-v3-review.js";
import {
  runV3SelectTransport,
  SELECT_OPEN_MARKER,
  SELECT_CLOSE_MARKER,
} from "./ralph-chief-v3-select.js";
// Reuse the loop's own worker config projection so the injected agent backend
// sees exactly the same commands / gate paths / limits as the default runner.
import { workConfig } from "./ralph-chief-v3-loop.js";

const USAGE =
  "Usage: ralph-chief-v3-external-agent --repo ROOT --run-id ID --config FILE " +
  "--phase review|final_review|select|worker (--reply-file FILE | --verdict FILE)";

function parseArgs(argv) {
  const values = {};
  const allowed = [
    "--repo",
    "--run-id",
    "--config",
    "--phase",
    "--reply-file",
    "--verdict",
    "--agent-reply-file",
    "--apply-script",
    "--summary-file",
    "--devlog-root",
    "--dry-run",
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!allowed.includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    if (arg === "--dry-run") {
      values.dry_run = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`${arg} requires a value`);
    values[arg.slice(2).replaceAll("-", "_")] = value;
  }
  if (!values.repo || !values.run_id || !values.phase) throw new Error(USAGE);
  return values;
}

function markersFor(phase) {
  if (phase === "select") return [SELECT_OPEN_MARKER, SELECT_CLOSE_MARKER];
  return [REVIEW_OPEN_MARKER, REVIEW_CLOSE_MARKER];
}

/**
 * The phase transports prepare the handoff *after* this adapter is constructed,
 * so the binding values are only known once the request arrives. Ralph puts the
 * canonical binding block at the top of the prepared prompt; read it back from
 * there and merge it into the verdict instead of asking the external agent to
 * predict hashes. A verdict that already binds to a different handoff is
 * rejected rather than silently rewritten.
 */
function bindingsFromPrompt(message) {
  const found = {};
  for (const key of [
    "run_id",
    "round",
    "handoff_hash",
    "project_state_hash",
    "checkpoint_hash",
    "gate_artifact_hash",
  ]) {
    const match = new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "m").exec(message);
    if (match) found[key] = key === "round" ? Number(match[1]) : match[1];
  }
  return found;
}

async function buildVerdict(phase, options, request) {
  const [open, close] = markersFor(phase);
  if (options.replyFile) return readFile(resolve(options.replyFile), "utf8");
  const verdictPath = options.verdict;
  if (!verdictPath) throw new Error(USAGE);
  const verdict = JSON.parse(await readFile(resolve(verdictPath), "utf8"));
  const bindings = bindingsFromPrompt(request.message ?? "");
  for (const [key, value] of Object.entries(bindings)) {
    if (
      verdict[key] !== undefined &&
      verdict[key] !== null &&
      String(verdict[key]) !== String(value)
    )
      throw new Error(
        `verdict ${key}=${verdict[key]} does not match the prepared handoff (${value})`
      );
    verdict[key] = value;
  }
  const missing = [
    "run_id",
    "round",
    "handoff_hash",
    "project_state_hash",
    "checkpoint_hash",
    "gate_artifact_hash",
  ].filter((key) => verdict[key] === undefined);
  if (phase !== "select" && missing.length)
    throw new Error(`verdict is missing binding fields: ${missing.join(", ")}`);
  return [
    `External Agent Chief verdict applied through the standard V3 ${phase} transport.`,
    open,
    JSON.stringify(verdict, null, 2),
    close,
  ].join("\n");
}

/** Run the external agent's prepared patch script against the worker workspace. */
function runPatchScript(scriptPath, workspaceDir) {
  return new Promise((resolveResult) => {
    const child = spawn("bash", [scriptPath], {
      cwd: workspaceDir,
      env: { ...process.env, RALPH_WORKSPACE_DIR: workspaceDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", (error) =>
      resolveResult({ code: -1, stdout, stderr: String(error) })
    );
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

export async function runExternalAgentBackend(options) {
  const projectRoot = resolve(options.projectRoot);
  const runId = options.runId;
  const phase = options.phase;
  const config = loadChiefConfig(options.configPath);
  const devlogRoot = options.devlogRoot ?? projectRoot;
  const runState = await loadRunState(
    join(getChiefRunDir(projectRoot, runId), "RUN_STATE.json")
  );

  if (options.dryRun) {
    return { phase, runState, config, dryRun: true };
  }

  if (phase === "review" || phase === "final_review") {
    const reviewStage =
      phase === "final_review"
        ? "final"
        : runState.waiting_handoff?.review_stage === "final"
          ? "final"
          : "chief";
    const transport = async (request) => ({
      reply: await buildVerdict(phase, options, request),
      recoveryMode: "EXTERNAL_AGENT",
      backend: "external_agent",
    });
    return runV3ReviewTransport({
      projectRoot,
      runId,
      devlogRoot,
      guiConfig: config.gui_bridge ?? {},
      reviewStage,
      transport,
    });
  }

  if (phase === "select") {
    const transport = async (request) => ({
      reply: await buildVerdict("select", options, request),
      recoveryMode: "EXTERNAL_AGENT",
      backend: "external_agent",
    });
    return runV3SelectTransport({
      projectRoot,
      runId,
      devlogRoot,
      guiConfig: config.gui_bridge ?? {},
      transport,
    });
  }

  if (phase === "worker") {
    // WORKER requires a clean workspace when the phase starts, so the external
    // agent's edits must happen *inside* the injected runner, not before it.
    // The runner applies a prepared patch script and returns the agent summary.
    const summary = options.summaryFile
      ? await readFile(resolve(options.summaryFile), "utf8")
      : "External agent backend applied the accepted Chief patch.";
    const applyScript = options.applyScript
      ? resolve(options.applyScript)
      : undefined;
    let applyResult = null;
    const runAgent = async (_stage, _prompt, workspaceDir) => {
      if (applyScript) {
        applyResult = await runPatchScript(applyScript, workspaceDir);
        if (applyResult.code !== 0) {
          throw new Error(
            `external agent patch script exited ${applyResult.code}: ${applyResult.stderr || applyResult.stdout}`
          );
        }
      }
      return {
        text: summary,
        meta: {
          turns: 1,
          backend: "external_agent",
          patch_script: applyScript ?? null,
        },
      };
    };
    const sliced = await runV3WorkSlice({
      projectRoot,
      runId,
      devlogRoot,
      config: workConfig(config, runId),
      runAgent,
    });
    return { ...sliced, applyResult };
  }

  if (phase === "uat") {
    // Deterministic phase: no Chief, just the configured integration acceptance.
    return runIntegrationUatPhase({
      projectRoot,
      runId,
      config: {
        uat_commands: config.uat_commands,
        timeout_seconds: config.timeout_seconds,
        gate_allowed_paths: config.gate_allowed_paths,
      },
    });
  }

  throw new Error(`Unsupported phase: ${phase}`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outcome = await runExternalAgentBackend({
    projectRoot: args.repo,
    runId: args.run_id,
    configPath: args.config,
    phase: args.phase,
    replyFile: args.reply_file,
    verdict: args.verdict,
    agentReplyFile: args.agent_reply_file,
    applyScript: args.apply_script,
    summaryFile: args.summary_file,
    devlogRoot: args.devlog_root,
    dryRun: Boolean(args.dry_run),
  });
  if (outcome?.dryRun) {
    process.stdout.write(
      `EXTERNAL_AGENT_DRY_RUN phase=${outcome.runState.phase} ` +
        `round=${outcome.runState.round} kind=${outcome.runState.waiting_handoff?.kind ?? "none"}\n`
    );
    return outcome;
  }
  process.stdout.write(
    `EXTERNAL_AGENT_APPLIED phase=${outcome.runState.phase} ` +
      `status=${outcome.runState.status} round=${outcome.runState.round} ` +
      `recovered=${outcome.recovered ?? false}\n`
  );
  return outcome;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `EXTERNAL_AGENT_FAILED: ${error?.code ? error.code + ": " : ""}${error?.message ?? String(error)}\n`
    );
    process.exitCode = 1;
  });
}
