import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

import type { StageMeta } from "./agents/index.js";
import {
  parseChiefDecision,
  parseExternalChiefVerdict,
  type ChiefDecision,
  type ExternalChiefVerdict,
} from "./chief.js";
import {
  defaultChiefConfig,
  loadChiefConfig,
  type ChiefAgentConfig,
  type ChiefConfig,
  type ChiefMode,
} from "./chief-config.js";
import {
  GitGuard,
  type AcceptanceControls,
  type RepoSnapshot,
} from "./git-guard.js";
import {
  runMachineGate,
  type MachineGateOptions,
  type MachineGateResult,
} from "./machine-gate.js";
import {
  dirtySnapshot,
  headShort,
  loadHistoryTail,
  openHistory,
  type HistoryWriter,
} from "./history.js";
import { ensureImage, runStage, type RunStageOptions } from "./runner.js";
import type { Stage } from "./stages.js";

export type ChiefRunStatus =
  | "PLANNING"
  | "WORKING"
  | "MACHINE_CHECK"
  | "CHIEF_REVIEW"
  | "CHIEF_PATCH"
  | "RETURN_TO_WORKER"
  | "WAITING_FOR_CHIEF"
  | "HUMAN_REQUIRED"
  | "PASS"
  | "FAILED"
  | "MAX_ITERATIONS"
  | "TOKEN_BUDGET_EXCEEDED";

export type ChiefLoopConfig = {
  task: string;
  chiefMode?: ChiefMode;
  maxIterations?: number;
  maxTotalTokens?: number;
  timeoutSeconds?: number;
  commands?: string[];
  uatCommands?: string[];
  forbiddenPaths?: string[];
  requiredCleanPatterns?: string[];
  protectedPaths?: string[];
  maxDiffBytes?: number;
  maxChangedPaths?: number;
  chief?: Partial<ChiefAgentConfig>;
  worker?: Partial<ChiefAgentConfig>;
};

export type ChiefRunState = {
  runId: string;
  status: ChiefRunStatus;
  iteration: number;
  totalTokens: number;
  workerTask: string;
  previousGate?: MachineGateResult;
  previousDecision?: ChiefDecision;
  reason?: string;
  startedAt: string;
  updatedAt: string;
};

export type ChiefAgentRunner = (
  stage: Stage,
  prompt: string,
  iteration: number,
  options?: RunStageOptions
) => Promise<{ text: string; meta: StageMeta }>;

export type ChiefLoopOptions = {
  workspaceDir: string;
  packageDir: string;
  ralphDir: string;
  config: ChiefLoopConfig;
  taskPath?: string;
  acceptancePath?: string;
  runId?: string;
  /** Resume an existing external-Chief run using CHIEF_VERDICT.json. */
  resumeRunId?: string;
  verdictPath?: string;
  /** Optional test/custom stage descriptors; defaults use the shipped names. */
  workerStage?: Stage;
  chiefStage?: Stage;
  runAgent?: ChiefAgentRunner;
  runGate?: (
    workspaceDir: string,
    options: MachineGateOptions
  ) => Promise<MachineGateResult>;
};

export type ChiefRunResult = { runDir: string; state: ChiefRunState };

const defaultStage = (name: string, role: "chief" | "worker"): Stage => ({
  name,
  template: role === "chief" ? "chief.md" : "chief-worker.md",
  permissionMode: "bypassPermissions",
});

/**
 * Chief/Worker loop. The legacy Ralph loop is intentionally untouched: this
 * opt-in path reuses its Docker/provider runner but owns a separate state
 * machine, machine-gate boundary, and Chief JSON protocol.
 */
