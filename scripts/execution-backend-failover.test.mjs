import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BACKEND_FAILURE_CLASSES,
  BACKEND_STOP_EVIDENCE_FILENAME,
  BACKEND_STOP_REASONS,
  EXECUTION_BACKEND_KINDS,
  EXECUTION_BACKEND_WIRING,
  FAILOVER_ELIGIBLE_FAILURES,
  FAILOVER_REQUIRES_USER_APPROVAL,
  PRODUCTION_BACKEND_FAILOVER_ENABLED,
  approvedFailoverBackends,
  buildBackendStopEvidence,
  classifyBackendFailure,
  evaluateBackendDispatch,
  inspectRoundArtifacts,
  isFailoverEligible,
  routeExecutionRequest,
} from "../packages/core/dist/index.js";

const FIXTURE = JSON.parse(
  await readFile(
    join(
      process.cwd(),
      "scripts/fixtures/execution-backend-failover-dashboard-20260916.json"
    ),
    "utf8"
  )
);

function backend(kind, behaviour) {
  return { kind, available: true, run: behaviour };
}

/**
 * A backend the operator explicitly approved as a failover target. Without this
 * flag a configured backend is never selected, so every failover assertion in
 * this file has to opt in explicitly — that is the point of the contract.
 */
function approvedBackend(kind, behaviour) {
  return { kind, available: true, approvedForFailover: true, run: behaviour };
}

function recordingSink() {
  const routes = [];
  const stops = [];
  return {
    routes,
    stops,
    recordRoute: async (route) => routes.push(route),
    recordStop: async (evidence) => stops.push(evidence),
  };
}

const IDENTITY = {
  runId: "run-failover",
  round: 2,
  phase: "CHIEF_REVIEW",
  taskId: "task-1",
};
const REQUEST = { prompt: "handoff body" };

test("the primary backend is used when it succeeds and no failover is recorded", async () => {
  const sink = recordingSink();
  const outcome = await routeExecutionRequest(
    {
      ...IDENTITY,
      backends: [
        backend("HOST_CODEX", async () => ({
          backend: "HOST_CODEX",
          reply: "ok",
        })),
        backend("EXTERNAL_AGENT", async () => {
          throw new Error("must not be reached");
        }),
      ],
      recordRoute: sink.recordRoute,
    },
    REQUEST
  );
  assert.equal(outcome.result?.backend, "HOST_CODEX");
  assert.equal(outcome.exhausted, false);
  assert.equal(outcome.route.failover, false);
  assert.equal(outcome.route.original_backend, "HOST_CODEX");
  assert.equal(outcome.route.selected_backend, "HOST_CODEX");
  assert.equal(outcome.route.failure_class, undefined);
  assert.deepEqual(outcome.route.attempts, [
    { backend: "HOST_CODEX", outcome: "SUCCESS" },
  ]);
  assert.equal(sink.routes.length, 1, "the controller records every route");
});

