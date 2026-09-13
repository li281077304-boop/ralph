import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Stage } from "../stages.js";
import type { StageMeta } from "../agents/index.js";
import { runStage, type RunStageOptions } from "../runner.js";
import {
  GitGuard,
  workspaceFingerprint,
  type RepoSnapshot,
} from "../git-guard.js";
import { getChiefRunDir, getRoundDir } from "./rounds.js";
import { loadProjectStateFromProject } from "./project-plan.js";
import {
  loadRunState,
  saveRunState,
  type ProjectState,
  type ProjectTask,
  type RunState,
} from "./state.js";
import { assertProjectState, assertRunState } from "./state-invariants.js";
import { writeJsonAtomic, writeTextAtomic } from "./atomic-json.js";
import { parseChiefReviewDecision } from "./review.js";
import { runNativeGoalWorker, type GoalTransport } from "./goal-worker.js";

export type V3WorkerConfig = {
  worker: {
    agent: "codex" | "claude";
    model?: string;
    reasoning_effort?: string;
    mode?: "stage" | "native_goal";
  };
  forbidden_paths?: string[];
  protected_paths?: string[];
  max_diff_bytes?: number;
  max_changed_paths?: number;
  ralph_dir?: string;
  package_dir?: string;
};

export type V3WorkerRunner = (
  stage: Stage,
  prompt: string,
  workspaceDir: string,
  iteration: number,
  options?: RunStageOptions
) => Promise<{ text: string; meta: StageMeta }>;

export type WorkerPhaseResult = {
  runState: RunState;
  projectState: ProjectState;
  worker?: { text: string; meta: StageMeta; error?: string };
  snapshot?: RepoSnapshot;
};

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function maybeGit(root: string, args: string[]): string {
  try {
    return git(root, args);
  } catch {
    return "";
  }
}

function runPath(root: string, runId: string): string {
  return join(getChiefRunDir(root, runId), "RUN_STATE.json");
}

function roundDir(root: string, runId: string, round: number): string {
  return getRoundDir(getChiefRunDir(root, runId), round);
}

function artifact(
  root: string,
  runId: string,
  round: number,
  name: string
): string {
  return join(roundDir(root, runId, round), name);
}

function snapshotSummary(snapshot: RepoSnapshot): Record<string, unknown> {
  const diffHash = createHash("sha256")
    .update(snapshot.diff, "utf8")
    .digest("hex");
  return {
    branch: snapshot.branch,
    head: snapshot.head,
    status: snapshot.status,
    diff_stat: snapshot.diffStat,
    diff_hash: diffHash,
    tracked_paths: [...snapshot.trackedFiles.keys()].sort(),
    untracked_paths: [...snapshot.untrackedFiles.keys()].sort(),
    workspace_fingerprint: workspaceFingerprint(snapshot),
  };
}

function controls(config: V3WorkerConfig) {
  return {
    protectedPaths: config.protected_paths ?? [],
    forbiddenPaths: config.forbidden_paths ?? [],
    maxDiffBytes: config.max_diff_bytes,
    maxChangedPaths: config.max_changed_paths,
  };
}

function failState(state: RunState, reason: string): RunState {
  return {
    ...state,
    phase: "FAILED",
    status: "failed",
    failure_reason: reason,
    updated_at: new Date().toISOString(),
  };
}

function cleanStatus(root: string): string {
  return maybeGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
}

function branch(root: string): string {
  return maybeGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
}

function selectedTask(project: ProjectState, run: RunState): ProjectTask {
  if (run.current_task_id === null)
    throw new Error("WORKER requires current_task_id");
  if (project.current_task_id !== run.current_task_id)
    throw new Error("PROJECT_STATE current_task_id does not match RUN_STATE");
  const active = project.tasks.filter((task) => task.status === "in_progress");
  if (active.length !== 1 || active[0].id !== run.current_task_id)
    throw new Error("WORKER requires exactly one matching in_progress task");
  return active[0];
}

async function readSelectDecision(
  root: string,
  run: RunState
): Promise<unknown> {
  const path = artifact(root, run.run_id, run.round, "select_decision.json");
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`select_decision.json is malformed: ${path}`, {
      cause: error,
    });
  }
}