export async function runChiefLoop(
  options: ChiefLoopOptions
): Promise<ChiefRunResult> {
  const config = normalizeConfig(options.config);
  const runId =
    options.resumeRunId ?? options.runId ?? `${timestamp()}-${process.pid}`;
  assertRunId(runId);
  const chiefRunsDir = join(options.workspaceDir, ".ralph", "chief-runs");
  mkdirSync(chiefRunsDir, { recursive: true });
  const chiefRunsGitignore = join(chiefRunsDir, ".gitignore");
  if (!existsSync(chiefRunsGitignore)) writeFileSync(chiefRunsGitignore, "*\n");
  const runDir = join(chiefRunsDir, runId);
  const resumedState = options.resumeRunId
    ? loadPersistedState(join(runDir, "state.json"))
    : undefined;
  const iterationsDir = join(runDir, "iterations");
  mkdirSync(iterationsDir, { recursive: true });
  // Planning is represented as iteration 00 so the shared Ralph runner can
  // write its raw NDJSON log beside the later Worker/Chief logs.
  mkdirSync(join(iterationsDir, "00"), { recursive: true });
  const history = openHistory({
    workspaceDir: options.workspaceDir,
    bin: "chief",
    iterations: config.maxIterations,
    inputs: config.task,
  });
  let historyClosed = false;

  const controls = normalizeControls(
    options.workspaceDir,
    config,
    options.taskPath,
    options.acceptancePath
  );
  const guard = new GitGuard(options.workspaceDir, controls);
  const state: ChiefRunState = resumedState ?? {
    runId,
    status: "PLANNING",
    iteration: 0,
    totalTokens: 0,
    workerTask: "",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const persist = (): void => {
    state.updatedAt = new Date().toISOString();
    atomicWrite(
      join(runDir, "state.json"),
      `${JSON.stringify(state, null, 2)}\n`
    );
  };
  const card = (
    machine: string,
    chief: string,
    risk: string,
    need: string,
    next: string
  ): void => {
    const text =
      state.status === "WAITING_FOR_CHIEF"
        ? [
            "【等待总工】",
            "",
            "当前目标：",
            config.task.trim() || "（任务内容为空）",
            "Worker 已完成：",
            chief,
            "机器验收：",
            machine,
            "当前问题：",
            risk || chief,
            "需要总工判断：",
            need || "请审计 handoff 中的证据",
            "Handoff：",
            relative(options.workspaceDir, join(runDir, "CHIEF_HANDOFF.md")),
            "下一步：",
            next,
          ].join("\n")
        : [
            "【总工进展】",
            "",
            "当前目标：",
            config.task.trim() || "（任务内容为空）",
            "现在在干什么：",
            state.status,
            "为什么：",
            chief,
            "机器验收：",
            machine,
            "总工判断：",
            chief,
            "风险：",
            risk || "无新增风险",
            "需要你做什么：",
            need || "无需操作",
            "下一步：",
            next,
          ].join("\n");
    atomicWrite(join(runDir, "status-card.md"), `${text}\n`);
    process.stdout.write(`${text}\n\n`);
    if (
      !historyClosed &&
      [
        "PASS",
        "FAILED",
        "HUMAN_REQUIRED",
        "MAX_ITERATIONS",
        "TOKEN_BUDGET_EXCEEDED",
      ].includes(state.status)
    ) {
      history.appendFooter(state.iteration, state.reason ?? state.status);
      historyClosed = true;
    }
  };

  atomicWrite(join(runDir, "task_snapshot.md"), `${config.task}\n`);
  if (options.acceptancePath && existsSync(resolve(options.acceptancePath))) {
    copyFileSync(
      resolve(options.acceptancePath),
      join(runDir, "acceptance_snapshot.yaml")
    );
  }
  atomicWrite(
    join(runDir, "config_snapshot.json"),
    `${JSON.stringify(config, null, 2)}\n`
  );
  persist();

  const runAgent = options.runAgent ?? createDockerRunner(options, runDir);
  const runGate = options.runGate ?? runMachineGate;
  const chiefStage = {
    ...(options.chiefStage ?? defaultStage("chief", "chief")),
    ...agentStage(config.chief),
  };
  const workerStage = {
    ...(options.workerStage ?? defaultStage("worker", "worker")),
    ...agentStage(config.worker),
  };

  let startIteration = 1;
  if (options.resumeRunId) {
    if (config.chiefMode !== "external") {
      return finish(
        state,
        runDir,
        "FAILED",
        "只有 external Chief run 可以 resume",
        card,
        "请确认运行配置中的 chief_mode=external"
      );
    }
    if (state.status !== "WAITING_FOR_CHIEF") {
      return finish(
        state,
        runDir,
        "FAILED",
        `运行当前状态为 ${state.status}，不是 WAITING_FOR_CHIEF`,
        card,
        "请检查 state.json"
      );
    }
    const external = loadExternalVerdict(
      options.workspaceDir,
      runDir,
      options.verdictPath
    );
    if (external.error || !external.verdict) {
      return finish(
        state,
        runDir,
        "FAILED",
        external.error ?? "External Chief verdict is missing",
        card,
        "请提供合法的 CHIEF_VERDICT.json"
      );
    }
    const decision = external.verdict;
    state.previousDecision = externalToChiefDecision(decision);
    if (decision.verdict === "PASS") {
      return finish(state, runDir, "PASS", decision.summary, card, "任务完成");
    }
    if (decision.verdict === "HUMAN_REQUIRED")
      return human(state, runDir, externalToChiefDecision(decision), card);
    state.workerTask = decision.worker_task;
    startIteration = state.iteration + 1;
    state.status = "RETURN_TO_WORKER";
    state.reason = decision.summary;
    persist();
    card(
      "沿用上次机器结果",
      decision.summary,
      "",
      "",
      "进入下一轮 Worker 施工"
    );
  } else if (config.chiefMode === "external") {
    // The original TASK is the only available Worker instruction before an
    // external Chief has reviewed anything. This keeps the useful first
    // Worker/Gate pass while ensuring no local Chief model is called.
    state.workerTask = config.task;
    state.status = "WORKING";
    state.reason = "external Chief mode: initial task dispatched to Worker";
    persist();
    card(
      "尚未执行",
      "外部总工模式不调用本地 Chief，首轮直接执行原始 TASK",
      "",
      "",
      "进入 Worker 施工"
    );
  } else {
    const planningBefore = guard.snapshot();
    const planningStarted = Date.now();
    const planning = await callChief(
      runAgent,
      chiefStage,
      planningPrompt(config.task),
      0,
      runDir,
      "planning",
      true,
      state,
      config
    );
    appendHistoryEntry(
      history,
      options.workspaceDir,
      0,
      "chief-planning",
      planningStarted,
      planning,
      join(runDir, "planning-output.json")
    );
    const planningChanges = guard.changedPaths(planningBefore);
    if (planningChanges.length) {
      return finish(
        state,
        runDir,
        "FAILED",
        `Chief planning modified a read-only workspace: ${planningChanges.join(", ")}`,
        card,
        "总工规划阶段发生了文件修改"
      );
    }
    if (planning.error)
      return finish(
        state,
        runDir,
        planning.error === "TOKEN_BUDGET_EXCEEDED"
          ? "TOKEN_BUDGET_EXCEEDED"
          : "FAILED",
        planning.error,
        card,
        planning.error === "TOKEN_BUDGET_EXCEEDED"
          ? "预算已用尽"
          : "未能得到有效的总工计划"
      );
    if (planning.decision?.verdict === "HUMAN_REQUIRED") {
      return human(state, runDir, planning.decision, card);
    }
    state.workerTask = planning.decision?.worker_task || config.task;
    state.previousDecision = planning.decision;
    persist();
    card(
      "尚未执行",
      planning.decision?.summary ?? "总工已生成施工任务",
      planning.decision?.risk ?? "",
      "",
      "进入 Worker 施工"
    );
  }

  for (
    let iteration = startIteration;
    iteration <= config.maxIterations;
    iteration++
  ) {
    state.iteration = iteration;
    state.status = "WORKING";
    persist();
    const iterationDir = join(
      iterationsDir,
      String(iteration).padStart(2, "0")
    );
    mkdirSync(iterationDir, { recursive: true });
    const beforeWorker = guard.snapshot();
    const workerPrompt = workerPromptFor(
      config.task,
      state.workerTask,
      state.previousGate,
      state.previousDecision
    );
    atomicWrite(join(iterationDir, "worker_prompt.md"), `${workerPrompt}\n`);
    const workerStarted = Date.now();
    const worker = await callAgent(
      runAgent,
      workerStage,
      workerPrompt,
      iteration,
      { readOnlyWorkspace: false },
      state,
      config
    );
    appendHistoryEntry(
      history,
      options.workspaceDir,
      iteration,
      "worker",
      workerStarted,
      worker,
      join(iterationDir, "worker_output.json")
    );
    atomicWrite(
      join(iterationDir, "worker_output.json"),
      `${JSON.stringify(worker, null, 2)}\n`
    );
    if (worker.error)
      return finish(
        state,
        runDir,
        "FAILED",
        worker.error,
        card,
        "Worker 调用失败"
      );
    const afterWorker = guard.snapshot();
    if (afterWorker.head !== beforeWorker.head) {
      return finish(
        state,
        runDir,
        "FAILED",
        "Worker 创建了 Git commit；Chief/Worker V1 不允许 Agent 自动提交",
        card,
        "请检查 Worker 日志并手动处理提交"
      );
    }
    const workerViolations = guard.violations(beforeWorker);
    if (workerViolations.length)
      return finish(
        state,
        runDir,
        "FAILED",
        formatViolations(workerViolations),
        card,
        "检测到 Worker 修改控制文件或禁区路径"
      );
    if (addTokens(state, worker.meta, config))
      return finish(
        state,
        runDir,
        "TOKEN_BUDGET_EXCEEDED",
        "Worker 调用后超过 token 预算",
        card,
        "预算已用尽"
      );
    writeRepoEvidence(
      iterationDir,
      afterWorker,
      guard.changedPaths(beforeWorker, afterWorker)
    );

    state.status = "MACHINE_CHECK";
    persist();
    card("执行中", "Worker 已完成，机器正在执行验收", "", "", "等待机器验收");
    const beforeGate = guard.snapshot();
    const gate = await runGate(options.workspaceDir, {
      commands: config.commands,
      uatCommands: config.uatCommands,
      timeoutMs: (config.timeoutSeconds ?? 1800) * 1000,
    });
    appendGateHistory(
      history,
      options.workspaceDir,
      iteration,
      "machine-gate",
      gate,
      join(iterationDir, "machine_gate.json")
    );
    const afterGate = guard.snapshot();
    if (afterGate.head !== beforeGate.head) {
      return finish(
        state,
        runDir,
        "FAILED",
        "Machine Gate 创建了 Git commit；验收命令不得修改提交历史",
        card,
        "请检查 acceptance 命令"
      );
    }
    state.previousGate = gate;
    atomicWrite(
      join(iterationDir, "machine_gate.json"),
      `${JSON.stringify(gate, null, 2)}\n`
    );
    const gateChangedPaths = [
      ...new Set([
        ...guard.changedPaths(beforeWorker),
        ...guard.changedPaths(beforeGate),
      ]),
    ];
    if (hasDirtyPattern(gateChangedPaths, config.requiredCleanPatterns ?? [])) {
      gate.passed = false;
      atomicWrite(
        join(iterationDir, "machine_gate.json"),
        `${JSON.stringify(gate, null, 2)}\n`
      );
    }
    const gateViolations = guard.violations(beforeWorker);
    if (gateViolations.length) {
      return finish(
        state,
        runDir,
        "FAILED",
        `Machine Gate 修改了受保护文件或禁区路径：${formatViolations(gateViolations)}`,
        card,
        "请检查机器验收命令和 Git Guard 日志"
      );
    }

    if (config.chiefMode === "external") {
      state.status = "WAITING_FOR_CHIEF";
      state.reason = gate.passed
        ? "等待外部总工审计 Machine Gate 与 Git diff"
        : "Machine Gate 失败，等待外部总工判断下一步";
      persist();
      writeExternalHandoff({
        runDir,
        workspaceDir: options.workspaceDir,
        state,
        config,
        gate,
        base: guard.initialSnapshot(),
        current: afterGate,
        changedPaths: guard.changedPaths(beforeWorker, afterGate),
        iterationDir,
      });
      card(
        gate.passed ? "PASS" : "FAIL",
        gate.passed
          ? "Worker 已完成，等待外部总工审计"
          : "Machine Gate 失败，等待外部总工分析",
        gate.passed ? "" : gateFailureSummary(gate),
        "请查看 CHIEF_HANDOFF.md 并提供 CHIEF_VERDICT.json",
        "等待外部总工判断"
      );
      return { runDir, state };
    }

    state.status = "CHIEF_REVIEW";
    persist();
    const reviewResult = await chiefReviewLoop({
      options,
      runAgent,
      runGate,
      chiefStage,
      guard,
      state,
      config,
      iterationDir,
      gate,
      iteration,
      card,
      history,
    });
    if (
      reviewResult.state.status === "PASS" ||
      reviewResult.state.status === "HUMAN_REQUIRED" ||
      reviewResult.state.status === "FAILED" ||
      reviewResult.state.status === "TOKEN_BUDGET_EXCEEDED"
    )
      return reviewResult;
    state.workerTask = reviewResult.state.workerTask || state.workerTask;
    state.previousDecision = reviewResult.state.previousDecision;
    state.previousGate = reviewResult.state.previousGate;
    state.status = "RETURN_TO_WORKER";
    persist();
    const returnedGate = reviewResult.state.previousGate ?? gate;
    card(
      returnedGate.passed ? "PASS" : "FAIL",
      reviewResult.state.reason ?? "总工要求 Worker 继续施工",
      reviewResult.state.previousDecision?.risk ?? "",
      "",
      "进入下一轮 Worker"
    );
  }
  return finish(
    state,
    runDir,
    "MAX_ITERATIONS",
    `达到 max_iterations=${config.maxIterations}`,
    card,
    "请查看迭代日志后决定是否重新运行"
  );
}

async function chiefReviewLoop(args: {
  options: ChiefLoopOptions;
  runAgent: ChiefAgentRunner;
  runGate: (
    workspaceDir: string,
    options: MachineGateOptions
  ) => Promise<MachineGateResult>;
  chiefStage: Stage;
  guard: GitGuard;
  state: ChiefRunState;
  config: ChiefLoopConfig;
  iterationDir: string;
  gate: MachineGateResult;
  iteration: number;
  history: HistoryWriter;
  card: (
    machine: string,
    chief: string,
    risk: string,
    need: string,
    next: string
  ) => void;
}): Promise<ChiefRunResult> {
  let gate = args.gate;
  for (let reviewNo = 1; reviewNo <= 4; reviewNo++) {
    args.state.status = "CHIEF_REVIEW";
    const beforeChief = args.guard.snapshot();
    const prompt = reviewPromptFor(
      args.config.task,
      gate,
      beforeChief,
      historyContext(args.options.workspaceDir)
    );
    atomicWrite(
      join(args.iterationDir, `chief_prompt-${reviewNo}.md`),
      `${prompt}\n`
    );
    const chiefStarted = Date.now();
    const chief = await callAgent(
      args.runAgent,
      args.chiefStage,
      prompt,
      args.iteration,
      { readOnlyWorkspace: false, dockerSocket: "off" },
      args.state,
      args.config
    );
    appendHistoryEntry(
      args.history,
      args.options.workspaceDir,
      args.iteration,
      `chief-review-${reviewNo}`,
      chiefStarted,
      chief,
      join(args.iterationDir, `chief_output-${reviewNo}.json`)
    );
    atomicWrite(
      join(args.iterationDir, `chief_output-${reviewNo}.json`),
      `${JSON.stringify(chief, null, 2)}\n`
    );
    if (chief.error)
      return finish(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        "FAILED",
        chief.error,
        args.card,
        "总工调用失败"
      );
    if (addTokens(args.state, chief.meta, args.config))
      return finish(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        "TOKEN_BUDGET_EXCEEDED",
        "Chief 调用后超过 token 预算",
        args.card,
        "预算已用尽"
      );
    const afterChief = args.guard.snapshot();
    if (afterChief.head !== beforeChief.head) {
      return finish(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        "FAILED",
        "Chief 创建了 Git commit；Chief/Worker V1 不允许 Agent 自动提交",
        args.card,
        "请检查 Chief 日志并手动处理提交"
      );
    }
    const changedByChief = args.guard.changedPaths(beforeChief, afterChief);
    const violations = args.guard.violations(beforeChief);
    if (violations.length)
      return finish(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        "FAILED",
        `Chief 控制边界违规：${formatViolations(violations)}`,
        args.card,
        "总工修改了受保护文件"
      );
    const decision = parseChiefDecision(chief.text);
    if (!decision)
      return finish(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        "FAILED",
        "Chief 输出不是严格 JSON 协议",
        args.card,
        "请查看 chief_output 日志"
      );
    args.state.previousDecision = decision;
    if (decision.verdict === "HUMAN_REQUIRED")
      return human(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        decision,
        args.card
      );
    const mustRecheck =
      changedByChief.length > 0 || decision.verdict === "PATCH";
    if (decision.verdict === "PASS" && gate.passed && !mustRecheck) {
      args.state.status = "PASS";
      args.state.reason = decision.summary;
      persistState(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        )
      );
      args.card("PASS", decision.summary, decision.risk, "", "任务完成");
      return {
        runDir: join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        state: args.state,
      };
    }
    // RETURN is a direction for the Worker, not a request to spend another
    // Chief/Gate cycle. When the Chief did not patch the tree, preserve the
    // authoritative gate result and send the narrow task to the next Worker.
    if (decision.verdict === "RETURN" && !changedByChief.length) {
      args.state.status = "RETURN_TO_WORKER";
      args.state.workerTask = decision.worker_task || args.state.workerTask;
      args.state.reason = decision.summary;
      persistState(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        )
      );
      return {
        runDir: join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        state: args.state,
      };
    }
    if (decision.verdict === "PASS" && !gate.passed && !changedByChief.length) {
      return finish(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        "FAILED",
        "Chief 返回 PASS，但 Machine Gate 失败；必须返回 RETURN 或 PATCH",
        args.card,
        "请检查 Chief 输出与机器验收证据"
      );
    }
    args.state.status = "CHIEF_PATCH";
    args.state.workerTask = decision.worker_task || args.state.workerTask;
    args.state.reason = !gate.passed
      ? "机器验收失败，Chief 不能直接宣布 PASS"
      : decision.summary;
    persistState(
      args.state,
      join(args.options.workspaceDir, ".ralph", "chief-runs", args.state.runId)
    );
    const beforePatchGate = args.guard.snapshot();
    gate = await args.runGate(args.options.workspaceDir, {
      commands: args.config.commands,
      uatCommands: args.config.uatCommands,
      timeoutMs: (args.config.timeoutSeconds ?? 1800) * 1000,
    });
    appendGateHistory(
      args.history,
      args.options.workspaceDir,
      args.iteration,
      `machine-gate-chief-patch-${reviewNo}`,
      gate,
      join(args.iterationDir, `machine_gate-chief-patch-${reviewNo}.json`)
    );
    const afterPatchGate = args.guard.snapshot();
    if (afterPatchGate.head !== beforePatchGate.head) {
      return finish(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        "FAILED",
        "PATCH 后的 Machine Gate 创建了 Git commit；验收命令不得修改提交历史",
        args.card,
        "请检查 acceptance 命令"
      );
    }
    const patchGateViolations = args.guard.violations(beforePatchGate);
    if (patchGateViolations.length) {
      return finish(
        args.state,
        join(
          args.options.workspaceDir,
          ".ralph",
          "chief-runs",
          args.state.runId
        ),
        "FAILED",
        `PATCH 后的 Machine Gate 触发 Git Guard：${formatViolations(patchGateViolations)}`,
        args.card,
        "请检查 acceptance 命令和 Git Guard 日志"
      );
    }
    const patchGateChanged = args.guard.changedPaths(
      beforePatchGate,
      afterPatchGate
    );
    if (
      hasDirtyPattern(
        patchGateChanged,
        args.config.requiredCleanPatterns ?? []
      ) ||
      patchGateViolations.length
    ) {
      gate.passed = false;
    }
    args.state.previousGate = gate;
    atomicWrite(
      join(args.iterationDir, `machine_gate-chief-patch-${reviewNo}.json`),
      `${JSON.stringify(gate, null, 2)}\n`
    );
  }
  return finish(
    args.state,
    join(args.options.workspaceDir, ".ralph", "chief-runs", args.state.runId),
    "FAILED",
    "Chief 在同一轮连续要求 PATCH，已停止防止无限循环",
    args.card,
    "请人工检查日志"
  );
}