test("quota exhaustion on the primary fails over onto an approved fallback and keeps the same run identity", async () => {
  const sink = recordingSink();
  const outcome = await routeExecutionRequest(
    {
      ...IDENTITY,
      backends: [
        backend("HOST_CODEX", async () => {
          throw Object.assign(new Error("429 insufficient_quota"), {
            code: "QUOTA_EXHAUSTED",
          });
        }),
        approvedBackend("EXTERNAL_AGENT", async () => ({
          backend: "EXTERNAL_AGENT",
          reply: "reviewed",
        })),
      ],
      recordRoute: sink.recordRoute,
      recordStop: sink.recordStop,
    },
    REQUEST
  );
  assert.equal(outcome.result?.backend, "EXTERNAL_AGENT");
  assert.equal(outcome.exhausted, false);
  assert.equal(outcome.stopped, false);
  assert.equal(outcome.route.original_backend, "HOST_CODEX");
  assert.equal(outcome.route.selected_backend, "EXTERNAL_AGENT");
  assert.equal(outcome.route.failure_class, "QUOTA_EXHAUSTED");
  assert.equal(outcome.route.failover, true);
  assert.equal(outcome.route.same_run_id, true);
  assert.equal(outcome.route.same_phase, "CHIEF_REVIEW");
  assert.equal(outcome.route.same_task_id, "task-1");
  assert.equal(outcome.route.run_id, "run-failover");
  assert.equal(outcome.route.disposition, "EXECUTED");
  assert.deepEqual(outcome.route.approved_fallback_backends, [
    "EXTERNAL_AGENT",
  ]);
  assert.deepEqual(outcome.route.withheld_backends, []);
  assert.equal(outcome.route.auto_selected_new_provider, false);
  assert.equal(
    sink.stops.length,
    0,
    "an executed route leaves no stop evidence"
  );
  assert.deepEqual(outcome.route.attempts, [
    {
      backend: "HOST_CODEX",
      outcome: "FAILURE",
      failure_class: "QUOTA_EXHAUSTED",
      message: "429 insufficient_quota",
    },
    { backend: "EXTERNAL_AGENT", outcome: "SUCCESS" },
  ]);
});

test("backend unavailable and transport failure also fail over onto an approved fallback", async () => {
  for (const [failure, thrown] of [
    ["BACKEND_UNAVAILABLE", new Error("EXTERNAL_NOT_CONFIGURED")],
    ["TRANSPORT_FAILURE", new Error("ASSISTANT_REPLY_TIMEOUT")],
  ]) {
    const outcome = await routeExecutionRequest(
      {
        ...IDENTITY,
        backends: [
          backend("HOST_CODEX", async () => {
            throw thrown;
          }),
          approvedBackend("EXTERNAL_AGENT", async () => ({
            backend: "EXTERNAL_AGENT",
            reply: "ok",
          })),
        ],
      },
      REQUEST
    );
    assert.equal(outcome.route.failure_class, failure);
    assert.equal(outcome.result?.backend, "EXTERNAL_AGENT");
    assert.equal(outcome.route.failover, true);
    assert.equal(outcome.stopped, false);
  }
});

test("auth and genuine execution failures never fail over even when a fallback is approved", async () => {
  for (const [failure, thrown] of [
    [
      "AUTH_FAILURE",
      Object.assign(new Error("401 unauthorized"), { code: "AUTH_FAILURE" }),
    ],
    ["EXECUTION_FAILURE", new Error("handler produced an invalid event")],
  ]) {
    let secondCalled = false;
    const sink = recordingSink();
    const outcome = await routeExecutionRequest(
      {
        ...IDENTITY,
        backends: [
          backend("HOST_CODEX", async () => {
            throw thrown;
          }),
          approvedBackend("EXTERNAL_AGENT", async () => {
            secondCalled = true;
            return { backend: "EXTERNAL_AGENT", reply: "ok" };
          }),
        ],
        recordStop: sink.recordStop,
      },
      REQUEST
    );
    assert.equal(outcome.result, undefined);
    assert.equal(outcome.route.failure_class, failure);
    assert.equal(outcome.route.selected_backend, null);
    assert.equal(
      outcome.exhausted,
      false,
      `${failure} is not failover-eligible`
    );
    assert.equal(secondCalled, false);
    assert.equal(outcome.stopped, true);
    assert.equal(outcome.stop_reason, "NON_FAILOVER_FAILURE");
    assert.equal(
      outcome.route.requires_human_approval,
      false,
      "approving a fallback would not repair a real execution failure"
    );
    assert.equal(sink.stops.length, 1);
  }
});

