import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runChiefLoop, type ChiefLoopConfig } from "../chief-loop.js";
import type { MachineGateResult } from "../machine-gate.js";
import type { Stage } from "../stages.js";

const worker: Stage = { name: "worker", template: "worker.md", model: "luna" };
const chief: Stage = { name: "chief", template: "chief.md", model: "sol" };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ralph-chief-v2-"));
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
  writeFileSync(join(workspaceDir, ".gitignore"), ".ralph/\n");
  execFileSync("git", ["add", "."], { cwd: workspaceDir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: workspaceDir });
  return { root, workspaceDir, packageDir, ralphDir: join(root, "ralph") };
}

const gate = (passed: boolean): MachineGateResult => ({
  passed,
  commands: [
    {
      command: "fake",
      kind: "required",
      exitCode: passed ? 0 : 1,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    },
  ],
});

function plan(state: any, action: string, task = "implement next") {
  return JSON.stringify({
    action,
    task_title: action,
    why_now: "evidence makes this the highest value next step",
    evidence: "machine gate and repository state",
    why_not_other_tasks: "lower priority",
    worker_task: task,
    do_not_do: "do not change controls",
    acceptance: "gate passes",
    risk: "low",
    uat_decision: "not yet",
    run_id: state.runId,
    iteration: state.iteration,
    handoff_hash: state.handoff.handoffHash,
  });
}

function verdict(state: any, value: string) {
  return JSON.stringify({
    verdict: value,
    summary: value,
    worker_task: value === "RETURN" ? "fix next" : "",
    human_question: "",
    human_options: [],
    next_step: "continue",
    run_id: state.runId,
    iteration: state.iteration,
    handoff_hash: state.handoff.handoffHash,
    ...(value === "PASS" ? { previousGate: gate(true) } : {}),
  });
}

describe("Chief V2 planning loop", () => {
  it("plans before Worker and plans again after review PASS, persisting artifacts", async () => {
    const dirs = setup();
    let planCalls = 0;
    let reviewCalls = 0;
    let workers = 0;
    const result = await runChiefLoop({
      ...dirs,
      config: {
        task: "v2 task",
        chiefMode: "external",
        maxIterations: 2,
        guiBridge: {
          enabled: true,
          conversation_url: "https://chatgpt.com/c/test",
        },
      } satisfies ChiefLoopConfig,
      workerStage: worker,
      chiefStage: chief,
      runAgent: async (stage) => {
        if (stage.name !== "worker")
          throw new Error("local Chief must not run");
        workers += 1;
        writeFileSync(join(dirs.workspaceDir, `work-${workers}.txt`), "ok\n");
        return { text: "worker", meta: {} };
      },
      runGate: async () => gate(true),
      externalChiefBridge: async (context) => {
        const path = join(
          context.runDir,
          context.phase === "planning"
            ? "CHIEF_PLAN.json"
            : "CHIEF_VERDICT.json"
        );
        const body =
          context.phase === "planning"
            ? plan(
                context.state,
                planCalls++ === 0
                  ? "CONTINUE_DEVELOPMENT"
                  : "STOP_NO_HIGH_VALUE_WORK"
              )
            : verdict(context.state, reviewCalls++ === 0 ? "PASS" : "PASS");
        writeFileSync(path, body);
        return { verdictPath: path };
      },
    });
    expect(result.state.status).toBe("STOPPED");
    expect(workers).toBe(1);
    expect(planCalls).toBe(2);
    expect(reviewCalls).toBe(1);
    expect(
      readFileSync(
        join(result.runDir, "iterations", "00", "chief_plan.md"),
        "utf8"
      )
    ).toContain("ACTION = CONTINUE_DEVELOPMENT");
    expect(
      readFileSync(
        join(result.runDir, "iterations", "01", "chief_plan.md"),
        "utf8"
      )
    ).toContain("ACTION = STOP_NO_HIGH_VALUE_WORK");
    expect(
      readFileSync(
        join(result.runDir, "iterations", "01", "worker_prompt.md"),
        "utf8"
      )
    ).toContain("implement next");
  });
});