function normalizeConfig(
  input: ChiefLoopConfig
): Required<
  Pick<
    ChiefLoopConfig,
    | "task"
    | "maxIterations"
    | "timeoutSeconds"
    | "commands"
    | "uatCommands"
    | "forbiddenPaths"
    | "requiredCleanPatterns"
    | "protectedPaths"
  >
> &
  ChiefLoopConfig {
  const base = defaultChiefConfig();
  return {
    ...input,
    chiefMode: input.chiefMode ?? base.chief_mode,
    maxIterations: input.maxIterations ?? base.max_iterations,
    maxTotalTokens: input.maxTotalTokens,
    timeoutSeconds: input.timeoutSeconds ?? base.timeout_seconds,
    commands: input.commands ?? base.commands,
    uatCommands: input.uatCommands ?? base.uat_commands,
    forbiddenPaths: input.forbiddenPaths ?? base.forbidden_paths,
    requiredCleanPatterns:
      input.requiredCleanPatterns ?? base.required_clean_patterns,
    protectedPaths: input.protectedPaths ?? base.protected_paths,
    maxDiffBytes: input.maxDiffBytes ?? base.max_diff_bytes,
    maxChangedPaths: input.maxChangedPaths ?? base.max_changed_paths,
    chief: {
      agent: input.chief?.agent ?? base.chief.agent,
      model: input.chief?.model ?? base.chief.model,
      reasoning_effort:
        input.chief?.reasoning_effort ?? base.chief.reasoning_effort,
    },
    worker: {
      agent: input.worker?.agent ?? base.worker.agent,
      model: input.worker?.model ?? base.worker.model,
      reasoning_effort:
        input.worker?.reasoning_effort ?? base.worker.reasoning_effort,
    },
  };
}

