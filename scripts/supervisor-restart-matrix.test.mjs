import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTROLLED_STOP_REASONS,
  evaluateSupervisorDisposition,
  supervisorFailureFingerprint,
  supervisorRestartBackoffMs,
} from "../packages/core/dist/index.js";
import { runV3Supervisor } from "../apps/cli/bin/ralph-v3-supervisor.js";

const CRASH_FIXTURE = join(
  process.cwd(),
  "scripts/supervisor-crash-fixture-controller.mjs"
);
const RESUME_FIXTURE = join(
  process.cwd(),
  "scripts/supervisor-fixture-controller.mjs"
);

const ZERO = "0".repeat(64);

async function seedRun({
  phase,
  status,
  stop_reason,
  failure_reason,
  telemetry,
  waitingHandoff,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ralph-supervisor-matrix-"));
  const runId = `matrix-${Math.random().toString(16).slice(2, 10)}`;
  const runDir = join(root, ".ralph", "chief-runs", runId);
  await mkdir(runDir, { recursive: true });
  const now = new Date().toISOString();
  const state = {
    version: 1,
    run_id: runId,
    phase,
    status,
    round: 1,
    current_task_id: "task-1",
    started_at: now,
    updated_at: now,
  };
  if (stop_reason) state.stop_reason = stop_reason;
  if (failure_reason) state.failure_reason = failure_reason;
  if (waitingHandoff) state.waiting_handoff = waitingHandoff;
  await writeFile(
    join(runDir, "RUN_STATE.json"),
    `${JSON.stringify(state, null, 2)}\n`
  );
  if (telemetry)
    await writeFile(
      join(runDir, "telemetry.json"),
      `${JSON.stringify({ version: 1, ...telemetry }, null, 2)}\n`
    );
  return { root, runId, runDir };
}

function reviewHandoff(runId) {
  return {
    kind: "review",
    run_id: runId,
    round: 1,
    handoff_path: join("/tmp", runId, "rounds", "001", "review_handoff.md"),
    handoff_hash: ZERO,
    handoff_content_hash: ZERO,
    project_state_hash: ZERO,
    checkpoint_hash: ZERO,
    gate_artifact_hash: ZERO,
    review_stage: "chief",
    created_at: new Date().toISOString(),
  };
}

async function supervisorState(runDir) {
  return JSON.parse(
    await readFile(join(runDir, "SUPERVISOR_STATE.json"), "utf8")
  );
}

function neverSpawn(counter) {
  return () => {
    counter.calls += 1;
    throw new Error("supervisor must not spawn the controller");
  };
}

test("crash with durable work remaining restarts the controller and resumes to PASS", async () => {
  const { root, runId, runDir } = await seedRun({
    phase: "SELECT",
    status: "running",
  });
  const attempts = join(runDir, "attempts.txt");
  const result = await runV3Supervisor({
    projectRoot: root,
    runId,
    controller: RESUME_FIXTURE,
    maxRestarts: 3,
    restartDelayMs: 0,
    stdio: "ignore",
    childEnv: {
      RALPH_FIXTURE_RUN_STATE: join(runDir, "RUN_STATE.json"),
      RALPH_FIXTURE_ATTEMPTS: attempts,
      RALPH_FIXTURE_SCENARIO: "worker",
    },
  });
  assert.equal(result.status, "DONE");
  assert.equal(result.restartCount, 1);
  assert.equal(result.events[0].exit.signal, "SIGKILL");
  assert.equal(result.disposition.kind, "STABLE_DONE");
  const persisted = await supervisorState(runDir);
  assert.equal(persisted.restart_count, 1);
  assert.equal(persisted.last_disposition.kind, "STABLE_DONE");
});

test("WAITING_FOR_CHIEF with no autonomous recovery left stays stable and never restarts", async () => {
  const { root, runId, runDir } = await seedRun({
    phase: "WAITING_FOR_CHIEF",
    status: "waiting",
    telemetry: { chief_wait_budget_exhausted: true, chief_retry_count: 12 },
  });
  const runStatePath = join(runDir, "RUN_STATE.json");
  const state = JSON.parse(await readFile(runStatePath, "utf8"));
  state.waiting_handoff = reviewHandoff(runId);
  await writeFile(runStatePath, `${JSON.stringify(state, null, 2)}\n`);

  const counter = { calls: 0 };
  const result = await runV3Supervisor({
    projectRoot: root,
    runId,
    spawnImpl: neverSpawn(counter),
    restartDelayMs: 0,
  });

  assert.equal(
    counter.calls,
    0,
    "a legal external wait must not spawn a controller"
  );
  assert.equal(result.status, "WAITING_FOR_CHIEF");
  assert.equal(result.restartCount, 0);
  assert.equal(result.events.length, 0);
  assert.equal(result.disposition.kind, "STABLE_WAIT");
  const persisted = await supervisorState(runDir);
  assert.equal(persisted.restart_count, 0);
  assert.equal(persisted.last_disposition.kind, "STABLE_WAIT");
  assert.equal(persisted.technical_open, false);
});

test("WAITING_FOR_CHIEF with a pending autonomous recovery action does restart", async () => {
  const { root, runId, runDir } = await seedRun({
    phase: "WAITING_FOR_CHIEF",
    status: "waiting",
    telemetry: { chief_recovery_pending: true },
  });
  const runStatePath = join(runDir, "RUN_STATE.json");
  const state = JSON.parse(await readFile(runStatePath, "utf8"));
  state.waiting_handoff = reviewHandoff(runId);
  await writeFile(runStatePath, `${JSON.stringify(state, null, 2)}\n`);

  const attempts = join(runDir, "attempts.txt");
  const result = await runV3Supervisor({
    projectRoot: root,
    runId,
    controller: CRASH_FIXTURE,
    maxRestarts: 2,
    maxRapidRestarts: 1,
    restartDelayMs: 0,
    rapidRestartWindowMs: 60_000,
    stdio: "ignore",
    childEnv: {
      RALPH_FIXTURE_RUN_STATE: runStatePath,
      RALPH_FIXTURE_ATTEMPTS: attempts,
      RALPH_FIXTURE_CRASH_CODE: "7",
    },
  });
  assert.ok(result.restartCount >= 1);
  assert.equal(await readFile(attempts, "utf8"), String(result.restartCount));
});

test("WAITING_FOR_HUMAN, HUMAN_REQUIRED, DONE and FAILED never restart", async () => {
  for (const scenario of [
    { phase: "WAITING_FOR_HUMAN", status: "waiting" },
    { phase: "HUMAN_REQUIRED", status: "waiting" },
    { phase: "DONE", status: "done" },
    { phase: "FAILED", status: "failed", failure_reason: "gate policy" },
  ]) {
    const { root, runId, runDir } = await seedRun(scenario);
    const counter = { calls: 0 };
    const result = await runV3Supervisor({
      projectRoot: root,
      runId,
      spawnImpl: neverSpawn(counter),
      restartDelayMs: 0,
    });
    assert.equal(
      counter.calls,
      0,
      `${scenario.phase}/${scenario.status} must not restart`
    );
    assert.equal(result.restartCount, 0);
    assert.equal(result.disposition.restart, false);
    assert.equal(
      (await supervisorState(runDir)).restart_count,
      0,
      `${scenario.phase} restart counter must not grow`
    );
  }
});

test("controlled pause, user stop and intentional exit never restart", () => {
  // `status: paused` is only invariant-legal inside a waiting phase, so this
  // rule is asserted directly against the matrix.
  for (const stop_reason of CONTROLLED_STOP_REASONS) {
    for (const phase of ["WAITING_FOR_CHIEF", "WAITING_FOR_HUMAN"]) {
      const decision = evaluateSupervisorDisposition({
        runState: { phase, status: "paused", stop_reason },
      });
      assert.equal(decision.restart, false, `${phase}/${stop_reason}`);
      assert.equal(decision.kind, "STABLE_PAUSE");
      assert.match(decision.reason, new RegExp(stop_reason));
    }
  }
});

test("the production incident shape (budget exhausted at WAITING_FOR_CHIEF, clean exit) no longer spins", async () => {
  // Reproduces the real run: the controller exited cleanly, the durable state
  // stayed WAITING_FOR_CHIEF/waiting, and the supervisor restarted it 231 times.
  const { root, runId, runDir } = await seedRun({
    phase: "WAITING_FOR_CHIEF",
    status: "waiting",
    telemetry: {
      chief_wait_budget_exhausted: true,
      chief_wait_budget_exhausted_at: "2026-09-16T03:25:08.995Z",
      chief_retry_count: 1,
      review_chief_route: {
        requested_role: "review",
        selected_route: "HOST_CHIEF",
        external_warm: {
          attempted: true,
          success: false,
          code: "EXTERNAL_NOT_CONFIGURED",
        },
        external_recovery: { attempted: false, success: false },
      },
    },
  });
  const runStatePath = join(runDir, "RUN_STATE.json");
  const state = JSON.parse(await readFile(runStatePath, "utf8"));
  state.waiting_handoff = reviewHandoff(runId);
  await writeFile(runStatePath, `${JSON.stringify(state, null, 2)}\n`);

  const counter = { calls: 0 };
  const result = await runV3Supervisor({
    projectRoot: root,
    runId,
    spawnImpl: neverSpawn(counter),
    restartDelayMs: 0,
  });

  assert.equal(counter.calls, 0);
  assert.equal(
    result.restartCount,
    0,
    "restart_count must not grow for a legal external wait"
  );
  assert.equal(result.status, "WAITING_FOR_CHIEF");
  const persisted = await supervisorState(runDir);
  assert.match(
    persisted.last_disposition.reason,
    /autonomous recovery exhausted/
  );
});

test("identical rapid crashes back off and stop instead of hot-restarting", async () => {
  const { root, runId, runDir } = await seedRun({
    phase: "WORKER",
    status: "running",
  });
  const attempts = join(runDir, "attempts.txt");
  const result = await runV3Supervisor({
    projectRoot: root,
    runId,
    controller: CRASH_FIXTURE,
    maxRestarts: 100,
    maxRapidRestarts: 3,
    restartDelayMs: 0,
    rapidRestartWindowMs: 60_000,
    stdio: "ignore",
    childEnv: {
      RALPH_FIXTURE_RUN_STATE: join(runDir, "RUN_STATE.json"),
      RALPH_FIXTURE_ATTEMPTS: attempts,
      RALPH_FIXTURE_CRASH_CODE: "3",
    },
  });

  assert.equal(result.status, "SUPERVISOR_BACKED_OFF");
  assert.equal(result.restartCount, 3);
  assert.equal(result.disposition.kind, "STABLE_TECHNICAL_OPEN");
  assert.ok(
    result.restartCount < 100,
    "a crash loop must stop long before the restart budget"
  );
  const persisted = await supervisorState(runDir);
  assert.equal(persisted.technical_open, true);
  assert.match(persisted.stopped_reason, /identical rapid controller failures/);
  assert.equal(persisted.consecutive_identical_failures, 3);
  assert.equal(
    new Set(result.events.map((event) => event.fingerprint)).size,
    1,
    "identical failures share one fingerprint"
  );
  const runState = JSON.parse(
    await readFile(join(runDir, "RUN_STATE.json"), "utf8")
  );
  assert.equal(
    runState.phase,
    "WORKER",
    "the supervisor must not rewrite business state when it backs off"
  );
});

test("backoff grows exponentially and is capped", () => {
  const options = { baseMs: 1000, maxMs: 8000 };
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((count) =>
      supervisorRestartBackoffMs(count, options)
    ),
    [0, 1000, 2000, 4000, 8000, 8000, 8000]
  );
  assert.equal(supervisorRestartBackoffMs(9, { baseMs: 0 }), 0);
  assert.equal(
    supervisorRestartBackoffMs(3, { baseMs: 250, maxMs: 500 }),
    500,
    "the cap is never exceeded"
  );
});