async function readPreviousReviewDecision(
  root: string,
  run: RunState,
  project: ProjectState,
  task: ProjectTask
): Promise<unknown> {
  if (run.round <= 1) return undefined;
  const path = artifact(
    root,
    run.run_id,
    run.round - 1,
    "review_decision.json"
  );
  let decision: ReturnType<typeof parseChiefReviewDecision>;
  try {
    decision = parseChiefReviewDecision(
      JSON.parse(await readFile(path, "utf8"))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`review_decision.json is malformed: ${path}`, {
      cause: error,
    });
  }
  if (decision.action !== "PATCH")
    throw new Error("Previous Review decision is not a PATCH continuation");
  let checkpoint: Record<string, unknown>;
  try {
    checkpoint = JSON.parse(
      await readFile(
        artifact(root, run.run_id, run.round - 1, "checkpoint.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
  } catch (error) {
    throw new Error("Previous Review PATCH checkpoint evidence is missing", {
      cause: error,
    });
  }
  if (
    checkpoint.task_id !== task.id ||
    project.current_task_id !== task.id ||
    run.current_task_id !== task.id
  )
    throw new Error("Previous Review PATCH task continuity is invalid");
  return decision;
}

export function buildWorkerPrompt(
  project: ProjectState,
  run: RunState,
  task: ProjectTask,
  selectDecision?: unknown
): string {
  const context =
    selectDecision &&
    typeof selectDecision === "object" &&
    "review_decision" in selectDecision
      ? {
          continuation: "REVIEW_PATCH",
          action: (selectDecision as { review_decision?: { action?: unknown } })
            .review_decision?.action,
          summary: (
            selectDecision as { review_decision?: { summary?: unknown } }
          ).review_decision?.summary,
          patch_instructions: (
            selectDecision as {
              review_decision?: { patch_instructions?: unknown };
            }
          ).review_decision?.patch_instructions,
        }
      : (selectDecision ?? {});
  const contextText = JSON.stringify(context, null, 2);
  const boundedContext =
    contextText.length <= 2400
      ? contextText
      : `${contextText.slice(0, 2350)}\n...[context truncated]`;
  return [
    "# RALPH V3 WORKER",
    "",
    "You are the implementation Worker. Execute only the selected task below.",
    "Do not choose another backlog item, change priorities, invent requirements, commit, push, merge, or switch branches.",
    "Leave the implementation in the working tree for the Machine Gate.",
    "Respect all protected and forbidden paths.",
    "",
    `project goal: ${project.goal}`,
    `current milestone: ${project.current_milestone}`,
    `run_id: ${run.run_id}`,
    `round: ${run.round}`,
    `task id: ${task.id}`,
    `task title: ${task.title}`,
    `task goal: ${task.goal}`,
    `task priority: ${task.priority}`,
    `dependencies: ${task.dependencies.join(", ") || "none"}`,
    `acceptance:\n${task.acceptance.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `verification:\n${task.verification.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `evidence:\n${task.evidence.map((item) => `- ${item}`).join("\n") || "- none"}`,
    `source: ${task.source}`,
    "",
    "Accepted Chief construction context (evidence only):",
    boundedContext,
    "",
    "When done, provide a concise summary of implementation and verification. Do not emit a control decision.",
  ].join("\n");
}

function defaultRunner(
  config: V3WorkerConfig,
  root: string,
  runDir: string
): V3WorkerRunner {
  return (stage, prompt, workspace, iteration, options = {}) =>
    runStage(
      stage,
      prompt,
      workspace,
      iteration,
      undefined,
      join(
        runDir,
        "rounds",
        String(iteration).padStart(3, "0"),
        "worker.ndjson"
      ),
      {
        ...options,
        agent: stage.agent,
        model: stage.model,
        reasoningEffort: stage.reasoningEffort,
        skillsHostDir: config.package_dir
          ? join(config.package_dir, "templates", "skills")
          : undefined,
      }
    );
}

function fingerprintEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function runWorkerPhase(options: {
  projectRoot: string;
  runId: string;
  config: V3WorkerConfig;
  runAgent?: V3WorkerRunner;
  /** Test seam for a protocol-level fake; production leaves this undefined. */
  goalTransport?: GoalTransport;
}): Promise<WorkerPhaseResult> {
  const root = options.projectRoot;
  const path = runPath(root, options.runId);
  const run = await loadRunState(path);
  const project = await loadProjectStateFromProject(root);
  assertRunState(run);
  assertProjectState(project);
  if (run.phase !== "WORKER" || run.status !== "running")
    throw new Error("V3 Worker requires WORKER/running state");
  const task = selectedTask(project, run);
  const currentBranch = branch(root);
  if (!currentBranch)
    throw new Error("WORKER requires a non-detached Git branch");
  const runDir = getChiefRunDir(root, options.runId);
  const round = roundDir(root, options.runId, run.round);
  await mkdir(round, { recursive: true });
  const outputPath = join(round, "worker_output.json");
  const evidencePath = join(round, "worker_evidence.json");
  const guard = new GitGuard(root, controls(options.config));
  const before = guard.snapshot();
  const existingEvidence = await (async () => {
    try {
      return JSON.parse(await readFile(evidencePath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`worker_evidence.json is malformed: ${evidencePath}`, {
        cause: error,
      });
    }
  })();
  if (existingEvidence?.completed === true) {
    const now = workspaceFingerprint(guard.snapshot());
    if (
      !fingerprintEqual(now, existingEvidence.after_workspace_fingerprint) ||
      guard.snapshot().branch !== existingEvidence.after_branch
    ) {
      const failed = failState(
        run,
        "WORKER recovery workspace fingerprint does not match completed worker evidence"
      );
      await saveRunState(path, failed);
      return { runState: failed, projectState: project };
    }
    const next = {
      ...run,
      phase: "MACHINE_GATE" as const,
      updated_at: new Date().toISOString(),
    };
    await saveRunState(path, next);
    return {
      runState: next,
      projectState: project,
      snapshot: guard.snapshot(),
    };
  }
  if (cleanStatus(root) !== "") {
    const failed = failState(
      run,
      "WORKER requires a clean Git worktree before execution"
    );
    await saveRunState(path, failed);
    return { runState: failed, projectState: project };
  }
  const decision = await readSelectDecision(root, run);
  const reviewDecision =
    decision === undefined
      ? await readPreviousReviewDecision(root, run, project, task)
      : undefined;
  const prompt = buildWorkerPrompt(
    project,
    run,
    task,
    decision ??
      (reviewDecision
        ? { continuation: "REVIEW_PATCH", review_decision: reviewDecision }
        : undefined)
  );
  await writeTextAtomic(join(round, "worker_prompt.md"), `${prompt}\n`);
  const runner =
    options.runAgent ?? defaultRunner(options.config, root, runDir);
  let worker: { text: string; meta: StageMeta; error?: string };
  try {
    if (options.config.worker.mode === "native_goal") {
      if (options.config.worker.agent !== "codex")
        throw new Error("Native Goal Worker requires the codex agent");
      const goal = await runNativeGoalWorker({
        projectRoot: root,
        runId: run.run_id,
        round: run.round,
        taskId: task.id,
        prompt,
        model: options.config.worker.model,
        reasoningEffort: options.config.worker.reasoning_effort,
        packageDir: options.config.package_dir,
        transport: options.goalTransport,
      });
      worker = goal as typeof worker;
    } else {
      worker = await runner(
        {
          name: "worker",
          template: "chief-worker.md",
          permissionMode: "bypassPermissions",
          agent: options.config.worker.agent,
          model: options.config.worker.model,
          reasoningEffort: options.config.worker.reasoning_effort,
        },
        prompt,
        root,
        run.round,
        { readOnlyWorkspace: false, dockerSocket: "off" }
      );
    }
  } catch (error) {
    worker = {
      text: "",
      meta: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await writeJsonAtomic(outputPath, worker);
  if (worker.error) {
    const goalStatus = (worker as { goalStatus?: string }).goalStatus;
    if (goalStatus === "blocked") {
      const waiting: RunState = {
        ...run,
        phase: "HUMAN_REQUIRED",
        status: "waiting",
        failure_reason: worker.error,
        updated_at: new Date().toISOString(),
      };
      await saveRunState(path, waiting);
      return { runState: waiting, projectState: project, worker };
    }
    const failed = failState(run, `Worker execution failed: ${worker.error}`);
    await saveRunState(path, failed);
    return { runState: failed, projectState: project, worker };
  }
  const after = guard.snapshot();
  const violations = guard.violations(before, after);
  if (after.head !== before.head)
    violations.push({ kind: "branch", path: "HEAD" });
  const changedPaths = guard.changedPaths(before, after);
  const evidence = {
    version: 1,
    completed: true,
    run_id: run.run_id,
    round: run.round,
    task_id: task.id,
    before: snapshotSummary(before),
    after: snapshotSummary(after),
    changed_paths: changedPaths,
    violations,
    after_workspace_fingerprint: workspaceFingerprint(after),
    before_branch: before.branch,
    after_branch: after.branch,
    created_at: new Date().toISOString(),
  };
  await writeJsonAtomic(evidencePath, evidence);
  if (violations.length) {
    const failed = failState(
      run,
      `Worker policy violation: ${violations.map((item) => `${item.kind}:${item.path}`).join(", ")}`
    );
    await saveRunState(path, failed);
    return { runState: failed, projectState: project, worker, snapshot: after };
  }
  const next: RunState = {
    ...run,
    phase: "MACHINE_GATE",
    status: "running",
    head_evidence: {
      base: before.head,
      head: after.head,
      diff_hash: snapshotSummary(after).diff_hash as string,
    },
    updated_at: new Date().toISOString(),
  };
  await saveRunState(path, next);
  return { runState: next, projectState: project, worker, snapshot: after };
}