function normalizeControls(
  workspace: string,
  config: ChiefLoopConfig,
  taskPath?: string,
  acceptancePath?: string
): AcceptanceControls {
  const toRelative = (path: string): string =>
    isInside(workspace, path)
      ? relative(workspace, resolve(path)).replaceAll("\\", "/")
      : path;
  return {
    protectedPaths: [
      ...new Set(
        [
          ...(config.protectedPaths ?? []).map(toRelative),
          taskPath && toRelative(taskPath),
          acceptancePath && toRelative(acceptancePath),
        ].filter((item): item is string => Boolean(item))
      ),
    ],
    forbiddenPaths: config.forbiddenPaths,
    maxDiffBytes: config.maxDiffBytes,
    maxChangedPaths: config.maxChangedPaths,
  };
}

function isInside(root: string, path: string): boolean {
  const absolute = resolve(path);
  const prefix = `${resolve(root)}${requireSeparator(root)}`;
  return absolute === resolve(root) || absolute.startsWith(prefix);
}
function requireSeparator(path: string): string {
  return path.endsWith("/") || path.endsWith("\\") ? "" : "/";
}

function agentStage(
  config: Partial<ChiefAgentConfig> | undefined
): Partial<Stage> {
  return config
    ? {
        agent: config.agent,
        model: config.model,
        reasoningEffort: config.reasoning_effort,
      }
    : {};
}

