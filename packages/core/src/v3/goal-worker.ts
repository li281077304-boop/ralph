import { createHash } from "node:crypto";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { readFile, stat, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
  /** Explicit protocol evidence that a blocked Goal needs user input. */
  humanRequired?: boolean;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  [key: string]: unknown;
};

export type GoalWaitResult = {
  goal: GoalRecord;
  activationSeen: boolean;
  text: string;
};

export type GoalObservation = {
  observedAt: string;
  goal: GoalRecord;
  transportConnected: boolean;
  agentMessageAt?: string;
};

export type GoalWaitOptions = {
  /** Polling is the authoritative reconciliation path; notifications are a fast path. */
  pollIntervalMs?: number;
  /** Test seam for deterministic clock/sleep based liveness tests. */
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onObservation?: (observation: GoalObservation) => Promise<void> | void;
  onAgentMessage?: (observedAt: string, text: string) => Promise<void> | void;
  stallAfterMs?: number;
  progressProbe?: () => Promise<boolean> | boolean;
  onStall?: (details: {
    goal: GoalRecord;
    lastMeaningfulProgressAt: string;
    stallDurationMs: number;
  }) => Promise<void> | void;
};

export interface GoalTransport {
  initialize(): Promise<void>;
  startThread(params: Record<string, unknown>): Promise<{ threadId: string }>;
  resumeThread(threadId: string): Promise<void>;
  setGoal(threadId: string, objective: string): Promise<GoalRecord>;
  getGoal(threadId: string): Promise<GoalRecord | null>;
  waitForGoal(
    threadId: string,
    timeoutMs: number,
    options?: GoalWaitOptions
  ): Promise<GoalWaitResult>;
  /** Explicit lifecycle operation. close() intentionally does not pause a Goal. */
  pauseGoal?(threadId: string): Promise<GoalRecord>;
  close(): Promise<void>;
}

type GoalLifecycle = "thread_started" | "goal_active" | "terminal";

type GoalActivationEvidence = {
  method: "thread/goal/set" | "thread/goal/get" | "thread/goal/updated";
  status: "active";
  observed_at: string;
};

type GoalRecoveryEvidence = {
  method: "thread/goal/get";
  status: Exclude<GoalStatus, "active">;
  observed_at: string;
};

export type GoalWorkerArtifact = {
  version: 1;
  run_id: string;
  round: number;
  task_id: string;
  thread_id: string;
  objective_hash: string;
  started_at: string;
  updated_at: string;
  lifecycle: GoalLifecycle;
  latest_goal_status: GoalStatus;
  activation_evidence?: GoalActivationEvidence;
  recovery_evidence?: GoalRecoveryEvidence;
  goal?: GoalRecord;
};

export type GoalLivenessArtifact = {
  version: 1;
  run_id: string;
  round: number;
  task_id: string;
  thread_id: string;
  last_reconcile_at: string;
  last_goal_status: GoalStatus;
  last_status_change_at: string;
  last_agent_message_at?: string;
  last_workspace_change_at?: string;
  last_tokens_used?: number;
  last_time_used_seconds?: number;
  transport_connected: boolean;
  transport_last_seen_at: string;
  stall_state: "healthy" | "suspect" | "stalled";
  stall_reason?: string;
  updated_at: string;
};