test("failure fingerprints are stable and sensitive to the failure", () => {
  const runState = { phase: "WORKER", status: "running" };
  assert.equal(
    supervisorFailureFingerprint({ runState, exit: { code: 1, signal: null } }),
    supervisorFailureFingerprint({ runState, exit: { code: 1, signal: null } })
  );
  assert.notEqual(
    supervisorFailureFingerprint({ runState, exit: { code: 1, signal: null } }),
    supervisorFailureFingerprint({
      runState,
      exit: { code: null, signal: "SIGKILL" },
    })
  );
  assert.notEqual(
    supervisorFailureFingerprint({ runState, exit: { code: 1, signal: null } }),
    supervisorFailureFingerprint({
      runState: { phase: "WORKER", status: "running", failure_reason: "x" },
      exit: { code: 1, signal: null },
    })
  );
});

test("restart matrix classification is total across every durable phase", () => {
  const cases = [
    [{ phase: "DONE", status: "done" }, false, "STABLE_DONE"],
    [{ phase: "FAILED", status: "failed" }, false, "STABLE_TERMINAL"],
    [{ phase: "WAITING_FOR_HUMAN", status: "waiting" }, false, "STABLE_WAIT"],
    [{ phase: "HUMAN_REQUIRED", status: "waiting" }, false, "STABLE_WAIT"],
    [{ phase: "WAITING_FOR_CHIEF", status: "waiting" }, false, "STABLE_WAIT"],
    [{ phase: "WORKER", status: "paused" }, false, "STABLE_PAUSE"],
    [{ phase: "SELECT", status: "running" }, true, "RESTART"],
    [{ phase: "WORKER", status: "running" }, true, "RESTART"],
    [{ phase: "MACHINE_GATE", status: "running" }, true, "RESTART"],
    [{ phase: "CHECKPOINT", status: "running" }, true, "RESTART"],
    [{ phase: "CHIEF_REVIEW", status: "running" }, true, "RESTART"],
    [{ phase: "INTEGRATION_UAT", status: "running" }, true, "RESTART"],
    [{ phase: "FINAL_REVIEW", status: "running" }, true, "RESTART"],
    [{ phase: "CHIEF_RECOVERY", status: "running" }, true, "RESTART"],
  ];
  for (const [runState, restart, kind] of cases) {
    const decision = evaluateSupervisorDisposition({ runState });
    assert.equal(decision.restart, restart, `${runState.phase} restart`);
    assert.equal(decision.kind, kind, `${runState.phase} kind`);
    assert.ok(decision.reason.length > 0);
  }
  const noState = evaluateSupervisorDisposition({});
  assert.equal(noState.restart, true);
  assert.match(noState.reason, /no durable run state/);
});

test("supervisor still reports a restart budget exhaustion durably", async () => {
  const { root, runId, runDir } = await seedRun({
    phase: "WORKER",
    status: "running",
  });
  const attempts = join(runDir, "attempts.txt");
  const result = await runV3Supervisor({
    projectRoot: root,
    runId,
    controller: CRASH_FIXTURE,
    maxRestarts: 0,
    maxRapidRestarts: 100,
    restartDelayMs: 0,
    rapidRestartWindowMs: 0,
    stdio: "ignore",
    childEnv: {
      RALPH_FIXTURE_RUN_STATE: join(runDir, "RUN_STATE.json"),
      RALPH_FIXTURE_ATTEMPTS: attempts,
      RALPH_FIXTURE_CRASH_CODE: "1",
    },
  });
  assert.equal(result.status, "SUPERVISOR_RESTART_BUDGET_EXHAUSTED");
  const persisted = await supervisorState(runDir);
  assert.equal(persisted.technical_open, true);
  assert.match(persisted.stopped_reason, /restart budget exhausted/);
});