async function callAgent(
  runAgent: ChiefAgentRunner,
  stage: Stage,
  prompt: string,
  iteration: number,
  options: RunStageOptions,
  state: ChiefRunState,
  config: ChiefLoopConfig
): Promise<{ text: string; meta: StageMeta; error?: string }> {
  try {
    return await runAgent(stage, prompt, iteration, options);
  } catch (error) {
    return {
      text: "",
      meta: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function callChief(
  runAgent: ChiefAgentRunner,
  stage: Stage,
  prompt: string,
  iteration: number,
  runDir: string,
  label: string,
  readOnly: boolean,
  state: ChiefRunState,
  config: ChiefLoopConfig
): Promise<{
  text: string;
  meta: StageMeta;
  decision?: ChiefDecision;
  error?: string;
}> {
  const result = await callAgent(
    runAgent,
    stage,
    prompt,
    iteration,
    { readOnlyWorkspace: readOnly, dockerSocket: "off" },
    state,
    config
  );
  atomicWrite(
    join(runDir, `${label}-output.json`),
    `${JSON.stringify(result, null, 2)}\n`
  );
  if (result.error)
    return { text: result.text, meta: result.meta, error: result.error };
  if (addTokens(state, result.meta, config))
    return {
      text: result.text,
      meta: result.meta,
      error: "TOKEN_BUDGET_EXCEEDED",
    };
  const decision = parseChiefDecision(result.text);
  return decision
    ? { text: result.text, meta: result.meta, decision }
    : {
        text: result.text,
        meta: result.meta,
        error: "Chief planning output is not strict JSON",
      };
}

function workerPromptFor(
  task: string,
  workerTask: string,
  gate: MachineGateResult | undefined,
  decision: ChiefDecision | undefined
): string {
  return [
    "# WORKER",
    "",
    "Original task:",
    task,
    "",
    "Narrow task from Chief:",
    workerTask,
    "",
    "Previous machine gate:",
    JSON.stringify(gate ?? { passed: true, commands: [] }, null, 2),
    "",
    "Previous Chief decision:",
    JSON.stringify(decision ?? {}, null, 2),
    "",
    "Implement the narrow task. Do not edit TASK.md, ACCEPTANCE.yaml, CHIEF.md, DECISIONS.md, CHIEF_VERDICT.json, or any forbidden path. Do not commit, push, or merge.",
  ].join("\n");
}

function planningPrompt(task: string): string {
  return [
    `# CHIEF PLANNING`,
    `Original task:`,
    task,
    ``,
    `Inspect the repository, CHIEF.md, DECISIONS.md, and .ralph/history/ when present. Return strict JSON only. Produce a narrow Worker task. Do not edit files during planning.`,
    protocolExample("RETURN"),
  ].join("\n");
}

function reviewPromptFor(
  task: string,
  gate: MachineGateResult,
  snapshot: RepoSnapshot,
  history: string
): string {
  return [
    "# CHIEF REVIEW",
    "",
    "Original task:",
    task,
    "",
    "Authoritative Machine Gate:",
    JSON.stringify(gate, null, 2),
    "",
    "Git evidence:",
    JSON.stringify(
      {
        branch: snapshot.branch,
        head: snapshot.head,
        status: snapshot.status,
        diffStat: snapshot.diffStat,
        diff: snapshot.diff,
      },
      null,
      2
    ),
    "",
    "Recent Ralph history:",
    history || "(no prior history found)",
    "",
    "Audit the current implementation and return exactly one strict JSON object. You may make a small code patch only when verdict is PATCH. A patch always forces another machine gate and a new Chief review; never announce PASS immediately after changing code.",
    protocolExample("PASS"),
  ].join("\n");
}

function historyContext(workspaceDir: string): string {
  return loadHistoryTail(workspaceDir);
}

function assertRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId))
    throw new Error(`Invalid Chief run id: ${runId}`);
}