test("exhaustion is reported when every approved backend fails", async () => {
  const sink = recordingSink();
  const outcome = await routeExecutionRequest(
    {
      ...IDENTITY,
      backends: [
        backend("HOST_CODEX", async () => ({
          backend: "HOST_CODEX",
          failure: "QUOTA_EXHAUSTED",
          message: "quota",
        })),
        approvedBackend("EXTERNAL_AGENT", async () => ({
          backend: "EXTERNAL_AGENT",
          failure: "BACKEND_UNAVAILABLE",
          message: "no agent configured",
        })),
      ],
      recordStop: sink.recordStop,
    },
    REQUEST
  );
  assert.equal(outcome.exhausted, true);
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.stop_reason, "APPROVED_BACKENDS_EXHAUSTED");
  assert.equal(outcome.result, undefined);
  assert.equal(outcome.route.selected_backend, null);
  assert.equal(outcome.route.failover, true);
  assert.equal(outcome.route.obligation, "TECHNICAL_OPEN");
  assert.deepEqual(
    outcome.route.attempts.map((attempt) => attempt.failure_class),
    ["QUOTA_EXHAUSTED", "BACKEND_UNAVAILABLE"]
  );
  assert.equal(
    sink.stops.length,
    1,
    "a stopped route always leaves durable evidence"
  );
  assert.equal(sink.stops[0].stop_reason, "APPROVED_BACKENDS_EXHAUSTED");
  assert.equal(sink.stops[0].obligation, "TECHNICAL_OPEN");
});

test("an unconfigured backend is skipped and total unavailability is explicit", async () => {
  const sink = recordingSink();
  const outcome = await routeExecutionRequest(
    {
      ...IDENTITY,
      backends: [
        {
          kind: "HOST_CODEX",
          available: false,
          run: async () => {
            throw new Error("must not be called");
          },
        },
        {
          kind: "EXTERNAL_AGENT",
          available: false,
          run: async () => {
            throw new Error("must not be called");
          },
        },
      ],
      recordStop: sink.recordStop,
    },
    REQUEST
  );
  assert.equal(outcome.exhausted, true);
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.stop_reason, "NO_EXECUTION_BACKEND_CONFIGURED");
  assert.equal(outcome.route.original_backend, null);
  assert.equal(outcome.route.selected_backend, null);
  assert.equal(outcome.route.failure_class, "BACKEND_UNAVAILABLE");
  assert.equal(sink.stops.length, 1);
});

test("failure classification is total and never guesses failover eligibility", () => {
  assert.equal(
    classifyBackendFailure(new Error("429 rate limit reached")),
    "QUOTA_EXHAUSTED"
  );
  assert.equal(
    classifyBackendFailure(new Error("额度已用尽")),
    "QUOTA_EXHAUSTED"
  );
  assert.equal(
    classifyBackendFailure(new Error("401 Unauthorized")),
    "AUTH_FAILURE"
  );
  assert.equal(
    classifyBackendFailure(new Error("invalid api key")),
    "AUTH_FAILURE"
  );
  assert.equal(
    classifyBackendFailure(new Error("EXTERNAL_NOT_CONFIGURED")),
    "BACKEND_UNAVAILABLE"
  );
  assert.equal(
    classifyBackendFailure(new Error("spawn codex ENOENT")),
    "BACKEND_UNAVAILABLE"
  );
  assert.equal(
    classifyBackendFailure(new Error("socket hang up")),
    "TRANSPORT_FAILURE"
  );
  assert.equal(
    classifyBackendFailure(new Error("ASSISTANT_REPLY_TIMEOUT")),
    "TRANSPORT_FAILURE"
  );
  assert.equal(
    classifyBackendFailure(new Error("killed by SIGKILL")),
    "PROCESS_CRASH"
  );
  assert.equal(
    classifyBackendFailure(new Error("weird thing")),
    "EXECUTION_FAILURE"
  );
  assert.equal(classifyBackendFailure(undefined), "EXECUTION_FAILURE");
  for (const value of [null, "", 0, {}, []])
    assert.ok(BACKEND_FAILURE_CLASSES.includes(classifyBackendFailure(value)));
  assert.deepEqual(FAILOVER_ELIGIBLE_FAILURES.filter(isFailoverEligible), [
    "QUOTA_EXHAUSTED",
    "BACKEND_UNAVAILABLE",
    "TRANSPORT_FAILURE",
  ]);
  assert.equal(isFailoverEligible("PROCESS_CRASH"), false);
  assert.deepEqual(
    [...EXECUTION_BACKEND_KINDS],
    ["HOST_CODEX", "EXTERNAL_AGENT"]
  );
  assert.deepEqual(
    [...BACKEND_STOP_REASONS],
    [
      "NO_APPROVED_FALLBACK_BACKEND",
      "NO_EXECUTION_BACKEND_CONFIGURED",
      "NON_FAILOVER_FAILURE",
      "APPROVED_BACKENDS_EXHAUSTED",
    ]
  );
  assert.equal(FAILOVER_REQUIRES_USER_APPROVAL, true);
  assert.equal(PRODUCTION_BACKEND_FAILOVER_ENABLED, false);
  assert.equal(BACKEND_STOP_EVIDENCE_FILENAME, "execution_backend_stop.json");
});

