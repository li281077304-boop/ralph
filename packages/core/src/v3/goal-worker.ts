import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonAtomic } from "./atomic-json.js";
import { getChiefRunDir, getRoundDir } from "./rounds.js";

export const GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type GoalRecord = {
  threadId: string;
  objective: string;
  status: GoalStatus;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  [key: string]: unknown;
};

export type GoalWaitResult = {
  goal: GoalRecord;
  activationSeen: boolean;
  text: string;
};

export interface GoalTransport {
  initialize(): Promise<void>;
  startThread(params: Record<string, unknown>): Promise<{ threadId: string }>;
  resumeThread(threadId: string): Promise<void>;
  setGoal(threadId: string, objective: string): Promise<GoalRecord>;
  getGoal(threadId: string): Promise<GoalRecord | null>;
  waitForGoal(threadId: string, timeoutMs: number): Promise<GoalWaitResult>;
  close(): Promise<void>;
}

export type GoalWorkerArtifact = {
  version: 1;
  run_id: string;
  round: number;
  task_id: string;
  thread_id: string;
  objective_hash: string;
  started_at: string;
  updated_at: string;
  latest_goal_status: GoalStatus;
  activation_evidence: {
    method: "thread/goal/updated";
    status: "active";
    observed_at: string;
  };
  goal?: GoalRecord;
};

type JsonRpcMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  method?: string;
  params?: Record<string, unknown>;
};

function isGoalStatus(value: unknown): value is GoalStatus {
  return (
    typeof value === "string" && GOAL_STATUSES.includes(value as GoalStatus)
  );
}

