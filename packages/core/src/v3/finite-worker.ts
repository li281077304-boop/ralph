import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type FiniteWorkerOptions = {
  projectRoot: string;
  prompt: string;
  logPath: string;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  binary?: string;
  spawn?: typeof nodeSpawn;
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_TAIL_BYTES = 8 * 1024;

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > STDERR_TAIL_BYTES
    ? next.slice(-STDERR_TAIL_BYTES)
    : next;
}

function workerError(
  code: string,
  message: string,
  stderr = ""
): Error & { code: string } {
  const error = new Error(
    `${code}: ${message}${stderr ? `: ${stderr}` : ""}`
  ) as Error & { code: string };
  error.code = code;
  return error;
}

export function finiteWorkerArgs(
  options: Pick<
    FiniteWorkerOptions,
    "projectRoot" | "model" | "reasoningEffort" | "prompt"
  >
): string[] {
  const args = [
    "--ask-for-approval",
    "never",
    "--sandbox",
    "workspace-write",
    "exec",
    "--json",
    "--ephemeral",
    "-C",
    options.projectRoot,
  ];
  if (options.model) args.push("--model", options.model);
  if (options.reasoningEffort)
    args.push("-c", `model_reasoning_effort=\"${options.reasoningEffort}\"`);
  args.push(options.prompt);
  return args;
}

/** Run exactly one fresh host Codex turn. The child must terminate with a
 * completed agent message; no long-lived Goal or Docker container is used. */
export async function runFiniteCodexWorker(
  options: FiniteWorkerOptions
): Promise<{ text: string; meta: Record<string, unknown> }> {
  await mkdir(dirname(options.logPath), { recursive: true });
  const binary = options.binary ?? process.env.RALPH_CODEX_BIN ?? "codex";
  const spawnProcess = options.spawn ?? nodeSpawn;
  const child = spawnProcess(binary, finiteWorkerArgs(options), {
    cwd: options.projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const log = createWriteStream(options.logPath, { flags: "a" });
  let buffer = "";
  let stderrTail = "";
  let finalText: string | undefined;
  let turnCompleted = false;
  let failure: Error | undefined;
  let timedOut = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const parseLine = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      failure = workerError(
        "CODEX_WORKER_MALFORMED_JSONL",
        "invalid JSONL event"
      );
      return;
    }
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      finalText = event.item.text;
    } else if (event.type === "turn.completed") {
      turnCompleted = true;
    } else if (event.type === "turn.failed") {
      failure = workerError(
        "CODEX_WORKER_TURN_FAILED",
        typeof event.message === "string" ? event.message : "turn failed",
        stderrTail
      );
    } else if (event.type === "error") {
      failure = workerError(
        "CODEX_WORKER_ERROR",
        typeof event.message === "string" ? event.message : "codex error",
        stderrTail
      );
    }
  };

  const closeLog = () =>
    new Promise<void>((resolveClose) => log.end(() => resolveClose()));
  const finish = async (
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<{ text: string; meta: Record<string, unknown> }> => {
    if (settled)
      throw workerError(
        "CODEX_WORKER_RUNTIME_ERROR",
        "worker result settled twice"
      );
    settled = true;
    if (timer) clearTimeout(timer);
    if (buffer) parseLine(buffer);
    await closeLog();
    if (failure) throw failure;
    if (timedOut)
      throw workerError(
        "CODEX_WORKER_TIMEOUT",
        `timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
        stderrTail
      );
    if (code !== 0)
      throw workerError(
        "CODEX_WORKER_PROCESS_FAILED",
        `codex exited with code ${String(code)} signal=${String(signal)}`,
        stderrTail
      );
    if (!turnCompleted)
      throw workerError(
        "CODEX_WORKER_NO_TURN_COMPLETED",
        "codex exited without turn.completed",
        stderrTail
      );
    if (typeof finalText !== "string")
      throw workerError(
        "CODEX_WORKER_NO_FINAL_AGENT_MESSAGE",
        "turn.completed had no final agent message",
        stderrTail
      );
    return { text: finalText, meta: { turns: 1 } };
  };

  return new Promise((resolve, reject) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* process may already be gone */
        }
      },
      Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    );
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      log.write(text);
      buffer += text;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        parseLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = appendTail(stderrTail, chunk.toString());
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      failure =
        error.code === "ENOENT"
          ? workerError("HOST_CODEX_NOT_FOUND", `${binary} was not found`)
          : workerError(
              "CODEX_WORKER_RUNTIME_ERROR",
              error.message,
              stderrTail
            );
    });
    child.once(
      "close",
      (code: number | null, signal: NodeJS.Signals | null) => {
        void finish(code, signal).then((result) => resolve(result), reject);
      }
    );
  });
}
