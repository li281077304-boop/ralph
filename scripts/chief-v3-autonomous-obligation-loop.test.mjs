import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/*
 * Contract tests for the autonomous-obligation controller.  The controller is
 * intentionally exercised with an in-memory durable-store and phase fakes:
 * no payroll/dashboard fixture, network, Docker daemon, or app-server is
 * involved here.
 *
 * Expected public API:
 *   runAutonomousObligationLoop({ projectRoot, runId, loadState, saveState,
 *     handlers, now, sleep, signal })
 *
 * `handlers` receives the selected obligation and returns a durable event
 * (WORK_COMPLETE, TECHNICAL_FAILURE, HUMAN_BLOCK, GATE_PASS, or GATE_FAIL).
 * The result exposes `{ status, state, telemetry }`.  This deliberately
 * small seam keeps scheduler/recovery policy deterministic and independently
 * testable while the production handlers retain ownership of Git, Goal, Gate,
 * and host-Chief I/O.
 */

const NOW = "2026-09-15T00:00:00.000Z";

function obligation(id, status = "RUNNABLE", extra = {}) {
  return {
    id,
    title: id,
    status,
    attempts: 0,
    failure_signatures: [],
    ...extra,
  };
}

function state(obligations, extra = {}) {
  return {
    version: 1,
    run_id: "autonomous-test",
    phase: "SELECT",
    status: "running",
    round: 1,
    obligations,
    human_backlog: [],
    ...extra,
  };
}
function retryDecision() {
  return {
    action: "RETRY_WORKER",
    summary: "retry with a fresh technical route",
    technical_diagnosis: "the previous attempt failed",
    worker_task: "apply the alternate implementation",
    verification_strategy: ["run the deterministic gate"],
    why_previous_approach_failed: "the first route failed",
    why_next_approach_should_work: "the alternate route addresses the failure",
  };
}

async function controller() {
  const api = await import("../packages/core/dist/index.js");
  assert.equal(
    typeof api.runAutonomousObligationLoop,
    "function",
    "@daonhan/ralph-core must export runAutonomousObligationLoop"
  );
  return api.runAutonomousObligationLoop;
}

