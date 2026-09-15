import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runV3BigLoop } from "../apps/cli/bin/ralph-chief-v3-loop.js";
import { loadExtensionEnv } from "../apps/cli/bin/ralph-gui-chief-bridge.js";

function harness(initial, maxIterations = 8) {
  let state = structuredClone(initial);
  const order = [];
  const phaseHandlers = {
    select: async () => order.push("select"),
    work: async () => order.push("work"),
    review: async () => order.push("review"),
  };
  return {
    order,
    get state() {
      return state;
    },
    setState(next) {
      state = structuredClone(next);
    },
    run(overrides = {}) {
      return runV3BigLoop({
        projectRoot: overrides.projectRoot ?? "/tmp/v3-loop-test",
        runId: "loop-test",
        config: { chief_mode: "external", max_iterations: maxIterations },
        loadState: async () => structuredClone(state),
        phaseHandlers,
        ...overrides,
      });
    },
    phaseHandlers,
  };
}

const running = (phase, round = 1, task = "task-a") => ({
  run_id: "loop-test",
  version: 1,
  phase,
  status: "running",
  round,
  current_task_id: task,
});

test("PASS flow routes Review PASS to the next SELECT", async () => {
  const h = harness(running("SELECT"));
  h.phaseHandlers.select = async () => {
    h.order.push("select");
    if (h.state.round === 1) h.setState(running("WORKER", 1));
    else h.setState({ ...running("DONE", 2, null), status: "done" });
  };
  h.phaseHandlers.work = async () => {
    h.order.push("work");
    h.setState(running("CHIEF_REVIEW", 1));
  };
  h.phaseHandlers.review = async () => {
    h.order.push("review");
    h.setState(running("SELECT", 2, null));
  };
  const result = await h.run();
  assert.equal(result.status, "TASK_PASS");
  assert.deepEqual(h.order, ["select", "work", "review", "select"]);
});

test("PATCH routes the same task directly back to Worker", async () => {
  const h = harness(running("CHIEF_REVIEW"));
  h.phaseHandlers.review = async () => {
    h.order.push("review");
    if (h.state.round === 1) h.setState(running("WORKER", 2));
    else h.setState({ ...running("DONE", 3, null), status: "done" });
  };
  h.phaseHandlers.work = async () => {
    h.order.push("work");
    h.setState(running("CHIEF_REVIEW", 2));
  };
  h.phaseHandlers.select = async () => {
    h.order.push("select");
    h.setState({ ...running("DONE", 3, null), status: "done" });
  };
  const result = await h.run();
  assert.equal(result.status, "TASK_PASS");
  assert.deepEqual(h.order, ["review", "work", "review"]);
  assert.equal(h.state.current_task_id, null);
});

test("HUMAN_REQUIRED stops without later handlers", async () => {
  const h = harness(running("CHIEF_REVIEW"));
  h.phaseHandlers.review = async () => {
    h.order.push("review");
    h.setState({ ...running("HUMAN_REQUIRED"), status: "paused" });
  };
  const result = await h.run();
  assert.equal(result.status, "HUMAN_REQUIRED");
  assert.deepEqual(h.order, ["review"]);
});

test("CHIEF_RECOVERY retries the same task without Human Touch", async () => {
  const h = harness(running("CHIEF_RECOVERY", 1));
  let recoveries = 0;
  h.phaseHandlers.recovery = async () => {
    recoveries += 1;
    h.order.push("recovery");
    h.setState(running("WORKER", 2, "task-a"));
  };
  h.phaseHandlers.work = async () => {
    h.order.push("work");
    h.setState(running("CHIEF_REVIEW", 2, "task-a"));
  };
  h.phaseHandlers.review = async () => {
    h.order.push("review");
    h.setState({ ...running("DONE", 2, null), status: "done" });
  };
  const result = await h.run();
  assert.equal(result.status, "TASK_PASS");
  assert.equal(recoveries, 1);
  assert.deepEqual(h.order, ["recovery", "work", "review"]);
});

test("Chief Recovery HUMAN_REQUIRED stops immediately", async () => {
  const h = harness(running("CHIEF_RECOVERY"));
  h.phaseHandlers.recovery = async () => {
    h.order.push("recovery");
    h.setState({ ...running("HUMAN_REQUIRED"), status: "paused" });
  };
  const result = await h.run();
  assert.equal(result.status, "HUMAN_REQUIRED");
  assert.deepEqual(h.order, ["recovery"]);
});

test("technical blocks recover through Worker, Gate, Checkpoint and Review", async () => {
  const h = harness(running("WORKER", 1));
  h.phaseHandlers.work = async () => {
    h.order.push(`work:${h.state.phase}`);
    if (h.state.phase === "WORKER" && h.state.round === 1)
      h.setState({ ...running("CHIEF_RECOVERY", 1, "task-a") });
    else if (h.state.phase === "WORKER")
      h.setState(running("MACHINE_GATE", 2, "task-a"));
    else if (h.state.phase === "MACHINE_GATE")
      h.setState(running("CHECKPOINT", 2, "task-a"));
    else h.setState(running("CHIEF_REVIEW", 2, "task-a"));
  };
  h.phaseHandlers.recovery = async () => {
    h.order.push("recovery");
    h.setState(running("WORKER", 2, "task-a"));
  };
  h.phaseHandlers.review = async () => {
    h.order.push("review");
    h.setState({ ...running("DONE", 2, null), status: "done" });
  };
  const result = await h.run();
  assert.equal(result.status, "TASK_PASS");
  assert.deepEqual(h.order, [
    "work:WORKER",
    "recovery",
    "work:WORKER",
    "work:MACHINE_GATE",
    "work:CHECKPOINT",
    "review",
  ]);
});

