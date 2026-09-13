import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runChiefLoop, type ChiefLoopConfig } from "../chief-loop.js";
import type { MachineGateResult } from "../machine-gate.js";
import type { Stage } from "../stages.js";

const worker: Stage = {
  name: "worker",
  template: "worker.md",
  model: "worker-model",
};
const chief: Stage = {
  name: "chief",
  template: "chief.md",
  model: "chief-model",
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ralph-chief-loop-"));
  const workspaceDir = join(root, "workspace");
  const packageDir = join(root, "package");
  mkdirSync(join(packageDir, "templates"), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(packageDir, "templates", "worker.md"), "worker\n");
  writeFileSync(join(packageDir, "templates", "chief.md"), "chief\n");
  execFileSync("git", ["init", "-q"], { cwd: workspaceDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workspaceDir,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir });
  writeFileSync(join(workspaceDir, ".gitignore"), ".ralph/\n.ralph-tmp/\n");
  execFileSync("git", ["add", "."], { cwd: workspaceDir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: workspaceDir });
  return { root, workspaceDir, packageDir, ralphDir: join(root, "ralph") };
}

function writeChange(workspaceDir: string, name: string): void {
  writeFileSync(join(workspaceDir, name), "worker change\n");
}

function decision(
  verdict: string,
  worker_task = "",
  human_question = ""
): string {
  return JSON.stringify({
    verdict,
    summary: verdict,
    reasoning_summary: "evidence",
    worker_task,
    human_question,
    human_options: [],
    risk: "low",
    next_step: "continue",
  });
}

function externalVerdict(
  verdict: string,
  worker_task = "",
  human_question = "",
  metadata: {
    runId: string;
    iteration: number;
    handoffHash: string;
    previousGate?: MachineGateResult;
  } = {
    runId: "run-1",
    iteration: 1,
    handoffHash: "a".repeat(64),
  }
): string {
  const value: Record<string, unknown> = {
    verdict,
    summary: verdict,
    worker_task,
    human_question,
    human_options: [],
    next_step: "continue",
    run_id: metadata.runId,
    iteration: metadata.iteration,
    handoff_hash: metadata.handoffHash,
  };
  if (verdict === "PASS")
    value.previousGate = metadata.previousGate ?? gate(true);
  return JSON.stringify(value);
}

function boundExternalVerdict(
  state: {
    runId: string;
    iteration: number;
    handoff?: { handoffHash: string };
    previousGate?: MachineGateResult;
  },
  verdict: string,
  workerTask = "",
  humanQuestion = ""
): string {
  if (!state.handoff) throw new Error("test run did not produce a handoff");
  return externalVerdict(verdict, workerTask, humanQuestion, {
    runId: state.runId,
    iteration: state.iteration,
    handoffHash: state.handoff.handoffHash,
    previousGate: state.previousGate,
  });
}

function baseConfig(overrides: Partial<ChiefLoopConfig> = {}): ChiefLoopConfig {
  return {
    task: "implement task",
    maxIterations: 6,
    worker: { model: "worker-model" },
    chief: { model: "chief-model" },
    ...overrides,
  };
}

function gate(passed: boolean): MachineGateResult {
  return {
    passed,
    commands: [
      {
        command: "fake",
        kind: "required",
        exitCode: passed ? 0 : 1,
        stdout: passed ? "" : "gate error",
        stderr: passed ? "" : "failure",
        durationMs: 1,
        timedOut: false,
      },
    ],
  };
}

function run(
  dirs: ReturnType<typeof setup>,
  config: ChiefLoopConfig,
  runAgent: (
    stage: Stage,
    prompt: string,
    iteration: number
  ) => Promise<{ text: string; meta: Record<string, number> }>,
  runGate: (workspace: string) => Promise<MachineGateResult>
) {
  return runChiefLoop({
    ...dirs,
    config,
    workerStage: worker,
    chiefStage: chief,
    runAgent,
    runGate,
  });
}