async function scenario(initial, handlers, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-autonomous-test-"));
  let durable = structuredClone(initial);
  const saves = [];
  const progress = [];
  let tick = 0;
  try {
    const run = await controller();
    const outcome = await run({
      projectRoot: root,
      runId: "autonomous-test",
      loadState: async () => structuredClone(durable),
      saveState: async (next) => {
        durable = structuredClone(next);
        saves.push(structuredClone(next));
      },
      handlers,
      now: () => NOW,
      sleep: async (ms) => {
        tick += ms;
      },
      onProgress: (event) => progress.push(event),
      ...options,
    });
    return { outcome, durable, saves, progress, sleptMs: tick };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("deterministic state machine selects runnable obligations by stable order", async () => {
  const calls = [];
  const result = await scenario(state([obligation("b"), obligation("a")]), {
    worker: async (item) => {
      calls.push(item.id);
      return { type: "WORK_COMPLETE" };
    },
    gate: async () => ({ type: "GATE_PASS" }),
  });
  assert.equal(result.outcome.status, "DONE");
  assert.deepEqual(calls, ["a", "b"]);
  assert.equal(result.durable.phase, "DONE");
  assert.ok(result.saves.length >= 2, "every transition is durable");
});

test("technical failure takes fresh Chief Recovery then retries the same obligation", async () => {
  const calls = [];
  const result = await scenario(state([obligation("a")]), {
    worker: async (item) => {
      calls.push(`worker:${item.id}`);
      return calls.length === 1
        ? { type: "TECHNICAL_FAILURE", signature: "test:missing-command" }
        : { type: "WORK_COMPLETE" };
    },
    chiefRecovery: async (item, context) => {
      calls.push(`recovery:${item.id}`);
      assert.equal(context.failureSignature, "test:missing-command");
      assert.equal(context.freshContext, true);
      return retryDecision();
    },
    gate: async () => ({ type: "GATE_PASS" }),
  });
  assert.equal(result.outcome.status, "DONE");
  assert.deepEqual(calls, ["worker:a", "recovery:a", "worker:a"]);
  assert.equal(result.outcome.telemetry.chief_recovery_count, 1);
  assert.equal(result.outcome.telemetry.recovery_success_count, 1);
});

test("Chief Recovery can route technical evidence directly to Machine Gate", async () => {
  const calls = [];
  const result = await scenario(state([obligation("a")]), {
    worker: async () => {
      calls.push("worker");
      return { type: "TECHNICAL_FAILURE", signature: "test:gate-ready" };
    },
    chiefRecovery: async () => ({
      action: "RUN_MACHINE_GATE",
      summary: "gate candidate",
      technical_diagnosis: "implementation exists",
    }),
    gate: async (item) => {
      calls.push(`gate:${item.id}`);
      return { type: "GATE_PASS" };
    },
  });
  assert.equal(result.outcome.status, "DONE");
  assert.deepEqual(calls, ["worker", "gate:a"]);
});

test("a human-blocked obligation enters backlog while independent work continues", async () => {
  const calls = [];
  const result = await scenario(
    state([obligation("human-first"), obligation("independent")]),
    {
      worker: async (item) => {
        calls.push(item.id);
        return item.id === "human-first"
          ? {
              type: "HUMAN_BLOCK",
              category: "EXTERNAL_AUTHORIZATION",
              message: "need owner approval",
            }
          : { type: "WORK_COMPLETE" };
      },
      gate: async () => ({ type: "GATE_PASS" }),
    }
  );
  assert.equal(result.outcome.status, "WAITING_FOR_HUMAN");
  assert.deepEqual(calls, ["human-first", "independent"]);
  assert.deepEqual(
    result.durable.human_backlog.map((item) => item.id),
    ["human-first"]
  );
  assert.equal(
    result.durable.obligations.find((item) => item.id === "independent").status,
    "PASS"
  );
});

test("WAITING_FOR_HUMAN is global only when no runnable or technical obligation remains", async () => {
  const result = await scenario(
    state([obligation("blocked", "HUMAN_BLOCKED")], {
      phase: "WAITING_FOR_HUMAN",
      status: "waiting",
      human_backlog: [{ id: "blocked", category: "EXTERNAL_AUTHORIZATION" }],
    }),
    { worker: async () => assert.fail("worker must not run") }
  );
  assert.equal(result.outcome.status, "WAITING_FOR_HUMAN");
  assert.equal(result.outcome.state.phase, "WAITING_FOR_HUMAN");
});

test("resolving the final human backlog item resumes it and reaches DONE", async () => {
  const calls = [];
  const result = await scenario(
    state([obligation("blocked", "HUMAN_BLOCKED")], {
      phase: "WAITING_FOR_HUMAN",
      status: "waiting",
      human_backlog: [
        { id: "blocked", category: "EXTERNAL_AUTHORIZATION", resolved: true },
      ],
    }),
    {
      worker: async (item) => {
        calls.push(item.id);
        return { type: "WORK_COMPLETE" };
      },
      gate: async () => ({ type: "GATE_PASS" }),
    }
  );
  assert.equal(result.outcome.status, "DONE");
  assert.deepEqual(calls, ["blocked"]);
  assert.equal(result.durable.human_backlog.length, 0);
});

test("malformed or mismatched Chief Recovery protocol fails closed without dispatching work", async () => {
  for (const decision of [
    { action: "RETRY_WORKER" },
    { action: "HUMAN_BLOCK", category: "NOT_ALLOWED" },
  ]) {
    const result = await scenario(state([obligation("a")]), {
      worker: async () => ({
        type: "TECHNICAL_FAILURE",
        signature: "test:protocol",
      }),
      chiefRecovery: async () => decision,
    });
    assert.equal(result.outcome.status, "FAILED");
    assert.match(
      result.outcome.state.failure_reason,
      /recovery|protocol|mismatch/i
    );
  }
});

test("repeated stable technical failure signature does not spin and becomes TECHNICAL_OPEN", async () => {
  let workerCalls = 0;
  const result = await scenario(
    state([obligation("a")]),
    {
      worker: async () => {
        workerCalls += 1;
        return { type: "TECHNICAL_FAILURE", signature: "test:repeatable" };
      },
      chiefRecovery: async () => retryDecision(),
    },
    { maxRepeatedFailureSignatures: 2 }
  );
  assert.equal(result.outcome.status, "TECHNICAL_OPEN");
  assert.equal(workerCalls, 2);
  assert.equal(result.durable.obligations[0].status, "TECHNICAL_OPEN");
  assert.deepEqual(result.durable.obligations[0].failure_signatures, [
    "test:repeatable",
  ]);
});

test("crash/restart preserves obligation identity and reconnect/liveness failures stay technical", async () => {
  const calls = [];
  const initial = state([
    obligation("a", "TECHNICAL_OPEN", {
      active_goal: { thread_id: "thread-1", objective_hash: "hash-a" },
      failure_signatures: ["transport:disconnected"],
    }),
  ]);
  const result = await scenario(initial, {
    chiefRecovery: async (item, context) => {
      calls.push([item.active_goal.thread_id, context.failureSignature]);
      return retryDecision();
    },
    worker: async (item) => {
      assert.equal(item.active_goal.thread_id, "thread-1");
      return { type: "WORK_COMPLETE", liveness: "reconnected" };
    },
    gate: async () => ({ type: "GATE_PASS" }),
  });
  assert.equal(result.outcome.status, "DONE");
  assert.deepEqual(calls, [["thread-1", "transport:disconnected"]]);
  assert.equal(result.outcome.telemetry.transport_disconnect_count, 1);
});

test("SIGINT/SIGTERM performs controlled Goal pause-and-confirm before returning resumable state", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    let paused = 0;
    const abort = new AbortController();
    const result = await scenario(
      state([
        obligation("a", "RUNNABLE", { active_goal: { thread_id: "t-1" } }),
      ]),
      {
        worker: async () => {
          abort.abort(signal);
          const error = new Error("controller interrupted");
          error.name = "AbortError";
          throw error;
        },
        pauseGoal: async (threadId) => {
          paused += 1;
          assert.equal(threadId, "t-1");
          return { threadId, status: "paused", confirmed: true };
        },
      },
      { signal: abort.signal }
    );
    assert.equal(result.outcome.status, "PAUSED");
    assert.equal(paused, 1);
    assert.equal(result.outcome.state.status, "paused");
    assert.equal(result.outcome.state.stop_reason, signal);
  }
});