function loadPersistedState(path: string): ChiefRunState {
  if (!existsSync(path)) throw new Error(`Chief state not found: ${path}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Chief state is not valid JSON: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Chief state has an invalid shape: ${path}`);
  const state = value as Partial<ChiefRunState>;
  if (
    typeof state.runId !== "string" ||
    typeof state.status !== "string" ||
    typeof state.iteration !== "number" ||
    typeof state.totalTokens !== "number" ||
    typeof state.workerTask !== "string"
  )
    throw new Error(`Chief state has an invalid shape: ${path}`);
  return state as ChiefRunState;
}

function loadExternalVerdict(
  workspaceDir: string,
  runDir: string,
  explicitPath?: string
): { verdict?: ExternalChiefVerdict; error?: string } {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : [
        join(runDir, "CHIEF_VERDICT.json"),
        join(workspaceDir, "CHIEF_VERDICT.json"),
      ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path)
    return {
      error: `CHIEF_VERDICT.json not found; expected ${candidates.join(" or ")}`,
    };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      error: `Cannot read external Chief verdict ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const verdict = parseExternalChiefVerdict(raw);
  return verdict
    ? { verdict }
    : { error: `CHIEF_VERDICT.json is not valid external Chief JSON: ${path}` };
}

function externalToChiefDecision(verdict: ExternalChiefVerdict): ChiefDecision {
  return {
    verdict: verdict.verdict,
    summary: verdict.summary,
    reasoning_summary: "external Chief verdict",
    worker_task: verdict.worker_task,
    human_question: verdict.human_question,
    human_options: verdict.human_options,
    risk: "",
    next_step: verdict.next_step,
  };
}

function writeExternalHandoff(args: {
  runDir: string;
  workspaceDir: string;
  state: ChiefRunState;
  config: ChiefLoopConfig;
  gate: MachineGateResult;
  base: RepoSnapshot;
  current: RepoSnapshot;
  changedPaths: string[];
  iterationDir: string;
}): void {
  const relativeEvidence = (path: string): string =>
    relative(args.workspaceDir, path).replaceAll("\\", "/");
  const workerOutputPath = join(args.iterationDir, "worker_output.json");
  let workerSummary = "(worker output unavailable)";
  try {
    const raw = JSON.parse(readFileSync(workerOutputPath, "utf8")) as {
      text?: unknown;
      error?: unknown;
    };
    workerSummary =
      typeof raw.error === "string"
        ? raw.error
        : typeof raw.text === "string"
          ? raw.text
          : workerSummary;
  } catch {
    // The detailed artifact is still linked below.
  }
  const gateLines = args.gate.commands.map((command) => {
    const passed = command.exitCode === 0 && !command.timedOut;
    const detail = passed
      ? ""
      : `\n  stderr/stdout: ${truncate(command.stderr || command.stdout, 700)}`;
    return `- ${passed ? "PASS" : "FAIL"} \`${command.command}\` (exit ${
      command.exitCode ?? "null"
    }, ${command.durationMs}ms${command.timedOut ? ", timeout" : ""})${detail}`;
  });
  const failures = args.gate.commands.filter(
    (command) => command.exitCode !== 0 || command.timedOut
  );
  const question = failures.length
    ? failures
        .map(
          (command) =>
            `分析 \`${command.command}\` 的失败原因，并决定是 PATCH、RETURN 还是 HUMAN_REQUIRED。`
        )
        .join("\n")
    : "请审计当前 diff 与验收证据，决定是否 PASS 或要求 Worker 继续施工。";
  const changed = args.changedPaths.length
    ? args.changedPaths.map((path) => `- ${path}`).join("\n")
    : "- (no changed files)";
  const evidenceDir = relativeEvidence(args.runDir);
  const text = [
    "# CHIEF_HANDOFF",
    "",
    "本文件是 external Chief 模式的精简交接，不包含完整代码或完整日志。",
    "请将外部判断写入 CHIEF_VERDICT.json 后执行 `ralph-chief resume <run_id>`。",
    "",
    "## 【当前目标】",
    args.config.task.trim() || "（任务内容为空）",
    "",
    "## 【当前状态】",
    `${args.state.status} · iteration ${args.state.iteration}/${args.config.maxIterations}`,
    "",
    "## 【Worker 本轮做了什么】",
    truncate(workerSummary, 2_000),
    "",
    "## 【Git 信息】",
    `branch: ${args.current.branch}`,
    `base HEAD: ${args.base.head}`,
    `current HEAD: ${args.current.head}`,
    `status: ${args.current.status || "clean"}`,
    "",
    "## 【Machine Gate】",
    args.gate.passed ? "总体结果：PASS" : "总体结果：FAIL",
    ...(gateLines.length ? gateLines : ["- (no commands configured) "]),
    "",
    "## 【关键失败/异常】",
    failures.length ? gateFailureSummary(args.gate) : "无；请进行最终审计。",
    "",
    "## 【改动范围】",
    `diff stat: ${args.current.diffStat || "(no tracked diff stat)"}`,
    `changed files (${args.changedPaths.length}):`,
    changed,
    "",
    "## 【当前需要总工判断的问题】",
    question,
    "",
    "## 【可选动作】",
    "- PASS",
    "- PATCH（必须在 worker_task 中给出本机 Worker 可执行的小修任务）",
    "- RETURN（给出下一轮窄 Worker 任务）",
    "- HUMAN_REQUIRED",
    "",
    "## 【原始证据位置】",
    `- run directory: ${evidenceDir}`,
    `- state: ${relativeEvidence(join(args.runDir, "state.json"))}`,
    `- Worker output: ${relativeEvidence(workerOutputPath)}`,
    `- Machine Gate: ${relativeEvidence(join(args.iterationDir, "machine_gate.json"))}`,
    `- Git evidence/diff: ${relativeEvidence(join(args.iterationDir, "git-evidence.json"))}`,
    `- raw prompts and NDJSON logs: ${evidenceDir}/iterations/${String(
      args.state.iteration
    ).padStart(2, "0")}/`,
  ].join("\n");
  atomicWrite(join(args.runDir, "CHIEF_HANDOFF.md"), `${text}\n`);
}

