#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { getChiefRunDir, GitGuard, writeJsonAtomic } from "@daonhan/ralph-core";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_TAIL_BYTES = 8 * 1024;

function roundDirectory(projectRoot, runId, round) {
  return join(
    getChiefRunDir(projectRoot, runId),
    "rounds",
    String(round).padStart(3, "0")
  );
}

function chiefError(code, message, stderrTail = "") {
  const suffix = stderrTail ? `: ${stderrTail}` : "";
  const error = new Error(`${code}: ${message}${suffix}`);
  error.code = code;
  return error;
}

function gitOutput(projectRoot, args) {
  try {
    return String(
      execFileSync("git", args, {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    ).trim();
  } catch {
    return "";
  }
}

async function directoryEvidence(root, ignoredPaths = new Set()) {
  const result = {};
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const relativePath = relative(root, path).replaceAll("\\", "/");
      if (ignoredPaths.has(relativePath)) continue;
      try {
        const contents = await readFile(path);
        result[relativePath] = createHash("sha256")
          .update(contents)
          .digest("hex");
      } catch {
        result[relativePath] = "<unreadable>";
      }
    }
  }
  await visit(root);
  return result;
}

async function workspaceEvidence(projectRoot, ignoredPaths = []) {
  const guard = new GitGuard(projectRoot);
  const snapshot = guard.snapshot();
  const ignoredWorkspacePaths = new Set(
    ignoredPaths.map((path) =>
      relative(projectRoot, path).replaceAll("\\", "/")
    )
  );
  const ralphRoot = join(projectRoot, ".ralph");
  const ignored = new Set(
    ignoredPaths.map((path) => relative(ralphRoot, path))
  );
  return {
    branch: snapshot.branch,
    head: snapshot.head,
    status: snapshot.status,
    tracked_diff: snapshot.diff,
    staged_diff: gitOutput(projectRoot, ["diff", "--cached", "--binary"]),
    untracked_paths: [...snapshot.untrackedFiles.keys()]
      .filter((path) => !ignoredWorkspacePaths.has(path))
      .sort(),
    ralph_files: await directoryEvidence(ralphRoot, ignored),
  };
}

function appendStderrTail(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length > STDERR_TAIL_BYTES
    ? next.slice(-STDERR_TAIL_BYTES)
    : next;
}

function codexArgs(projectRoot, chief, message) {
  const args = [
    "--ask-for-approval",
    "never",
    "--sandbox",
    "read-only",
    "exec",
    "--json",
    "--ephemeral",
    "-C",
    projectRoot,
  ];
  if (chief.model) args.push("--model", chief.model);
  if (chief.reasoning_effort)
    args.push("-c", `model_reasoning_effort=\"${chief.reasoning_effort}\"`);
  args.push(message);
  return args;
}

/** Execute one fresh, host Codex Chief request and return its final text. */
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
  const workspacePath = logPath.replace(/\.ndjson$/i, ".workspace.json");
  const ignoredEvidencePaths = [logPath, workspacePath];
  const before = await workspaceEvidence(projectRoot, ignoredEvidencePaths);
  const chief = options.chiefConfig ?? {};
  const binary = options.binary ?? process.env.RALPH_CODEX_BIN ?? "codex";
  const spawnProcess = options.spawn ?? nodeSpawn;
  const timeoutMs = Math.max(
    1,
    options.timeoutMs ??
      (options.timeout_seconds ? options.timeout_seconds * 1000 : undefined) ??
      DEFAULT_TIMEOUT_MS
  );
  const args = codexArgs(projectRoot, chief, request.message);
  const child = spawnProcess(binary, args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
  });
  const log = createWriteStream(logPath, { flags: "a" });
  let stdoutBuffer = "";
  let stderrTail = "";
  let lastAgentMessage;
  let turnCompleted = false;
  let fatal;
  let timedOut = false;
  let settled = false;
  let timer;

  const parseLine = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fatal = chiefError("CODEX_CHIEF_MALFORMED_JSONL", "invalid JSONL event");
      return;
    }
    if (event.type === "item.completed") {
      const item = event.item;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        lastAgentMessage = item.text;
      }
      return;
    }
    if (event.type === "turn.completed") {
      turnCompleted = true;
      return;
    }
    if (event.type === "turn.failed") {
      fatal = chiefError(
        "CODEX_CHIEF_TURN_FAILED",
        typeof event.message === "string" ? event.message : "turn failed",
        stderrTail
      );
      return;
    }
    if (event.type === "error") {
      fatal = chiefError(
        "CODEX_CHIEF_ERROR",
        typeof event.message === "string" ? event.message : "codex error",
        stderrTail
      );
    }
  };

  const closeLog = () =>
    new Promise((resolveClose) => {
      log.end(resolveClose);
    });

  const finish = async (error, code, signal) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    const after = await workspaceEvidence(projectRoot, ignoredEvidencePaths);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    await writeJsonAtomic(workspacePath, {
      version: 1,
      run_id: runId,
      round,
      before,
      after,
      changed,
    });
    await closeLog();
    if (changed)
      throw chiefError(
        "CODEX_CHIEF_MODIFIED_WORKSPACE",
        "host Codex changed the project workspace"
      );
    if (error) throw error;
    if (timedOut)
      throw chiefError(
        "CODEX_CHIEF_TIMEOUT",
        `timed out after ${timeoutMs}ms`,
        stderrTail
      );
    if (code !== 0)
      throw chiefError(
        "CODEX_CHIEF_PROCESS_FAILED",
        `codex exited with code ${String(code)} signal=${String(signal)}`,
        stderrTail
      );
    if (!turnCompleted)
      throw chiefError(
        "CODEX_CHIEF_NO_TURN_COMPLETED",
        "codex exited without turn.completed",
        stderrTail
      );
    if (typeof lastAgentMessage !== "string")
      throw chiefError(
        "CODEX_CHIEF_NO_FINAL_AGENT_MESSAGE",
        "turn.completed had no final agent message",
        stderrTail
      );
    return { reply: lastAgentMessage, stderr_tail: stderrTail };
  };

  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already have exited; close will settle below.
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      stdoutBuffer += chunk.toString();
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        parseLine(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = appendStderrTail(stderrTail, chunk.toString());
    });
    child.once("error", (error) => {
      if (error?.code === "ENOENT")
        fatal = chiefError("HOST_CODEX_NOT_FOUND", `${binary} was not found`);
      else
        fatal = chiefError(
          "CODEX_CHIEF_RUNTIME_ERROR",
          error?.message ?? String(error),
          stderrTail
        );
    });
    child.once("close", async (code, signal) => {
      if (stdoutBuffer) parseLine(stdoutBuffer);
      try {
        const result = await finish(fatal, code, signal);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function createV3CodexChiefTransport(options) {
  return (request) => runV3CodexChiefRoundtrip({ ...options, request });
}