test("routing never touches authoritative run state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-backend-state-"));
  const runDir = join(root, ".ralph", "chief-runs", "run-failover");
  await mkdir(runDir, { recursive: true });
  const statePath = join(runDir, "RUN_STATE.json");
  const stateBytes = `${JSON.stringify(
    {
      version: 1,
      run_id: "run-failover",
      phase: "CHIEF_REVIEW",
      status: "running",
      round: 2,
      current_task_id: "task-1",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    null,
    2
  )}\n`;
  await writeFile(statePath, stateBytes);

  const routes = [];
  await routeExecutionRequest(
    {
      ...IDENTITY,
      backends: [
        backend("HOST_CODEX", async () => {
          throw new Error("429 quota");
        }),
        approvedBackend("EXTERNAL_AGENT", async () => ({
          backend: "EXTERNAL_AGENT",
          reply: "ok",
        })),
      ],
      recordRoute: async (route) => routes.push(route),
    },
    REQUEST
  );

  assert.equal(await readFile(statePath, "utf8"), stateBytes);
  assert.equal(
    routes.length,
    1,
    "the controller, not the backend, records routes"
  );
});

test("a fail-closed stop leaves the run technically open and the state untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-backend-stop-"));
  const runDir = join(root, ".ralph", "chief-runs", "run-stop");
  await mkdir(runDir, { recursive: true });
  const statePath = join(runDir, "RUN_STATE.json");
  const stateBytes = `${JSON.stringify(
    {
      version: 1,
      run_id: "run-stop",
      phase: "CHIEF_REVIEW",
      status: "running",
      round: 2,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    null,
    2
  )}\n`;
  await writeFile(statePath, stateBytes);

  // The router is handed no state *writer of any kind* — only sinks the
  // Controller owns — so a stop can never mutate the authoritative run state.
  const sink = recordingSink();
  const outcome = await routeExecutionRequest(
    {
      ...IDENTITY,
      backends: [
        backend("HOST_CODEX", async () => {
          throw Object.assign(new Error("429 insufficient_quota"), {
            code: "QUOTA_EXHAUSTED",
          });
        }),
        backend("EXTERNAL_AGENT", async () => {
          throw new Error("must never be called without approval");
        }),
      ],
      recordRoute: sink.recordRoute,
      recordStop: sink.recordStop,
    },
    REQUEST
  );

  assert.equal(await readFile(statePath, "utf8"), stateBytes);
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.stop_reason, "NO_APPROVED_FALLBACK_BACKEND");
  assert.equal(outcome.route.obligation, "TECHNICAL_OPEN");
  assert.equal(sink.routes.length, 1);
  assert.equal(sink.stops.length, 1);
  assert.equal(sink.stops[0].obligation, "TECHNICAL_OPEN");
  assert.equal(sink.stops[0].kind, "EXECUTION_BACKEND_STOP");
});