describe("Chief/Worker state machine", () => {
  it("runs Worker → Gate PASS → Chief PASS", async () => {
    const dirs = setup();
    const models: string[] = [];
    const result = await run(
      dirs,
      baseConfig({ maxIterations: 1 }),
      async (stage, _prompt, iteration, options) => {
        if (iteration === 0)
          return { text: decision("PASS", "implement"), meta: {} };
        models.push(options?.model ?? stage.model!);
        if (stage.name === "worker") writeChange(dirs.workspaceDir, "work.txt");
        return {
          text: stage.name === "chief" ? decision("PASS") : "done",
          meta: {},
        };
      },
      async () => gate(true)
    );
    expect(result.state.status).toBe("PASS");
    expect(models).toEqual(["worker-model", "chief-model"]);
  });

  it("returns Gate FAIL context to the next Worker iteration", async () => {
    const dirs = setup();
    const prompts: string[] = [];
    let workerRuns = 0;
    let gateCalls = 0;
    let chiefRuns = 0;
    const result = await run(
      dirs,
      baseConfig({ maxIterations: 2 }),
      async (stage, prompt, iteration) => {
        prompts.push(prompt);
        if (iteration === 0)
          return { text: decision("PASS", "implement"), meta: {} };
        if (stage.name === "worker") {
          workerRuns += 1;
          writeChange(dirs.workspaceDir, `work-${workerRuns}.txt`);
        } else chiefRuns += 1;
        return {
          text:
            stage.name === "chief"
              ? chiefRuns === 1
                ? decision("RETURN", "fix the gate failure")
                : decision("PASS")
              : "done",
          meta: {},
        };
      },
      async () => gate(++gateCalls > 1)
    );
    expect(result.state.status).toBe("PASS");
    expect(workerRuns).toBe(2);
    expect(prompts.some((prompt) => prompt.includes("gate error"))).toBe(true);
  });

  it.each([
    ["RETURN", decision("RETURN", "revisit")],
    ["PATCH", decision("PATCH")],
  ])("reruns gate/review after %s", async (label, firstDecision) => {
    const dirs = setup();
    let workerRuns = 0;
    let chiefRuns = 0;
    const result = await run(
      dirs,
      baseConfig({ maxIterations: 2 }),
      async (stage, _prompt, iteration) => {
        if (iteration === 0)
          return { text: decision("PASS", "implement"), meta: {} };
        if (stage.name === "worker") {
          workerRuns += 1;
          writeChange(dirs.workspaceDir, `work-${workerRuns}.txt`);
        } else chiefRuns += 1;
        return {
          text:
            stage.name === "chief"
              ? chiefRuns === 1
                ? firstDecision
                : decision("PASS")
              : "done",
          meta: {},
        };
      },
      async () => gate(true)
    );
    expect(result.state.status).toBe("PASS");
    expect(chiefRuns).toBe(2);
    expect(workerRuns).toBe(label === "RETURN" ? 2 : 1);
  });

  it("never accepts a PASS from a Chief that changed the tree without a fresh review", async () => {
    const dirs = setup();
    let chiefRuns = 0;
    let gateCalls = 0;
    const result = await run(
      dirs,
      baseConfig({ maxIterations: 1 }),
      async (stage, _prompt, iteration) => {
        if (iteration === 0)
          return { text: decision("PASS", "implement"), meta: {} };
        if (stage.name === "worker") writeChange(dirs.workspaceDir, "work.txt");
        else {
          chiefRuns += 1;
          if (chiefRuns === 1)
            writeFileSync(
              join(dirs.workspaceDir, "chief-patch.txt"),
              "patch\n"
            );
        }
        return {
          text: stage.name === "chief" ? decision("PASS") : "done",
          meta: {},
        };
      },
      async () => {
        gateCalls += 1;
        return gate(true);
      }
    );
    expect(result.state.status).toBe("PASS");
    expect(chiefRuns).toBe(2);
    expect(gateCalls).toBe(2);
  });

  it("forces a fresh gate and review after a real Chief PATCH", async () => {
    const dirs = setup();
    let chiefRuns = 0;
    let gateCalls = 0;
    const result = await run(
      dirs,
      baseConfig({ maxIterations: 1 }),
      async (stage, _prompt, iteration) => {
        if (iteration === 0)
          return { text: decision("RETURN", "implement"), meta: {} };
        if (stage.name === "worker") writeChange(dirs.workspaceDir, "work.txt");
        else {
          chiefRuns += 1;
          if (chiefRuns === 1)
            writeFileSync(join(dirs.workspaceDir, "chief-fix.txt"), "fix\n");
        }
        return {
          text:
            stage.name === "chief"
              ? chiefRuns === 1
                ? decision("PATCH")
                : decision("PASS")
              : "done",
          meta: {},
        };
      },
      async () => {
        gateCalls += 1;
        return gate(true);
      }
    );
    expect(result.state.status).toBe("PASS");
    expect(chiefRuns).toBe(2);
    expect(gateCalls).toBe(2);
  });

  it("rejects an automatic Worker commit", async () => {
    const dirs = setup();
    const result = await run(
      dirs,
      baseConfig({ maxIterations: 1 }),
      async (stage, _prompt, iteration) => {
        if (iteration === 0)
          return { text: decision("PASS", "implement"), meta: {} };
        if (stage.name === "worker") {
          writeChange(dirs.workspaceDir, "committed.txt");
          execFileSync("git", ["add", "committed.txt"], {
            cwd: dirs.workspaceDir,
          });
          execFileSync("git", ["commit", "-qm", "agent commit"], {
            cwd: dirs.workspaceDir,
          });
        }
        return { text: "done", meta: {} };
      },
      async () => gate(true)
    );
    expect(result.state.status).toBe("FAILED");
    expect(result.state.reason).toContain("Git commit");
  });

  it("stops and persists a HUMAN_REQUIRED decision", async () => {
    const dirs = setup();
    const result = await run(
      dirs,
      baseConfig(),
      async (stage, _prompt, iteration) => {
        if (iteration === 0)
          return { text: decision("PASS", "implement"), meta: {} };
        if (stage.name === "worker") writeChange(dirs.workspaceDir, "work.txt");
        return {
          text:
            stage.name === "chief"
              ? decision("HUMAN_REQUIRED", "", "Choose policy")
              : "done",
          meta: {},
        };
      },
      async () => gate(true)
    );
    expect(result.state.status).toBe("HUMAN_REQUIRED");
    expect(result.state.reason).toBe("Choose policy");
  });

  it("stops at max_iterations", async () => {
    const dirs = setup();
    const result = await run(
      dirs,
      baseConfig({ maxIterations: 2 }),
      async (stage, _prompt, iteration) => {
        if (stage.name === "worker")
          writeChange(dirs.workspaceDir, `work-${iteration}.txt`);
        return {
          text: stage.name === "chief" ? decision("RETURN", "again") : "done",
          meta: {},
        };
      },
      async () => gate(true)
    );
    expect(result.state.status).toBe("MAX_ITERATIONS");
  });

  it("stops when aggregate token budget is exhausted", async () => {
    const dirs = setup();
    const result = await run(
      dirs,
      baseConfig({ maxIterations: 4, maxTotalTokens: 10 }),
      async (stage, _prompt, iteration) => {
        if (iteration === 0)
          return {
            text: decision("PASS", "implement"),
            meta: { inputTokens: 3, outputTokens: 3 },
          };
        if (stage.name === "worker") writeChange(dirs.workspaceDir, "work.txt");
        return {
          text: stage.name === "chief" ? decision("PASS") : "done",
          meta: { inputTokens: 3, outputTokens: 3 },
        };
      },
      async () => gate(true)
    );
    expect(result.state.status).toBe("TOKEN_BUDGET_EXCEEDED");
  });

  it("detects Worker edits to ACCEPTANCE/CHIEF/DECISIONS", async () => {
    const dirs = setup();
    for (const name of ["ACCEPTANCE.md", "CHIEF.md", "DECISIONS.md"])
      writeFileSync(join(dirs.workspaceDir, name), "original\n");
    const result = await run(
      dirs,
      baseConfig({
        protectedPaths: ["ACCEPTANCE.md", "CHIEF.md", "DECISIONS.md"],
      }),
      async (stage, _prompt, iteration) => {
        if (iteration === 0)
          return { text: decision("PASS", "implement"), meta: {} };
        if (stage.name === "worker")
          writeFileSync(join(dirs.workspaceDir, "CHIEF.md"), "tampered\n");
        return { text: "done", meta: {} };
      },
      async () => gate(true)
    );
    expect(result.state.status).toBe("FAILED");
    expect(result.state.reason).toContain("CHIEF.md");
  });
});