export type GoalStallArtifact = {
  version: 1;
  run_id: string;
  round: number;
  task_id: string;
  thread_id: string;
  goal_status: GoalStatus;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  last_meaningful_progress_at: string;
  stall_duration_seconds: number;
  workspace_evidence: Record<string, unknown>;
  transport_evidence: Record<string, unknown>;
  reason: "NO_MEANINGFUL_PROGRESS";
  created_at: string;
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

function livenessPath(
  projectRoot: string,
  runId: string,
  round: number
): string {
  return join(
    getRoundDir(getChiefRunDir(projectRoot, runId), round),
    "goal_liveness.json"
  );
}

function stallPath(projectRoot: string, runId: string, round: number): string {
  return join(
    getRoundDir(getChiefRunDir(projectRoot, runId), round),
    "goal_stall.json"
  );
}

function workspaceEvidence(projectRoot: string): Record<string, unknown> {
  try {
    const status = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const diff = execFileSync("git", ["diff", "--no-ext-diff"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stagedDiff = execFileSync(
      "git",
      ["diff", "--cached", "--no-ext-diff"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const untrackedFiles = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        cwd: projectRoot,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const untrackedHash = createHash("sha256");
    for (const file of untrackedFiles
      .toString("utf8")
      .split("\0")
      .filter(Boolean)) {
      untrackedHash.update(file);
      try {
        untrackedHash.update(readFileSync(join(projectRoot, file)));
      } catch {
        untrackedHash.update("<unreadable>");
      }
    }
    const untrackedDigest = untrackedHash.digest("hex");
    return {
      head,
      status,
      diff_hash: createHash("sha256").update(diff).digest("hex"),
      staged_diff_hash: createHash("sha256").update(stagedDiff).digest("hex"),
      untracked_hash: untrackedDigest,
      fingerprint: createHash("sha256")
        .update(
          `${head}\n${status}\n${diff}\n${stagedDiff}\n${untrackedDigest}`
        )
        .digest("hex"),
    };
  } catch {
    return { status: "unavailable" };
  }
}

async function latestRoundProgress(
  roundPath: string
): Promise<string | undefined> {
  try {
    const entries = await readdir(roundPath);
    let latest: number | undefined;
    for (const name of entries) {
      if (name === "goal_liveness.json" || name === "goal_stall.json") continue;
      try {
        const info = await stat(join(roundPath, name));
        const time = info.mtimeMs;
        if (latest === undefined || time > latest) latest = time;
      } catch {
        // A concurrently-created artifact is not a reason to fail liveness.
      }
    }
    return latest === undefined ? undefined : new Date(latest).toISOString();
  } catch {
    return undefined;
  }
}

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateGoalBinding(
  goal: GoalRecord,
  threadId: string,
  expectedObjectiveHash: string,
  label: string
): GoalRecord {
  if (goal.threadId !== threadId)
    throw new Error(`${label} thread identity mismatch`);
  if (objectiveHash(goal.objective) !== expectedObjectiveHash)
    throw new Error(`${label} objective identity mismatch`);
  return goal;
}

function parseGoalArtifact(value: unknown): GoalWorkerArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("goal_worker.json is malformed");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.run_id !== "string" ||
    typeof record.round !== "number" ||
    typeof record.task_id !== "string" ||
    typeof record.thread_id !== "string" ||
    typeof record.objective_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.objective_hash) ||
    typeof record.started_at !== "string" ||
    typeof record.updated_at !== "string" ||
    !isGoalStatus(record.latest_goal_status) ||
    !["thread_started", "goal_active", "terminal"].includes(
      record.lifecycle as string
    )
  )
    throw new Error("goal_worker.json lifecycle or identity is malformed");
  const activation = record.activation_evidence;
  if (activation !== undefined) {
    if (
      !activation ||
      typeof activation !== "object" ||
      Array.isArray(activation)
    )
      throw new Error("goal_worker.json activation evidence is malformed");
    const evidence = activation as Record<string, unknown>;
    if (
      !["thread/goal/set", "thread/goal/get", "thread/goal/updated"].includes(
        evidence.method as string
      ) ||
      evidence.status !== "active" ||
      typeof evidence.observed_at !== "string"
    )
      throw new Error("goal_worker.json activation evidence is malformed");
  }
  const recovery = record.recovery_evidence;
  if (recovery !== undefined) {
    if (!recovery || typeof recovery !== "object" || Array.isArray(recovery))
      throw new Error("goal_worker.json recovery evidence is malformed");
    const evidence = recovery as Record<string, unknown>;
    if (
      evidence.method !== "thread/goal/get" ||
      !isGoalStatus(evidence.status) ||
      evidence.status === "active" ||
      typeof evidence.observed_at !== "string"
    )
      throw new Error("goal_worker.json recovery evidence is malformed");
  }
  const parsedRecovery = recovery as GoalRecoveryEvidence | undefined;
  if (record.lifecycle === "thread_started" && activation !== undefined)
    throw new Error("thread_started Goal artifact cannot claim activation");
  if (record.lifecycle === "thread_started" && recovery !== undefined)
    throw new Error("thread_started Goal artifact cannot claim recovery");
  if (
    record.lifecycle !== "thread_started" &&
    activation === undefined &&
    recovery === undefined
  )
    throw new Error("active Goal artifact is missing activation evidence");
  if (
    record.lifecycle === "thread_started" &&
    record.latest_goal_status !== "active"
  )
    throw new Error("thread_started Goal artifact has an invalid status");
  if (
    record.lifecycle === "goal_active" &&
    record.latest_goal_status !== "active"
  )
    throw new Error("goal_active Goal artifact has an invalid status");
  if (record.lifecycle === "terminal") {
    if (record.latest_goal_status === "active")
      throw new Error("terminal Goal artifact has an active status");
    if (!record.goal) throw new Error("terminal Goal artifact is missing Goal");
    const storedGoal = requireGoal(record.goal, "goal_worker.json Goal");
    if (
      parsedRecovery &&
      (parsedRecovery.status !== record.latest_goal_status ||
        parsedRecovery.status !== storedGoal.status)
    )
      throw new Error("goal_worker.json recovery status does not match Goal");
  }
  return record as GoalWorkerArtifact;
}

/**
 * Minimal JSONL app-server client. It deliberately exposes only the native
 * thread/goal operations needed by the V3 Worker; no ordinary codex exec
 * fallback is present.
 */
export class NativeCodexGoalTransport implements GoalTransport {
  private child: ChildProcessWithoutNullStreams;
  private lines!: Interface;
  private readonly binary: string;
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
  private disconnected = false;
  private readonly disconnectListeners = new Set<() => void>();
  private stderr = "";

  private constructor(
    child: ChildProcessWithoutNullStreams,
    binary = process.env.RALPH_CODEX_BIN ?? "codex"
  ) {
    this.binary = binary;
    this.child = child;
    this.attachChild(child);
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    this.lines?.close();
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
      this.disconnected = true;
      const suffix = this.stderr ? `: ${this.stderr.trim()}` : "";
      for (const waiter of this.pending.values())
        waiter.reject(new Error(`Codex app-server exited${suffix}`));
      this.pending.clear();
      for (const listener of this.disconnectListeners) listener();
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
    return new NativeCodexGoalTransport(child, binary);
  }

  private async reconnect(threadId: string): Promise<void> {
    if (this.closed) throw new Error("Codex app-server transport is closed");
    const child = spawn(this.binary, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.attachChild(child);
    this.disconnected = false;
    try {
      await this.initialize();
      await this.resumeThread(threadId);
    } catch (error) {
      this.disconnected = true;
      throw new Error(
        `Codex app-server reconnect failed: ${errorMessage(error)}`
      );
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (this.closed)
      return Promise.reject(new Error("Codex app-server transport is closed"));
    if (this.disconnected)
      return Promise.reject(
        new Error("Codex app-server transport disconnected")
      );
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
    timeoutMs: number,
    options: GoalWaitOptions = {}
  ): Promise<GoalWaitResult> {
    const clock = options.now ?? Date.now;
    const sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          timer.unref?.();
        }));
    const pollInterval = Math.max(100, options.pollIntervalMs ?? 30_000);
    const deadline = clock() + timeoutMs;
    let activationSeen = false;
    let text = "";
    let observedTerminal: GoalRecord | undefined;
    let lastAgentMessageAt: string | undefined;
    let lastMeaningfulProgressAt = clock();
    let reconnectAttempts = 0;
    let wake: (() => void) | undefined;
    const listener = (message: JsonRpcMessage): void => {
      if (message.method === "item/agentMessage/delta") {
        const params = message.params ?? {};
        if (typeof params.threadId === "string" && params.threadId !== threadId)
          return;
        const delta = params.delta;
        if (typeof delta === "string") {
          text += delta;
          lastAgentMessageAt = new Date(clock()).toISOString();
          lastMeaningfulProgressAt = clock();
          void options.onAgentMessage?.(lastAgentMessageAt, delta);
        }
      }
      if (message.method !== "thread/goal/updated") return;
      const params = message.params ?? {};
      if (params.threadId !== threadId) return;
      const goal = params.goal;
      if (!goal || typeof goal !== "object") return;
      const record = requireGoal(goal, "thread/goal/updated");
      if (record.status === "active") activationSeen = true;
      else observedTerminal = record;
      wake?.();
    };
    const disconnected = (): void => wake?.();
    this.notifications.add(listener);
    this.disconnectListeners.add(disconnected);
    try {
      while (true) {
        if (observedTerminal)
          return { goal: observedTerminal, activationSeen, text };
        const remaining = deadline - clock();
        if (remaining <= 0)
          throw new Error(
            "Native Goal Worker timed out waiting for terminal status"
          );
        if (this.disconnected) {
          if (reconnectAttempts >= 1)
            throw new Error("NATIVE_GOAL_TRANSPORT_DISCONNECTED");
          reconnectAttempts += 1;
          await this.reconnect(threadId);
        }
        let goal: GoalRecord | null;
        try {
          goal = await this.getGoal(threadId);
        } catch (error) {
          if (!this.disconnected) throw error;
          if (reconnectAttempts >= 1)
            throw new Error("NATIVE_GOAL_TRANSPORT_DISCONNECTED");
          reconnectAttempts += 1;
          await this.reconnect(threadId);
          goal = await this.getGoal(threadId);
        }
        if (!goal) {
          await sleep(Math.min(pollInterval, remaining));
          continue;
        }
        if (goal.status === "active") activationSeen = true;
        if (goal.status !== "active") return { goal, activationSeen, text };
        if (await options.progressProbe?.()) lastMeaningfulProgressAt = clock();
        await options.onObservation?.({
          observedAt: new Date(clock()).toISOString(),
          goal,
          transportConnected: !this.disconnected,
          agentMessageAt: lastAgentMessageAt,
        });
        const stallAfterMs = options.stallAfterMs;
        if (
          stallAfterMs !== undefined &&
          stallAfterMs >= 0 &&
          clock() - lastMeaningfulProgressAt >= stallAfterMs
        ) {
          const stallDurationMs = clock() - lastMeaningfulProgressAt;
          await options.onStall?.({
            goal,
            lastMeaningfulProgressAt: new Date(
              lastMeaningfulProgressAt
            ).toISOString(),
            stallDurationMs,
          });
          try {
            const paused = await this.pauseGoal(threadId);
            const confirmed = await this.getGoal(threadId);
            if (!confirmed || confirmed.status !== "paused")
              throw new Error("Goal pause could not be confirmed");
            throw Object.assign(
              new Error("GOAL_STALLED:NO_MEANINGFUL_PROGRESS"),
              { code: "GOAL_STALLED", goal: paused, stallDurationMs }
            );
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.startsWith("GOAL_STALLED:")
            )
              throw error;
            throw new Error(
              `GOAL_STALLED_PAUSE_UNCONFIRMED: ${errorMessage(error)}`
            );
          }
        }
        const interval = Math.min(pollInterval, deadline - clock());
        if (interval <= 0) continue;
        await Promise.race([
          sleep(interval),
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
        ]);
        wake = undefined;
      }
    } finally {
      this.notifications.delete(listener);
      this.disconnectListeners.delete(disconnected);
    }
  }

  async pauseGoal(threadId: string): Promise<GoalRecord> {
    const result = await this.request("thread/goal/set", {
      threadId,
      status: "paused",
    });
    const goal = statusFromGoal(result);
    if (goal.threadId !== threadId || goal.status !== "paused")
      throw new Error("Goal pause response did not confirm paused status");
    return goal;
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
  humanRequired?: boolean;
  technicalFailureKind?: string;
};

/** Explicitly pause and verify a Goal during an intentional controller stop. */
export async function pauseGoalForShutdown(
  transport: GoalTransport,
  threadId: string
): Promise<GoalRecord> {
  if (!transport.pauseGoal)
    throw new Error("Goal transport cannot pause a Goal for shutdown");
  const paused = await transport.pauseGoal(threadId);
  const confirmed = await transport.getGoal(threadId);
  if (
    !confirmed ||
    confirmed.threadId !== threadId ||
    confirmed.status !== "paused"
  )
    throw new Error("Goal pause could not be confirmed during shutdown");
  return paused;
}

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
  goalPollIntervalMs?: number;
  goalStallMs?: number;
  livenessNow?: () => number;
  livenessSleep?: (milliseconds: number) => Promise<void>;
  transport?: GoalTransport;
}): Promise<GoalWorkerResult> {
  const path = artifactPath(options.projectRoot, options.runId, options.round);
  const hash = objectiveHash(options.prompt);
  let existing: GoalWorkerArtifact | undefined;
  try {
    existing = parseGoalArtifact(JSON.parse(await readFile(path, "utf8")));
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
  const livenessFile = livenessPath(
    options.projectRoot,
    options.runId,
    options.round
  );
  const clock = options.livenessNow ?? Date.now;
  let lastWorkspace = JSON.stringify(workspaceEvidence(options.projectRoot));
  let lastWorkspaceChangeAt = now();
  let lastArtifactProgress: string | undefined;
  let lastAgentMessageAt: string | undefined;
  let lastGoalStatus: GoalStatus = "active";
  let lastStatusChangeAt = now();
  const persistLiveness = async (
    goal: GoalRecord,
    connected: boolean
  ): Promise<void> => {
    const observedAt = new Date(clock()).toISOString();
    const workspace = JSON.stringify(workspaceEvidence(options.projectRoot));
    if (workspace !== lastWorkspace) {
      lastWorkspace = workspace;
      lastWorkspaceChangeAt = observedAt;
    }
    if (goal.status !== lastGoalStatus) {
      lastGoalStatus = goal.status;
      lastStatusChangeAt = observedAt;
    }
    const artifactProgress = await latestRoundProgress(
      getRoundDir(
        getChiefRunDir(options.projectRoot, options.runId),
        options.round
      )
    );
    await writeJsonAtomic(livenessFile, {
      version: 1,
      run_id: options.runId,
      round: options.round,
      task_id: options.taskId,
      thread_id: goal.threadId,
      last_reconcile_at: observedAt,
      last_goal_status: goal.status,
      last_status_change_at: lastStatusChangeAt,
      ...(lastAgentMessageAt
        ? { last_agent_message_at: lastAgentMessageAt }
        : {}),
      last_workspace_change_at: lastWorkspaceChangeAt,
      ...(artifactProgress
        ? { last_artifact_change_at: artifactProgress }
        : {}),
      ...(goal.tokensUsed !== undefined
        ? { last_tokens_used: goal.tokensUsed }
        : {}),
      ...(goal.timeUsedSeconds !== undefined
        ? { last_time_used_seconds: goal.timeUsedSeconds }
        : {}),
      transport_connected: connected,
      transport_last_seen_at: observedAt,
      stall_state: "healthy",
      updated_at: observedAt,
    });
  };
  const waitOptions: GoalWaitOptions = {
    pollIntervalMs: options.goalPollIntervalMs,
    stallAfterMs: options.goalStallMs ?? 15 * 60 * 1000,
    now: options.livenessNow,
    sleep: options.livenessSleep,
    onAgentMessage: async (observedAt) => {
      lastAgentMessageAt = observedAt;
    },
    onObservation: async (observation) => {
      await persistLiveness(observation.goal, observation.transportConnected);
    },
    progressProbe: async () => {
      const currentWorkspace = JSON.stringify(
        workspaceEvidence(options.projectRoot)
      );
      let changed = false;
      if (currentWorkspace !== lastWorkspace) {
        lastWorkspace = currentWorkspace;
        lastWorkspaceChangeAt = new Date(clock()).toISOString();
        changed = true;
      }
      const artifactProgress = await latestRoundProgress(
        getRoundDir(
          getChiefRunDir(options.projectRoot, options.runId),
          options.round
        )
      );
      if (artifactProgress && artifactProgress !== lastArtifactProgress) {
        lastArtifactProgress = artifactProgress;
        changed = true;
      }
      return changed;
    },
    onStall: async ({ goal, lastMeaningfulProgressAt, stallDurationMs }) => {
      const observedAt = new Date(clock()).toISOString();
      await writeJsonAtomic(livenessFile, {
        version: 1,
        run_id: options.runId,
        round: options.round,
        task_id: options.taskId,
        thread_id: goal.threadId,
        last_reconcile_at: observedAt,
        last_goal_status: goal.status,
        last_status_change_at: lastStatusChangeAt,
        ...(lastAgentMessageAt
          ? { last_agent_message_at: lastAgentMessageAt }
          : {}),
        last_workspace_change_at: lastWorkspaceChangeAt,
        ...(goal.tokensUsed !== undefined
          ? { last_tokens_used: goal.tokensUsed }
          : {}),
        ...(goal.timeUsedSeconds !== undefined
          ? { last_time_used_seconds: goal.timeUsedSeconds }
          : {}),
        transport_connected: true,
        transport_last_seen_at: observedAt,
        stall_state: "stalled",
        stall_reason: "NO_MEANINGFUL_PROGRESS",
        updated_at: observedAt,
      } satisfies GoalLivenessArtifact);
      await writeJsonAtomic(
        stallPath(options.projectRoot, options.runId, options.round),
        {
          version: 1,
          run_id: options.runId,
          round: options.round,
          task_id: options.taskId,
          thread_id: goal.threadId,
          goal_status: goal.status,
          ...(goal.tokensUsed !== undefined
            ? { tokensUsed: goal.tokensUsed }
            : {}),
          ...(goal.timeUsedSeconds !== undefined
            ? { timeUsedSeconds: goal.timeUsedSeconds }
            : {}),
          last_meaningful_progress_at: lastMeaningfulProgressAt,
          stall_duration_seconds: stallDurationMs / 1000,
          workspace_evidence: workspaceEvidence(options.projectRoot),
          transport_evidence: { connected: true },
          reason: "NO_MEANINGFUL_PROGRESS",
          created_at: observedAt,
        } satisfies GoalStallArtifact
      );
    },
  };
  await writeJsonAtomic(livenessFile, {
    version: 1,
    run_id: options.runId,
    round: options.round,
    task_id: options.taskId,
    thread_id: existing?.thread_id ?? "pending",
    last_reconcile_at: now(),
    last_goal_status: "active",
    last_status_change_at: now(),
    last_workspace_change_at: lastWorkspaceChangeAt,
    transport_connected: true,
    transport_last_seen_at: now(),
    stall_state: "healthy",
    updated_at: now(),
  } satisfies GoalLivenessArtifact);
  let activeThreadId = existing?.thread_id;
  try {
    await transport.initialize();
    let threadId = existing?.thread_id;
    let goal: GoalRecord | null = null;
    let activationSeen = Boolean(
      existing?.activation_evidence || existing?.recovery_evidence
    );
    let activationEvidence = existing?.activation_evidence;
    let recoveryEvidence = existing?.recovery_evidence;
    let text = "";
    if (threadId) {
      await transport.resumeThread(threadId);
      goal = await transport.getGoal(threadId);
      if (!goal) {
        const wait = transport.waitForGoal(
          threadId,
          options.goalTimeoutMs ?? 86_400_000,
          waitOptions
        );
        const set = validateGoalBinding(
          await transport.setGoal(threadId, options.prompt),
          threadId,
          hash,
          "thread/goal/set"
        );
        if (set.status !== "active")
          throw new Error("thread/goal/set did not activate the expected Goal");
        activationSeen = true;
        activationEvidence = {
          method: "thread/goal/set",
          status: "active",
          observed_at: now(),
        };
        await writeJsonAtomic(path, {
          version: 1,
          run_id: options.runId,
          round: options.round,
          task_id: options.taskId,
          thread_id: threadId,
          objective_hash: hash,
          started_at: started,
          updated_at: now(),
          lifecycle: "goal_active",
          latest_goal_status: "active",
          activation_evidence: activationEvidence,
        } satisfies GoalWorkerArtifact);
        const waited = await wait;
        goal = validateGoalBinding(
          waited.goal,
          threadId,
          hash,
          "thread/goal/updated"
        );
        activationSeen ||= waited.activationSeen;
        text = waited.text;
      } else {
        goal = validateGoalBinding(goal, threadId, hash, "thread/goal/get");
        if (!activationEvidence && goal.status === "active") {
          if (!existing)
            throw new Error("Native Goal recovery artifact is missing");
          activationEvidence = {
            method: "thread/goal/get",
            status: "active",
            observed_at: now(),
          };
          activationSeen = true;
          await writeJsonAtomic(path, {
            ...existing,
            updated_at: now(),
            lifecycle: "goal_active",
            latest_goal_status: "active",
            activation_evidence: activationEvidence,
          } satisfies GoalWorkerArtifact);
        }
        if (goal.status === "active") {
          const waited = await transport.waitForGoal(
            threadId,
            options.goalTimeoutMs ?? 86_400_000,
            waitOptions
          );
          goal = validateGoalBinding(
            waited.goal,
            threadId,
            hash,
            "thread/goal/updated"
          );
          activationSeen ||= waited.activationSeen;
          text = waited.text;
        } else if (
          existing?.lifecycle === "thread_started" &&
          !recoveryEvidence
        ) {
          recoveryEvidence = {
            method: "thread/goal/get",
            status: goal.status,
            observed_at: now(),
          };
          activationSeen = true;
          await writeJsonAtomic(path, {
            ...existing,
            updated_at: now(),
            lifecycle: "terminal",
            latest_goal_status: goal.status,
            recovery_evidence: recoveryEvidence,
            goal,
          } satisfies GoalWorkerArtifact);
        }
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
      activeThreadId = threadId;
      await writeJsonAtomic(path, {
        version: 1,
        run_id: options.runId,
        round: options.round,
        task_id: options.taskId,
        thread_id: threadId,
        objective_hash: hash,
        started_at: started,
        updated_at: now(),
        lifecycle: "thread_started",
        latest_goal_status: "active",
      } satisfies GoalWorkerArtifact);
      const wait = transport.waitForGoal(
        threadId,
        options.goalTimeoutMs ?? 86_400_000,
        waitOptions
      );
      const set = validateGoalBinding(
        await transport.setGoal(threadId, options.prompt),
        threadId,
        hash,
        "thread/goal/set"
      );
      if (set.status !== "active")
        throw new Error("thread/goal/set did not activate the expected Goal");
      activationSeen = true;
      activationEvidence = {
        method: "thread/goal/set",
        status: "active",
        observed_at: now(),
      };
      await writeJsonAtomic(path, {
        version: 1,
        run_id: options.runId,
        round: options.round,
        task_id: options.taskId,
        thread_id: threadId,
        objective_hash: hash,
        started_at: started,
        updated_at: now(),
        lifecycle: "goal_active",
        latest_goal_status: "active",
        activation_evidence: activationEvidence,
      } satisfies GoalWorkerArtifact);
      const waited = await wait;
      goal = validateGoalBinding(
        waited.goal,
        threadId,
        hash,
        "thread/goal/updated"
      );
      activationSeen ||= waited.activationSeen;
      text = waited.text;
    }
    if (!goal || !isGoalStatus(goal.status))
      return {
        text: "",
        meta: {},
        error: "Native Goal returned no terminal status",
      };
    await persistLiveness(goal, true);
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
      lifecycle: "terminal" as const,
      latest_goal_status: goal.status,
      ...(activationEvidence
        ? { activation_evidence: activationEvidence }
        : !recoveryEvidence
          ? {
              activation_evidence: {
                method: "thread/goal/updated" as const,
                status: "active" as const,
                observed_at: now(),
              },
            }
          : {}),
      ...(recoveryEvidence ? { recovery_evidence: recoveryEvidence } : {}),
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
        ...(goal.humanRequired === true ? { humanRequired: true } : {}),
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
    if (error instanceof Error && error.message.startsWith("GOAL_STALLED:")) {
      const stalledGoal = (error as Error & { goal?: GoalRecord }).goal;
      const observedAt = new Date(clock()).toISOString();
      await writeJsonAtomic(livenessFile, {
        version: 1,
        run_id: options.runId,
        round: options.round,
        task_id: options.taskId,
        thread_id: stalledGoal?.threadId ?? activeThreadId ?? "unknown",
        last_reconcile_at: observedAt,
        last_goal_status: stalledGoal?.status ?? "paused",
        last_status_change_at: lastStatusChangeAt,
        ...(lastAgentMessageAt
          ? { last_agent_message_at: lastAgentMessageAt }
          : {}),
        last_workspace_change_at: lastWorkspaceChangeAt,
        ...(stalledGoal?.tokensUsed !== undefined
          ? { last_tokens_used: stalledGoal.tokensUsed }
          : {}),
        ...(stalledGoal?.timeUsedSeconds !== undefined
          ? { last_time_used_seconds: stalledGoal.timeUsedSeconds }
          : {}),
        transport_connected: true,
        transport_last_seen_at: observedAt,
        stall_state: "stalled",
        stall_reason: "NO_MEANINGFUL_PROGRESS",
        updated_at: observedAt,
      } satisfies GoalLivenessArtifact);
      return {
        text: "",
        meta: {
          goalStatus: stalledGoal?.status ?? "paused",
          technicalFailureKind: "GOAL_STALLED",
          stallDurationMs: (error as Error & { stallDurationMs?: number })
            .stallDurationMs,
        },
        goalStatus: stalledGoal?.status ?? "paused",
        humanRequired: false,
        technicalFailureKind: "GOAL_STALLED",
        error: error.message,
      };
    }
    if (
      error instanceof Error &&
      (error.message.includes("DISCONNECTED") ||
        error.message.includes("reconnect failed"))
    ) {
      const observedAt = new Date(clock()).toISOString();
      await writeJsonAtomic(livenessFile, {
        version: 1,
        run_id: options.runId,
        round: options.round,
        task_id: options.taskId,
        thread_id: activeThreadId ?? "unknown",
        last_reconcile_at: observedAt,
        last_goal_status: lastGoalStatus,
        last_status_change_at: lastStatusChangeAt,
        ...(lastAgentMessageAt
          ? { last_agent_message_at: lastAgentMessageAt }
          : {}),
        last_workspace_change_at: lastWorkspaceChangeAt,
        transport_connected: false,
        transport_last_seen_at: observedAt,
        stall_state: "suspect",
        stall_reason: "TRANSPORT_DISCONNECTED",
        updated_at: observedAt,
      } satisfies GoalLivenessArtifact);
    }
    return {
      text: "",
      meta: {},
      error: `GOAL_RUNTIME_UNAVAILABLE: ${errorMessage(error)}`,
    };
  } finally {
    await transport.close().catch(() => undefined);
  }
}