test("durable artifacts suppress duplicate execution before any failover", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-backend-dupe-"));
  const runDir = join(root, ".ralph", "chief-runs", "run-dupe");
  const roundDir = join(runDir, "rounds", "002");
  await mkdir(roundDir, { recursive: true });
  const write = (name, value) =>
    writeFile(join(roundDir, name), `${JSON.stringify(value, null, 2)}\n`);

  const empty = await inspectRoundArtifacts({
    projectRoot: root,
    runId: "run-dupe",
    round: 2,
  });
  assert.deepEqual(empty, {
    workerCompleted: false,
    gateRequiredPassed: false,
    checkpointCommitted: false,
    selectDecisionRecorded: false,
    reviewDecisionRecorded: false,
    finalReviewDecisionRecorded: false,
    recoveryDecisionRecorded: false,
    integrationUatPassed: false,
  });
  assert.equal(
    evaluateBackendDispatch({
      runState: { phase: "WORKER" },
      artifacts: empty,
    }).dispatch,
    true
  );

  await write("worker_evidence.json", { completed: true });
  await write("machine_gate.json", {
    passed: true,
    required_gate_passed: true,
  });
  await write("checkpoint.json", { pushed: true });
  await write("select_decision.json", { action: "SELECT_TASK" });
  await write("review_decision.json", { action: "PATCH" });
  await write("final_review_decision.json", { action: "PASS" });
  await write("recovery_decision.json", { action: "RETRY_WORKER" });
  await write("integration_uat.json", { passed: true });

  const full = await inspectRoundArtifacts({
    projectRoot: root,
    runId: "run-dupe",
    round: 2,
  });
  for (const [phase, artifact] of [
    ["WORKER", "worker_evidence.json"],
    ["MACHINE_GATE", "machine_gate.json"],
    ["CHECKPOINT", "checkpoint.json"],
    ["SELECT", "select_decision.json"],
    ["CHIEF_REVIEW", "review_decision.json"],
    ["FINAL_REVIEW", "final_review_decision.json"],
    ["CHIEF_RECOVERY", "recovery_decision.json"],
    ["INTEGRATION_UAT", "integration_uat.json"],
  ]) {
    const decision = evaluateBackendDispatch({
      runState: { phase },
      artifacts: full,
    });
    assert.equal(decision.dispatch, false, `${phase} must not re-execute`);
    assert.equal(decision.satisfied_by, artifact);
    assert.ok(decision.reason.length > 0);
  }
  assert.equal(
    evaluateBackendDispatch({
      runState: { phase: "DONE" },
      artifacts: full,
    }).dispatch,
    false
  );
});

test("a partially durable round only suppresses the phases that are truly done", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-backend-partial-"));
  const roundDir = join(
    root,
    ".ralph",
    "chief-runs",
    "run-partial",
    "rounds",
    "003"
  );
  await mkdir(roundDir, { recursive: true });
  await writeFile(
    join(roundDir, "worker_evidence.json"),
    `${JSON.stringify({ completed: true })}\n`
  );
  const artifacts = await inspectRoundArtifacts({
    projectRoot: root,
    runId: "run-partial",
    round: 3,
  });
  assert.equal(
    evaluateBackendDispatch({ runState: { phase: "WORKER" }, artifacts })
      .dispatch,
    false
  );
  assert.equal(
    evaluateBackendDispatch({ runState: { phase: "MACHINE_GATE" }, artifacts })
      .dispatch,
    true
  );
  assert.equal(
    evaluateBackendDispatch({ runState: { phase: "CHIEF_REVIEW" }, artifacts })
      .dispatch,
    true
  );
});