describe("external Chief mode", () => {
  it("automatically resumes through a configured external GUI bridge", async () => {
    const dirs = setup();
    const calls: string[] = [];
    let bridgeCalls = 0;
    const result = await runChiefLoop({
      ...dirs,
      config: baseConfig({
        chiefMode: "external",
        maxIterations: 1,
        guiBridge: {
          enabled: true,
          conversation_url: "https://chatgpt.com/c/fixed-chief",
        },
      }),
      runAgent: async (stage) => {
        calls.push(stage.name);
        if (stage.name !== "worker")
          throw new Error("GUI bridge must not call Chief");
        writeChange(dirs.workspaceDir, "gui-pass.txt");
        return { text: "worker done", meta: {} };
      },
      runGate: async () => gate(true),
      externalChiefBridge: async (context) => {
        bridgeCalls += 1;
        expect(readFileSync(context.handoffPath, "utf8")).toContain(
          "handoff_hash"
        );
        const verdictPath = join(context.runDir, "CHIEF_VERDICT.json");
        writeFileSync(verdictPath, boundExternalVerdict(context.state, "PASS"));
        return { verdictPath };
      },
    });
    expect(result.state.status).toBe("PASS");
    expect(bridgeCalls).toBe(2);
    expect(calls).toEqual(["worker"]);
  });

  it("routes external GUI PATCH back to Worker, Gate, and a new review", async () => {
    const dirs = setup();
    let bridgeCalls = 0;
    let workerRuns = 0;
    const result = await runChiefLoop({
      ...dirs,
      config: baseConfig({
        chiefMode: "external",
        maxIterations: 2,
        guiBridge: {
          enabled: true,
          conversation_url: "https://chatgpt.com/c/fixed-chief",
        },
      }),
      runAgent: async (stage, prompt) => {
        if (stage.name !== "worker")
          throw new Error("GUI bridge must not call Chief");
        workerRuns += 1;
        expect(prompt).toContain(
          workerRuns === 1 ? "implement task" : "small patch"
        );
        writeChange(dirs.workspaceDir, `gui-patch-${workerRuns}.txt`);
        return { text: "worker done", meta: {} };
      },
      runGate: async () => gate(true),
      externalChiefBridge: async (context) => {
        bridgeCalls += 1;
        const verdictPath = join(context.runDir, "CHIEF_VERDICT.json");
        writeFileSync(
          verdictPath,
          boundExternalVerdict(
            context.state,
            bridgeCalls === 1 ? "PATCH" : "PASS",
            bridgeCalls === 1 ? "small patch" : ""
          )
        );
        return { verdictPath };
      },
    });
    expect(result.state.status).toBe("PASS");
    expect(bridgeCalls).toBe(2);
    expect(workerRuns).toBe(1);
  });

  it("stays WAITING and records a GUI bridge failure without fallback", async () => {
    const dirs = setup();
    let calls = 0;
    const result = await runChiefLoop({
      ...dirs,
      config: baseConfig({
        chiefMode: "external",
        maxIterations: 1,
        guiBridge: {
          enabled: true,
          conversation_url: "https://chatgpt.com/c/fixed-chief",
        },
      }),
      runAgent: async (stage) => {
        calls += 1;
        if (stage.name !== "worker") throw new Error("no local Chief fallback");
        writeChange(dirs.workspaceDir, "gui-failure.txt");
        return { text: "worker done", meta: {} };
      },
      runGate: async () => gate(true),
      externalChiefBridge: async () => ({ error: "CONVERSATION_NOT_FOUND" }),
    });
    expect(result.state.status).toBe("WAITING_FOR_CHIEF");
    expect(result.state.reason).toContain("GUI Bridge failed closed");
    expect(calls).toBe(0);
    expect(
      readFileSync(join(result.runDir, "gui-bridge-error.json"), "utf8")
    ).toContain("CONVERSATION_NOT_FOUND");
  });

  it("runs Worker and Gate once, then waits without a Chief call", async () => {
    const dirs = setup();
    const calls: string[] = [];
    const result = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 1 }),
      async (stage) => {
        calls.push(stage.name);
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "external-work.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(true)
    );
    expect(result.state.status).toBe("WAITING_FOR_CHIEF");
    expect(calls).toEqual(["worker"]);
    const statusCard = readFileSync(
      join(result.runDir, "status-card.md"),
      "utf8"
    );
    expect(statusCard).toContain("【等待总工】");
    expect(statusCard).toContain("Handoff：");
    const handoff = readFileSync(
      join(result.runDir, "CHIEF_HANDOFF.md"),
      "utf8"
    );
    expect(handoff).toContain("【当前目标】");
    expect(handoff).toContain("【Machine Gate】");
    expect(handoff).toContain("external-work.txt");
  });

  it("embeds a bounded worker evidence summary in the external handoff", async () => {
    const dirs = setup();
    const workerEvidence = [
      "UAT_EVIDENCE_BEGIN",
      "Golden baseline: golden-payroll.xlsx sha256=abc123",
      "关键规则：AD = AA + AC",
      "关键数值：刘文剑 AC=68.77；范仙阳 AA=105.30",
      "公式：AA/AD/AF/AK/AV 已复开验证",
      "Machine Gate: 280 passed",
      "新输出文件：工资表 (8).xlsx",
      "reopen/formula verify: PASS",
      "old UAT regression: none",
      "remaining unknowns: none",
      "UAT_EVIDENCE_END",
    ].join("\n");
    const result = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 1 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "evidence.txt");
        return { text: workerEvidence, meta: {} };
      },
      async () => gate(true)
    );
    expect(result.state.status).toBe("WAITING_FOR_CHIEF");
    const handoff = readFileSync(
      join(result.runDir, "CHIEF_HANDOFF.md"),
      "utf8"
    );
    expect(handoff).toContain(
      "Golden baseline: golden-payroll.xlsx sha256=abc123"
    );
    expect(handoff).toContain("关键数值：刘文剑 AC=68.77；范仙阳 AA=105.30");
    expect(handoff).toContain("新输出文件：工资表 (8).xlsx");
    expect(handoff).toContain("old UAT regression: none");
    expect(handoff).toContain("Worker output:");
    expect(handoff.length).toBeLessThan(8_500);
  });

  it("stops at WAITING_FOR_CHIEF after a Gate failure without retrying Worker", async () => {
    const dirs = setup();
    const calls: string[] = [];
    let workerRuns = 0;
    const result = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 4 }),
      async (stage) => {
        calls.push(stage.name);
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        workerRuns += 1;
        writeChange(dirs.workspaceDir, "external-failure.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(false)
    );
    expect(result.state.status).toBe("WAITING_FOR_CHIEF");
    expect(workerRuns).toBe(1);
    expect(calls).toEqual(["worker"]);
  });

  it("rejects external PASS when the authoritative Gate failed", async () => {
    const dirs = setup();
    const first = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 1 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "external-gate-fail.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(false)
    );
    writeFileSync(
      join(first.runDir, "CHIEF_VERDICT.json"),
      externalVerdict("PASS", "", "", {
        runId: first.state.runId,
        iteration: first.state.iteration,
        handoffHash: first.state.handoff!.handoffHash,
        previousGate: gate(true),
      })
    );
    let calls = 0;
    const resumed = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 1 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        calls += 1;
        throw new Error("no agent should run");
      },
      runGate: async () => gate(true),
    });
    expect(resumed.state.status).toBe("FAILED");
    expect(resumed.state.reason).toContain("previousGate");
    expect(calls).toBe(0);
  });

  it("rejects a verdict from an older iteration", async () => {
    const dirs = setup();
    const first = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 1 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "old-iteration.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(true)
    );
    writeFileSync(
      join(first.runDir, "CHIEF_VERDICT.json"),
      externalVerdict("RETURN", "retry", "", {
        runId: first.state.runId,
        iteration: first.state.iteration + 1,
        handoffHash: first.state.handoff!.handoffHash,
      })
    );
    const resumed = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 1 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        throw new Error("no agent should run");
      },
      runGate: async () => gate(true),
    });
    expect(resumed.state.status).toBe("FAILED");
    expect(resumed.state.reason).toContain("iteration");
  });

  it("rejects a verdict belonging to another run", async () => {
    const dirs = setup();
    const first = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 1 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "other-run.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(true)
    );
    writeFileSync(
      join(first.runDir, "CHIEF_VERDICT.json"),
      externalVerdict("RETURN", "retry", "", {
        runId: "another-run",
        iteration: first.state.iteration,
        handoffHash: first.state.handoff!.handoffHash,
      })
    );
    const resumed = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 1 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        throw new Error("no agent should run");
      },
      runGate: async () => gate(true),
    });
    expect(resumed.state.status).toBe("FAILED");
    expect(resumed.state.reason).toContain("run_id");
  });

  it("resumes RETURN with a Worker task and waits again", async () => {
    const dirs = setup();
    const first = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 2 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "external-round-1.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(true)
    );
    writeFileSync(
      join(first.runDir, "CHIEF_VERDICT.json"),
      boundExternalVerdict(
        first.state,
        "RETURN",
        "fix the external gate finding"
      )
    );
    const calls: string[] = [];
    const resumed = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 2 }),
      resumeRunId: first.state.runId,
      runAgent: async (stage, prompt) => {
        calls.push(`${stage.name}:${prompt}`);
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "external-round-2.txt");
        return { text: "worker done", meta: {} };
      },
      runGate: async () => gate(true),
    });
    expect(resumed.state.status).toBe("WAITING_FOR_CHIEF");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("fix the external gate finding");

    writeFileSync(
      join(resumed.runDir, "CHIEF_VERDICT.json"),
      boundExternalVerdict(resumed.state, "PASS")
    );
    const completed = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 2 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        throw new Error("PASS after the second WAIT must not call Worker");
      },
      runGate: async () => gate(true),
    });
    expect(completed.state.status).toBe("PASS");
  });

  it("resumes PASS without calling Worker or Chief", async () => {
    const dirs = setup();
    const first = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 1 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "external-pass.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(true)
    );
    writeFileSync(
      join(first.runDir, "CHIEF_VERDICT.json"),
      boundExternalVerdict(first.state, "PASS")
    );
    let calls = 0;
    const resumed = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 1 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        calls += 1;
        throw new Error("no agent should run after external PASS");
      },
      runGate: async () => gate(true),
    });
    expect(resumed.state.status).toBe("PASS");
    expect(calls).toBe(0);
    const consumedDir = join(first.runDir, "consumed");
    const consumed = readdirSync(consumedDir);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toContain(`iter-${first.state.iteration}.`);
    expect(readFileSync(join(consumedDir, consumed[0]), "utf8")).toContain(
      '"verdict":"PASS"'
    );
  });

  it("does not apply the same external verdict twice", async () => {
    const dirs = setup();
    const first = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 2 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "one-time-1.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(true)
    );
    const verdictPath = join(first.runDir, "CHIEF_VERDICT.json");
    writeFileSync(
      verdictPath,
      boundExternalVerdict(first.state, "RETURN", "one more pass")
    );
    const resumed = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 2 }),
      resumeRunId: first.state.runId,
      runAgent: async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "one-time-2.txt");
        return { text: "worker done", meta: {} };
      },
      runGate: async () => gate(true),
    });
    expect(resumed.state.status).toBe("WAITING_FOR_CHIEF");
    const second = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 2 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        throw new Error("consumed verdict must not call Worker");
      },
      runGate: async () => gate(true),
    });
    expect(second.state.status).toBe("FAILED");
    expect(second.state.reason).toContain("not found");
  });

  it("rejects re-consuming the same verdict for the same iteration", async () => {
    const dirs = setup();
    const first = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 1 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "duplicate-verdict.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(true)
    );
    const statePath = join(first.runDir, "state.json");
    const handoffPath = join(first.runDir, "CHIEF_HANDOFF.md");
    const waitingState = readFileSync(statePath, "utf8");
    const waitingHandoff = readFileSync(handoffPath, "utf8");
    const verdict = boundExternalVerdict(first.state, "RETURN", "retry once");
    writeFileSync(join(first.runDir, "CHIEF_VERDICT.json"), verdict);

    await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 1 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        throw new Error("simulate a process failure after consumption");
      },
      runGate: async () => gate(true),
    });
    writeFileSync(statePath, waitingState);
    writeFileSync(handoffPath, waitingHandoff);
    writeFileSync(join(first.runDir, "CHIEF_VERDICT.json"), verdict);

    let calls = 0;
    const duplicate = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 1 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        calls += 1;
        throw new Error("duplicate verdict must stop before Worker");
      },
      runGate: async () => gate(true),
    });
    expect(duplicate.state.status).toBe("FAILED");
    expect(duplicate.state.reason).toContain("already consumed");
    expect(calls).toBe(0);
  });

  it("rejects an external verdict after the waiting workspace changes", async () => {
    const dirs = setup();
    const first = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 1 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "fingerprint.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(true)
    );
    writeFileSync(join(dirs.workspaceDir, "after-waiting.txt"), "changed\n");
    writeFileSync(
      join(first.runDir, "CHIEF_VERDICT.json"),
      boundExternalVerdict(first.state, "RETURN", "retry after audit")
    );
    let calls = 0;
    const resumed = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 1 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        calls += 1;
        throw new Error("workspace mismatch must stop before Worker");
      },
      runGate: async () => gate(true),
    });
    expect(resumed.state.status).toBe("FAILED");
    expect(resumed.state.reason).toContain("workspace changed");
    expect(calls).toBe(0);
  });

  it("maps external HUMAN_REQUIRED to the existing human pause", async () => {
    const dirs = setup();
    const first = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 1 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "external-human.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(true)
    );
    writeFileSync(
      join(first.runDir, "CHIEF_VERDICT.json"),
      boundExternalVerdict(
        first.state,
        "HUMAN_REQUIRED",
        "",
        "Choose the policy"
      )
    );
    const resumed = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 1 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        throw new Error("no agent should run for HUMAN_REQUIRED");
      },
      runGate: async () => gate(true),
    });
    expect(resumed.state.status).toBe("HUMAN_REQUIRED");
    expect(
      readFileSync(join(first.runDir, "human-decision.md"), "utf8")
    ).toContain("C 查看更多证据");
  });

  it("fails explicitly on an invalid external verdict without fallback", async () => {
    const dirs = setup();
    const first = await run(
      dirs,
      baseConfig({ chiefMode: "external", maxIterations: 1 }),
      async (stage) => {
        if (stage.name !== "worker") throw new Error("unexpected Chief call");
        writeChange(dirs.workspaceDir, "external-invalid.txt");
        return { text: "worker done", meta: {} };
      },
      async () => gate(true)
    );
    writeFileSync(
      join(first.runDir, "CHIEF_VERDICT.json"),
      '{"verdict":"PASS"}'
    );
    let calls = 0;
    const resumed = await runChiefLoop({
      ...dirs,
      config: baseConfig({ chiefMode: "external", maxIterations: 1 }),
      resumeRunId: first.state.runId,
      runAgent: async () => {
        calls += 1;
        throw new Error("external mode must not fallback to Codex Chief");
      },
      runGate: async () => gate(true),
    });
    expect(resumed.state.status).toBe("FAILED");
    expect(resumed.state.reason).toContain("not valid external Chief JSON");
    expect(calls).toBe(0);
  });
});