function requireGoal(value: unknown, label: string): GoalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is malformed`);
  const record = value as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.objective !== "string"
  )
    throw new Error(`${label} identity is malformed`);
  if (!isGoalStatus(record.status))
    throw new Error(`${label} status is unknown`);
  return record as GoalRecord;
}

function statusFromGoal(value: Record<string, unknown>): GoalRecord {
  const raw = value.goal ?? value;
  return requireGoal(raw, "Goal response");
}

function objectiveHash(objective: string): string {
  return createHash("sha256").update(objective, "utf8").digest("hex");
}

function artifactPath(
  projectRoot: string,
  runId: string,
  round: number
): string {
  return join(
    getRoundDir(getChiefRunDir(projectRoot, runId), round),
    "goal_worker.json"
  );
}

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Minimal JSONL app-server client. It deliberately exposes only the native
 * thread/goal operations needed by the V3 Worker; no ordinary codex exec
 * fallback is present.
 */
export class NativeCodexGoalTransport implements GoalTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly notifications = new Set<(message: JsonRpcMessage) => void>();
  private nextId = 1;
  private closed = false;
  private stderr = "";

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      if (typeof message.id === "number") {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) {
          waiter.reject(
            new Error(
              message.error.message ?? "Codex app-server request failed"
            )
          );
        } else {
          waiter.resolve(message.result ?? {});
        }
      } else if (message.method) {
        for (const listener of this.notifications) listener(message);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
      if (this.stderr.length > 8_000) this.stderr = this.stderr.slice(-8_000);
    });
    const fail = (): void => {
      if (this.closed) return;
      const suffix = this.stderr ? `: ${this.stderr.trim()}` : "";
      for (const waiter of this.pending.values())
        waiter.reject(new Error(`Codex app-server exited${suffix}`));
      this.pending.clear();
    };
    child.once("error", fail);
    child.once("exit", fail);
  }

  static async create(
    binary = process.env.RALPH_CODEX_BIN ?? "codex"
  ): Promise<NativeCodexGoalTransport> {
    const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new NativeCodexGoalTransport(child);
  }

  private request(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (this.closed)
      return Promise.reject(new Error("Codex app-server transport is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "ralph_v3_goal_worker",
        title: "Ralph V3 Native Goal Worker",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`
    );
  }

  async startThread(
    params: Record<string, unknown>
  ): Promise<{ threadId: string }> {
    const result = await this.request("thread/start", params);
    const thread = result.thread;
    if (
      !thread ||
      typeof thread !== "object" ||
      typeof (thread as Record<string, unknown>).id !== "string"
    )
      throw new Error(
        "Codex app-server thread/start returned no persisted thread id"
      );
    return { threadId: (thread as Record<string, unknown>).id as string };
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId });
  }

  async setGoal(threadId: string, objective: string): Promise<GoalRecord> {
    const result = await this.request("thread/goal/set", {
      threadId,
      objective,
      status: "active",
    });
    return statusFromGoal(result);
  }

  async getGoal(threadId: string): Promise<GoalRecord | null> {
    const result = await this.request("thread/goal/get", { threadId });
    if (result.goal === null || result.goal === undefined) return null;
    return statusFromGoal(result);
  }

  async waitForGoal(
    threadId: string,
    timeoutMs: number
  ): Promise<GoalWaitResult> {
    return new Promise((resolve, reject) => {
      let activationSeen = false;
      let text = "";
      let timer: NodeJS.Timeout | undefined;
      const finish = (result?: GoalWaitResult, error?: Error): void => {
        if (timer) clearTimeout(timer);
        this.notifications.delete(listener);
        if (error) reject(error);
        else resolve(result as GoalWaitResult);
      };
      const listener = (message: JsonRpcMessage): void => {
        if (message.method === "item/agentMessage/delta") {
          const params = message.params ?? {};
          if (
            typeof params.threadId === "string" &&
            params.threadId !== threadId
          )
            return;
          const delta = params.delta;
          if (typeof delta === "string") text += delta;
        }
        if (message.method !== "thread/goal/updated") return;
        const params = message.params ?? {};
        if (params.threadId !== threadId) return;
        const goal = params.goal;
        if (!goal || typeof goal !== "object") return;
        const record = requireGoal(goal, "thread/goal/updated");
        if (record.status === "active") activationSeen = true;
        if (record.status !== "active")
          finish({ goal: record, activationSeen, text });
      };
      this.notifications.add(listener);
      timer = setTimeout(
        () =>
          finish(
            undefined,
            new Error(
              "Native Goal Worker timed out waiting for terminal status"
            )
          ),
        timeoutMs
      );
      timer.unref?.();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.kill();
  }
}

export type GoalWorkerResult = {
  text: string;
  meta: Record<string, unknown>;
  error?: string;
  goalStatus?: GoalStatus;
};

export async function runNativeGoalWorker(options: {
  projectRoot: string;
  runId: string;
  round: number;
  taskId: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  packageDir?: string;
  goalTimeoutMs?: number;
  transport?: GoalTransport;
}): Promise<GoalWorkerResult> {
  const path = artifactPath(options.projectRoot, options.runId, options.round);
  const hash = objectiveHash(options.prompt);
  let existing: GoalWorkerArtifact | undefined;
  try {
    existing = JSON.parse(await readFile(path, "utf8")) as GoalWorkerArtifact;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return {
        text: "",
        meta: {},
        error: `goal_worker.json is malformed: ${errorMessage(error)}`,
      };
  }
  if (existing) {
    if (
      existing.version !== 1 ||
      existing.run_id !== options.runId ||
      existing.round !== options.round ||
      existing.task_id !== options.taskId ||
      existing.objective_hash !== hash ||
      typeof existing.thread_id !== "string"
    ) {
      return {
        text: "",
        meta: {},
        error: "Native Goal recovery identity mismatch",
      };
    }
  }

  const transport =
    options.transport ?? (await NativeCodexGoalTransport.create());
  const started = existing?.started_at ?? now();
  try {
    await transport.initialize();
    let threadId = existing?.thread_id;
    let goal: GoalRecord | null = null;
    let activationSeen = Boolean(existing?.activation_evidence);
    let text = "";
    if (threadId) {
      await transport.resumeThread(threadId);
      goal = await transport.getGoal(threadId);
      if (!goal)
        return {
          text: "",
          meta: {},
          error: "Native Goal recovery found no persisted goal",
        };
      if (goal.status === "active") {
        const waited = await transport.waitForGoal(
          threadId,
          options.goalTimeoutMs ?? 86_400_000
        );
        goal = waited.goal;
        activationSeen ||= waited.activationSeen;
        text = waited.text;
      }
    } else {
      const startedThread = await transport.startThread({
        model: options.model ?? "gpt-5.6-luna",
        cwd: options.projectRoot,
        sandbox: "workspace-write",
        approvalPolicy: "never",
        ephemeral: false,
        threadSource: "ralph_v3_goal_worker",
      });
      threadId = startedThread.threadId;
      await writeJsonAtomic(path, {
        version: 1,
        run_id: options.runId,
        round: options.round,
        task_id: options.taskId,
        thread_id: threadId,
        objective_hash: hash,
        started_at: started,
        updated_at: now(),
        latest_goal_status: "active",
      });
      const wait = transport.waitForGoal(
        threadId,
        options.goalTimeoutMs ?? 86_400_000
      );
      await transport.setGoal(threadId, options.prompt);
      const waited = await wait;
      goal = waited.goal;
      activationSeen = waited.activationSeen;
      text = waited.text;
    }
    if (!goal || !isGoalStatus(goal.status))
      return {
        text: "",
        meta: {},
        error: "Native Goal returned no terminal status",
      };
    if (!activationSeen)
      return {
        text: "",
        meta: {},
        error: "Native Goal activation evidence missing",
      };
    const evidence = {
      version: 1 as const,
      run_id: options.runId,
      round: options.round,
      task_id: options.taskId,
      thread_id: threadId as string,
      objective_hash: hash,
      started_at: started,
      updated_at: now(),
      latest_goal_status: goal.status,
      activation_evidence: existing?.activation_evidence ?? {
        method: "thread/goal/updated" as const,
        status: "active" as const,
        observed_at: now(),
      },
      goal,
    } satisfies GoalWorkerArtifact;
    await writeJsonAtomic(path, evidence);
    if (goal.status !== "complete") {
      return {
        text,
        meta: {
          goalStatus: goal.status,
          tokensUsed: goal.tokensUsed,
          timeUsedSeconds: goal.timeUsedSeconds,
        },
        goalStatus: goal.status,
        error: `GOAL_STATUS:${goal.status}`,
      };
    }
    return {
      text,
      meta: {
        goalStatus: goal.status,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
      },
      goalStatus: goal.status,
    };
  } catch (error) {
    return {
      text: "",
      meta: {},
      error: `GOAL_RUNTIME_UNAVAILABLE: ${errorMessage(error)}`,
    };
  } finally {
    await transport.close().catch(() => undefined);
  }
}