test("FAILED stops fail closed", async () => {
  const h = harness({ ...running("FAILED"), status: "failed" });
  const result = await h.run();
  assert.equal(result.status, "FAILED");
  assert.deepEqual(h.order, []);
});

test("WAITING SELECT and WAITING REVIEW reuse their existing route", async () => {
  for (const kind of ["select", "review"]) {
    const h = harness({
      ...running("WAITING_FOR_CHIEF"),
      status: "waiting",
      waiting_handoff: { kind },
    });
    h.phaseHandlers[kind] = async () => {
      h.order.push(kind);
      h.setState({ ...running("DONE", 1, null), status: "done" });
    };
    const result = await h.run();
    assert.equal(result.status, "TASK_PASS");
    assert.deepEqual(h.order, [kind]);
  }
});

test("transient Chief timeout retries inside one unattended invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-loop-retry-"));
  const h = harness(running("CHIEF_REVIEW"));
  let reviewCalls = 0;
  const sleeps = [];
  let clock = 0;
  h.phaseHandlers.review = async () => {
    reviewCalls += 1;
    h.order.push("review");
    if (reviewCalls === 1) {
      h.setState({
        ...running("WAITING_FOR_CHIEF"),
        status: "waiting",
        waiting_handoff: { kind: "review" },
      });
      const error = new Error("ASSISTANT_REPLY_TIMEOUT");
      error.code = "ASSISTANT_REPLY_TIMEOUT";
      throw error;
    }
    h.setState({ ...running("DONE", 1, null), status: "done" });
  };
  try {
    const result = await h.run({
      projectRoot: root,
      chiefRetryIntervalMs: 15,
      chiefWaitBudgetMs: 100,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });
    assert.equal(result.status, "TASK_PASS");
    assert.equal(reviewCalls, 2);
    assert.deepEqual(sleeps, [15]);
    assert.deepEqual(h.order, ["review", "review"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent Chief timeout stops only after automatic wait budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-loop-budget-"));
  const h = harness(running("CHIEF_REVIEW"));
  let reviewCalls = 0;
  const sleeps = [];
  let clock = 0;
  h.phaseHandlers.review = async () => {
    reviewCalls += 1;
    h.setState({
      ...running("WAITING_FOR_CHIEF"),
      status: "waiting",
      waiting_handoff: { kind: "review" },
    });
    const error = new Error("ASSISTANT_REPLY_TIMEOUT");
    error.code = "ASSISTANT_REPLY_TIMEOUT";
    throw error;
  };
  try {
    const result = await h.run({
      projectRoot: root,
      chiefRetryIntervalMs: 10,
      chiefWaitBudgetMs: 25,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });
    assert.equal(result.status, "WAITING_FOR_CHIEF");
    assert.equal(result.waitBudgetExhausted, true);
    assert.equal(result.runState.phase, "WAITING_FOR_CHIEF");
    assert.equal(result.runState.status, "waiting");
    assert.equal(result.chiefRetryCount, 3);
    assert.equal(reviewCalls, 4);
    assert.deepEqual(sleeps, [10, 10, 5]);
    const telemetry = JSON.parse(
      await readFile(
        join(root, ".ralph", "chief-runs", "loop-test", "telemetry.json"),
        "utf8"
      )
    );
    assert.equal(telemetry.chief_retry_count, 3);
    assert.equal(telemetry.chief_wait_budget_exhausted, true);
    assert.equal(telemetry.chief_last_error, "ASSISTANT_REPLY_TIMEOUT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("integration and final review are explicit boundaries", async () => {
  for (const phase of ["INTEGRATION_UAT", "FINAL_REVIEW"]) {
    const h = harness(running(phase));
    const result = await h.run();
    assert.equal(result.status, "NEXT_PHASE_REQUIRED");
    assert.equal(result.nextPhase, phase);
    assert.deepEqual(h.order, []);
  }
});

test("unknown waiting handoff fails closed", async () => {
  const h = harness({
    ...running("WAITING_FOR_CHIEF"),
    status: "waiting",
    waiting_handoff: { kind: "unknown" },
  });
  await assert.rejects(h.run(), /cannot route WAITING_FOR_CHIEF kind unknown/);
});

test("iteration limit stops resumably without marking FAILED", async () => {
  const h = harness(running("SELECT"), 1);
  h.phaseHandlers.select = async () => {
    h.order.push("select");
    h.setState(running("SELECT", 2));
  };
  const result = await h.run();
  assert.equal(result.status, "MAX_ITERATIONS_REACHED");
  assert.equal(result.runState.phase, "SELECT");
  assert.equal(result.runState.status, "running");
});

test("the outer loop does not acquire a competing global writer lock", async () => {
  const source = await readFile(
    new URL("../apps/cli/bin/ralph-chief-v3-loop.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /acquireActiveWriterLock/);
});

test("progress messages are user-facing Chinese while protocol phases stay stable", async () => {
  const h = harness(running("WORKER"));
  const messages = [];
  h.phaseHandlers.work = async () => {
    h.order.push("work");
    h.setState({ ...running("DONE", 1, null), status: "done" });
  };
  await h.run({ onProgress: ({ message }) => messages.push(message) });
  assert.deepEqual(messages, ["Luna Goal 正在施工"]);
});

test("configured extension token env is forwarded through the existing bridge loader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ralph-v3-loop-env-"));
  const path = join(dir, "env");
  const previous = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  try {
    await writeFile(path, "PLAYWRIGHT_MCP_EXTENSION_TOKEN=fixture-token\n", {
      mode: 0o600,
    });
    const env = loadExtensionEnv(path);
    assert.equal(env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, "fixture-token");
  } finally {
    if (previous === undefined)
      delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    else process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