test("an unapproved fallback is withheld: quota exhaustion stops instead of switching backend", async () => {
  let fallbackCalled = false;
  const sink = recordingSink();
  const outcome = await routeExecutionRequest(
    {
      ...IDENTITY,
      backends: [
        backend("HOST_CODEX", async () => {
          throw Object.assign(new Error("429 insufficient_quota"), {
            code: "QUOTA_EXHAUSTED",
          });
        }),
        backend("EXTERNAL_AGENT", async () => {
          fallbackCalled = true;
          return { backend: "EXTERNAL_AGENT", reply: "ok" };
        }),
      ],
      recordRoute: sink.recordRoute,
      recordStop: sink.recordStop,
      now: () => "2026-09-16T06:00:00.000Z",
    },
    REQUEST
  );

  assert.equal(
    fallbackCalled,
    false,
    "a configured but unapproved backend must never be invoked as a fallback"
  );
  assert.equal(outcome.result, undefined);
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.stop_reason, "NO_APPROVED_FALLBACK_BACKEND");
  assert.equal(outcome.exhausted, false);
  assert.equal(outcome.route.selected_backend, null);
  assert.equal(outcome.route.disposition, "STOPPED");
  assert.equal(outcome.route.obligation, "TECHNICAL_OPEN");
  assert.equal(outcome.route.requires_human_approval, true);
  assert.equal(outcome.route.failover, false);
  assert.deepEqual(outcome.route.approved_fallback_backends, []);
  assert.deepEqual(outcome.route.withheld_backends, ["EXTERNAL_AGENT"]);
  assert.equal(outcome.route.auto_selected_new_provider, false);
  assert.equal(outcome.route.failure_class, "QUOTA_EXHAUSTED");

  // Durable evidence: the Controller persists exactly this record.
  assert.equal(sink.stops.length, 1);
  assert.deepEqual(sink.stops[0], {
    kind: "EXECUTION_BACKEND_STOP",
    run_id: "run-failover",
    round: 2,
    phase: "CHIEF_REVIEW",
    task_id: "task-1",
    disposition: "STOPPED",
    stop_reason: "NO_APPROVED_FALLBACK_BACKEND",
    failure_class: "QUOTA_EXHAUSTED",
    failure_message: "429 insufficient_quota",
    obligation: "TECHNICAL_OPEN",
    requires_human_approval: true,
    approved_fallback_backends: [],
    withheld_backends: ["EXTERNAL_AGENT"],
    attempted_backends: [
      {
        backend: "HOST_CODEX",
        outcome: "FAILURE",
        failure_class: "QUOTA_EXHAUSTED",
        message: "429 insufficient_quota",
      },
    ],
    auto_selected_new_provider: false,
    recorded_at: "2026-09-16T06:00:00.000Z",
  });
  assert.deepEqual(outcome.stop_evidence, sink.stops[0]);
  assert.deepEqual(buildBackendStopEvidence(outcome.route), sink.stops[0]);
});

test("a single configured backend with no fallback stops rather than inventing a provider", async () => {
  const sink = recordingSink();
  const outcome = await routeExecutionRequest(
    {
      ...IDENTITY,
      backends: [
        backend("HOST_CODEX", async () => {
          throw Object.assign(new Error("usage limit exceeded"), {
            code: "QUOTA_EXHAUSTED",
          });
        }),
      ],
      recordRoute: sink.recordRoute,
      recordStop: sink.recordStop,
    },
    REQUEST
  );

  assert.equal(outcome.stopped, true);
  assert.equal(outcome.stop_reason, "NO_APPROVED_FALLBACK_BACKEND");
  assert.equal(outcome.route.selected_backend, null);
  assert.deepEqual(outcome.route.approved_fallback_backends, []);
  assert.deepEqual(outcome.route.withheld_backends, []);
  assert.equal(outcome.route.attempts.length, 1);
  assert.equal(outcome.route.auto_selected_new_provider, false);
  assert.equal(sink.stops.length, 1);
});