test("8-obligation autonomous scenario drains technical work and leaves only human backlog", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-autonomous-8-"));
  let durable = state(
    Array.from({ length: 8 }, (_, i) => obligation(`uat-${i + 1}`))
  );
  const attempts = new Map();
  const worker = async (item) => {
    const attempt = (attempts.get(item.id) ?? 0) + 1;
    attempts.set(item.id, attempt);
    if (item.id === "uat-3" && attempt === 1)
      return {
        type: "HUMAN_BLOCK",
        category: "BUSINESS_DECISION",
        message: "choose the business policy",
        options: ["A", "B"],
      };
    if (["uat-2", "uat-5", "uat-6", "uat-7"].includes(item.id) && attempt === 1)
      return {
        type: "TECHNICAL_FAILURE",
        signature: item.id === "uat-6" ? "test:repeat" : `test:${item.id}`,
      };
    return { type: "WORK_COMPLETE" };
  };
  const chiefRecovery = async (item) => retryDecision();
  const gate = async () => ({ type: "GATE_PASS" });
  const run = async () => {
    const controller = await (
      await import("../packages/core/dist/index.js")
    ).runAutonomousObligationLoop;
    return controller({
      projectRoot: root,
      runId: "autonomous-8",
      loadState: async () => structuredClone(durable),
      saveState: async (next) => {
        durable = structuredClone(next);
      },
      handlers: { worker, chiefRecovery, gate },
    });
  };
  try {
    let result = await run();
    assert.equal(result.status, "WAITING_FOR_HUMAN");
    assert.equal(
      result.state.obligations.filter((item) => item.status === "PASS").length,
      7
    );
    assert.equal(
      result.state.obligations.filter((item) => item.status === "HUMAN_BLOCKED")
        .length,
      1
    );
    assert.equal(result.telemetry.human_interrupt_count, 0);
    durable.human_backlog[0].status = "RESOLVED";
    result = await run();
    assert.equal(result.status, "DONE");
    assert.equal(
      result.state.obligations.filter((item) => item.status === "PASS").length,
      8
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