function gateFailureSummary(gate: MachineGateResult): string {
  const failures = gate.commands.filter(
    (command) => command.exitCode !== 0 || command.timedOut
  );
  return failures.length
    ? failures
        .map(
          (command) =>
            `${command.command}: ${truncate(command.stderr || command.stdout || "(no output)", 700)}`
        )
        .join("\n")
    : "无";
}

function truncate(text: string, max: number): string {
  const normalized = text.replaceAll("\0", "").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

type AgentStageResult = {
  text: string;
  meta: StageMeta;
  error?: string;
};

function appendHistoryEntry(
  history: HistoryWriter,
  workspaceDir: string,
  iteration: number,
  stage: string,
  startedAt: number,
  result: AgentStageResult,
  logPath: string
): void {
  history.appendEntry({
    iteration,
    stage,
    status: result.error ? "failed" : "ok",
    durationMs: Math.max(0, Date.now() - startedAt),
    head: headShort(workspaceDir),
    logPath: relative(workspaceDir, logPath),
    body: result.error || result.text || "(empty agent output)",
    meta: result.meta,
    dirty: dirtySnapshot(workspaceDir),
  });
}

function appendGateHistory(
  history: HistoryWriter,
  workspaceDir: string,
  iteration: number,
  stage: string,
  gate: MachineGateResult,
  logPath: string
): void {
  history.appendEntry({
    iteration,
    stage,
    status: gate.passed ? "ok" : "failed",
    durationMs: gate.commands.reduce(
      (total, command) => total + command.durationMs,
      0
    ),
    head: headShort(workspaceDir),
    logPath: relative(workspaceDir, logPath),
    body: JSON.stringify(gate, null, 2),
    dirty: dirtySnapshot(workspaceDir),
  });
}

function protocolExample(verdict: string): string {
  return JSON.stringify({
    verdict,
    summary: "",
    reasoning_summary: "",
    worker_task: verdict === "RETURN" ? "" : "",
    human_question: "",
    human_options: [],
    risk: "",
    next_step: "",
  });
}

function createDockerRunner(
  options: ChiefLoopOptions,
  runDir: string
): ChiefAgentRunner {
  let imageReady: Promise<void> | undefined;
  return async (stage, prompt, iteration, runOptions = {}) => {
    imageReady ??= Promise.resolve(ensureImage(options.ralphDir) as void);
    await imageReady;
    return runStage(
      stage,
      prompt,
      options.workspaceDir,
      iteration,
      undefined,
      join(
        runDir,
        "iterations",
        String(Math.max(iteration, 0)).padStart(2, "0"),
        `${stage.name}.ndjson`
      ),
      {
        ...runOptions,
        agent: stage.agent,
        model: stage.model,
        reasoningEffort: stage.reasoningEffort,
        skillsHostDir: join(options.packageDir, "templates", "skills"),
      }
    );
  };
}

function tokenCount(meta: StageMeta): number {
  return (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0);
}
function addTokens(
  state: ChiefRunState,
  meta: StageMeta,
  config: ChiefLoopConfig
): boolean {
  state.totalTokens += tokenCount(meta);
  return (
    config.maxTotalTokens !== undefined &&
    state.totalTokens >= config.maxTotalTokens
  );
}
function hasDirtyPattern(paths: string[], patterns: string[]): boolean {
  return paths.some((path) =>
    patterns.some((raw) => {
      const pattern = raw.replaceAll("\\", "/").replace(/\/$/, "");
      const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
        .join(".*");
      return (
        new RegExp(`^(?:${escaped})(?:/|$)`).test(path) ||
        new RegExp(`(?:^|/)${escaped}$`).test(path)
      );
    })
  );
}
function formatViolations(
  violations: { kind: string; path: string }[]
): string {
  return violations.map((item) => `${item.kind}:${item.path}`).join(", ");
}
function writeRepoEvidence(
  dir: string,
  snapshot: RepoSnapshot,
  changedPaths: string[]
): void {
  atomicWrite(
    join(dir, "git-evidence.json"),
    `${JSON.stringify(
      {
        branch: snapshot.branch,
        head: snapshot.head,
        status: snapshot.status,
        diffStat: snapshot.diffStat,
        diff: snapshot.diff,
        changedPaths,
        files: [...snapshot.files.keys()],
      },
      null,
      2
    )}\n`
  );
}
function finish(
  state: ChiefRunState,
  runDir: string,
  status: ChiefRunStatus,
  reason: string,
  card: (
    machine: string,
    chief: string,
    risk: string,
    need: string,
    next: string
  ) => void,
  next: string
): ChiefRunResult {
  state.status = status;
  state.reason = reason;
  persistState(state, runDir);
  card(status, reason, "", "", next);
  return { runDir, state };
}
function human(
  state: ChiefRunState,
  runDir: string,
  decision: ChiefDecision,
  card: (
    machine: string,
    chief: string,
    risk: string,
    need: string,
    next: string
  ) => void
): ChiefRunResult {
  state.status = "HUMAN_REQUIRED";
  state.reason = decision.human_question;
  persistState(state, runDir);
  atomicWrite(
    join(runDir, "human-decision.md"),
    [
      `【需要你拍板】`,
      ``,
      `问题：${decision.human_question}`,
      `证据：请查看 ${
        state.iteration === 0
          ? "planning-output.json"
          : `iterations/${String(state.iteration).padStart(2, "0")}/`
      }`,
      `GPT 总工判断：${decision.summary}`,
      `推荐：${decision.next_step}`,
      `选项：`,
      ...decision.human_options
        .slice(0, 2)
        .map((option, index) => `${String.fromCharCode(65 + index)} ${option}`),
      `C 查看更多证据`,
    ].join("\n") + "\n"
  );
  card(
    "已暂停",
    decision.summary,
    decision.risk,
    decision.human_question,
    "等待你的业务决策"
  );
  return { runDir, state };
}
function persistState(state: ChiefRunState, runDir: string): void {
  mkdirSync(runDir, { recursive: true });
  atomicWrite(
    join(runDir, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`
  );
}
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
function timestamp(): string {
  return new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14);
}

export { loadChiefConfig };