test("failover approval is explicit, per backend, and never applies to the primary", () => {
  const primary = backend("HOST_CODEX", async () => ({}));
  const unapproved = backend("EXTERNAL_AGENT", async () => ({}));
  const approved = approvedBackend("EXTERNAL_AGENT", async () => ({}));

  assert.deepEqual(approvedFailoverBackends([primary, unapproved]), []);
  assert.deepEqual(
    approvedFailoverBackends([primary, approved]).map((entry) => entry.kind),
    ["EXTERNAL_AGENT"]
  );
  assert.deepEqual(
    approvedFailoverBackends([approvedBackend("HOST_CODEX", async () => ({}))]),
    [],
    "an approved first entry is still the primary, not a fallback target"
  );
});

test("the failover router is experimental and is not wired into any production entry", async () => {
  assert.deepEqual(EXECUTION_BACKEND_WIRING, {
    capability: "EXECUTION_BACKEND_FAILOVER",
    status: "EXPERIMENTAL",
    wired_into_controller: false,
    production_auto_failover: "NOT_ENABLED",
  });
  assert.equal(PRODUCTION_BACKEND_FAILOVER_ENABLED, false);

  const walk = async (dir) => {
    const files = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name.startsWith(".")
      )
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(full)));
      else files.push(full);
    }
    return files;
  };

  const allowed = new Set([
    join("packages", "core", "src", "v3", "execution-backend.ts"),
    join("packages", "core", "src", "index.ts"),
  ]);
  const pattern =
    /routeExecutionRequest|evaluateBackendDispatch|inspectRoundArtifacts|execution-backend/;
  const offenders = [];
  for (const root of ["apps", join("packages", "core", "src")]) {
    for (const file of await walk(root)) {
      if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(file)) continue;
      if (allowed.has(file)) continue;
      if (pattern.test(await readFile(file, "utf8"))) offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the experimental router must not be reachable from production code: ${offenders.join(", ")}`
  );

  const supervisor = await readFile(
    join("apps", "cli", "bin", "ralph-v3-supervisor.js"),
    "utf8"
  );
  assert.equal(
    pattern.test(supervisor),
    false,
    "the supervisor must never route execution backends"
  );
});

test("the real dashboard run is valid, anonymized capability evidence", () => {
  assert.equal(FIXTURE.anonymized, true);
  assert.equal(FIXTURE.version, 1);
  assert.equal(FIXTURE.run.run_id, "dashboard-widget-real-20260916-r2");
  assert.equal(FIXTURE.run.final_phase, "DONE");
  assert.equal(FIXTURE.run.final_status, "done");
  assert.equal(FIXTURE.run.final_round, 5);
  assert.deepEqual(FIXTURE.run.obligations, [
    { id: "task:dashboard-android-widget-p0", status: "PASS" },
  ]);

  const serialized = JSON.stringify(FIXTURE);
  assert.equal(
    /\/private\/|\/Users\/|\/var\/folders\//.test(serialized),
    false,
    "no machine-specific absolute path may be embedded"
  );
  assert.equal(
    FIXTURE.rounds.every((round) => round.round >= 1 && round.round <= 5),
    true
  );
  assert.equal(FIXTURE.rounds.length, FIXTURE.run.final_round);
  for (const round of FIXTURE.rounds) {
    assert.equal(typeof round.base_sha, "string");
    assert.equal(typeof round.head_sha, "string");
    assert.equal(round.pushed, true);
  }
});

test("the real run proves historical rounds were never rewritten during the failover", () => {
  assert.ok(FIXTURE.historical_rounds_unchanged.length >= 4);
  for (const round of FIXTURE.historical_rounds_unchanged) {
    assert.equal(round.unchanged, true, `round ${round.round} was rewritten`);
    assert.equal(round.aggregate_hash_before, round.aggregate_hash_after);
    assert.ok(round.file_count > 0);
  }
  assert.deepEqual(
    FIXTURE.historical_rounds_unchanged.map((round) => round.round),
    [1, 2, 3, 4]
  );
});

test("the real failover record matches what the permanent router produces today", async () => {
  const recorded = FIXTURE.backend_failover;
  assert.equal(recorded.same_run_id, true);
  assert.equal(recorded.original_backend, "HOST_CODEX");
  assert.equal(recorded.selected_backend, "EXTERNAL_AGENT");
  assert.equal(recorded.failure_class, "QUOTA_EXHAUSTED");
  assert.deepEqual(recorded.takeover_rounds, [3, 4, 5]);
  assert.equal(
    recorded.durable_failure_signals.external_warm_code,
    "EXTERNAL_NOT_CONFIGURED"
  );
  assert.equal(
    recorded.durable_failure_signals.external_recovery_attempted,
    false
  );
  assert.ok(recorded.durable_failure_signals.host_attempt_duration_ms > 0);

  const sink = recordingSink();
  const outcome = await routeExecutionRequest(
    {
      runId: recorded.run_id,
      round: recorded.triggered_at_round,
      phase: recorded.phase,
      taskId: recorded.task_id,
      backends: [
        backend("HOST_CODEX", async () => {
          throw Object.assign(new Error("codex quota exhausted"), {
            code: "QUOTA_EXHAUSTED",
          });
        }),
        approvedBackend("EXTERNAL_AGENT", async () => ({
          backend: "EXTERNAL_AGENT",
          reply: "external agent verdict",
        })),
      ],
      recordRoute: sink.recordRoute,
      now: () => "2026-09-16T04:00:00.000Z",
    },
    { prompt: "prepared review handoff" }
  );

  assert.equal(outcome.route.run_id, recorded.run_id);
  assert.equal(outcome.route.original_backend, recorded.original_backend);
  assert.equal(outcome.route.selected_backend, recorded.selected_backend);
  assert.equal(outcome.route.failure_class, recorded.failure_class);
  assert.equal(outcome.route.same_run_id, true);
  assert.equal(outcome.route.same_phase, recorded.same_phase);
  assert.equal(outcome.route.same_task_id, recorded.same_task_id);
  assert.equal(outcome.route.round, recorded.triggered_at_round);
  assert.equal(sink.routes.length, 1);

  // Without that explicit approval the very same real incident must stop
  // fail-closed on the same run instead of switching provider.
  const unapprovedSink = recordingSink();
  const stopped = await routeExecutionRequest(
    {
      runId: recorded.run_id,
      round: recorded.triggered_at_round,
      phase: recorded.phase,
      taskId: recorded.task_id,
      backends: [
        backend("HOST_CODEX", async () => {
          throw Object.assign(new Error("codex quota exhausted"), {
            code: "QUOTA_EXHAUSTED",
          });
        }),
        backend("EXTERNAL_AGENT", async () => ({
          backend: "EXTERNAL_AGENT",
          reply: "external agent verdict",
        })),
      ],
      recordRoute: unapprovedSink.recordRoute,
      recordStop: unapprovedSink.recordStop,
    },
    { prompt: "prepared review handoff" }
  );
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.stop_reason, "NO_APPROVED_FALLBACK_BACKEND");
  assert.equal(
    stopped.route.run_id,
    recorded.run_id,
    "same run, never a new one"
  );
  assert.equal(stopped.route.selected_backend, null);
  assert.equal(stopped.route.obligation, "TECHNICAL_OPEN");
  assert.equal(stopped.route.requires_human_approval, true);
  assert.equal(unapprovedSink.stops.length, 1);
  assert.equal(unapprovedSink.routes.length, 1);
});

test("the real supervisor spin is the incident the restart matrix now prevents", () => {
  const spin = FIXTURE.backend_failover.supervisor_spin;
  assert.equal(spin.restart_count, 231);
  assert.equal(spin.event_count, 232);
  assert.equal(spin.parked_phase, "WAITING_FOR_CHIEF");
  assert.equal(spin.parked_status, "waiting");
});
