import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Distil the real dashboard run into an anonymized capability fixture.
 *
 * Source of truth (read-only):
 *   RUN_STATE / telemetry / OBLIGATIONS / rounds/N/* of the real run
 *   plus the two durable-state sha256 snapshots taken around the final review.
 *
 * Paths are rewritten to run-relative form and no machine-specific absolute
 * path is embedded, so the fixture is safe to ship in the public test suite.
 */
const RUN_DIR =
  process.env.RALPH_EVIDENCE_RUN_DIR ??
  "/private/tmp/edu-ops-dashboard-ralph-run/.ralph/chief-runs/dashboard-widget-real-20260916-r2";
const SNAPSHOT_BEFORE =
  process.env.RALPH_EVIDENCE_SNAPSHOT_BEFORE ??
  "/private/tmp/durable-snapshot-before-final-review.txt";
const SNAPSHOT_AFTER =
  process.env.RALPH_EVIDENCE_SNAPSHOT_AFTER ??
  "/private/tmp/durable-snapshot-after-final-review.txt";
const OUT =
  process.env.RALPH_EVIDENCE_OUT ??
  "scripts/fixtures/execution-backend-failover-dashboard-20260916.json";

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function optionalJson(path) {
  try {
    return await json(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function aggregate(files) {
  const canonical = files
    .map(({ path, hash }) => `${path} ${hash}`)
    .sort()
    .join("\n");
  return sha256(canonical);
}

function parseSnapshot(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    map.set(match[2].replace(/^\.\//, ""), match[1]);
  }
  return map;
}

const runState = await json(join(RUN_DIR, "RUN_STATE.json"));
const telemetry = await json(join(RUN_DIR, "telemetry.json"));
const obligations = await json(join(RUN_DIR, "OBLIGATIONS.json"));
const supervisor = await optionalJson(join(RUN_DIR, "SUPERVISOR_STATE.json"));
const projectState = await json(
  "/private/tmp/edu-ops-dashboard-ralph-run/.ralph/chief/PROJECT_STATE.json"
);

const rounds = [];
for (let round = 1; round <= runState.round; round += 1) {
  const dir = join(RUN_DIR, "rounds", String(round).padStart(3, "0"));
  let entries = [];
  try {
    entries = (await readdir(dir)).sort();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const checkpoint = await optionalJson(join(dir, "checkpoint.json"));
  const review = await optionalJson(join(dir, "review_decision.json"));
  const finalReview = await optionalJson(
    join(dir, "final_review_decision.json")
  );
  const gate = await optionalJson(join(dir, "machine_gate.json"));
  rounds.push({
    round,
    artifacts: entries,
    base_sha: checkpoint?.base_sha ?? null,
    head_sha: checkpoint?.head_sha ?? null,
    expected_tree_sha: checkpoint?.expected_tree_sha ?? null,
    pushed: checkpoint?.pushed ?? null,
    gate_required_passed: gate?.required_gate_passed ?? null,
    gate_policy_passed: gate?.policy_passed ?? null,
    gate_passed: gate?.passed ?? null,
    review_action: review?.action ?? null,
    final_review_action: finalReview?.action ?? null,
    chief_backend: entries.includes("codex-chief-review.ndjson")
      ? "HOST_CODEX"
      : "EXTERNAL_AGENT",
  });
}

const beforePaths = parseSnapshot(await readFile(SNAPSHOT_BEFORE, "utf8"));
const afterPaths = parseSnapshot(await readFile(SNAPSHOT_AFTER, "utf8"));

const historicalRounds = [];
for (const round of rounds) {
  if (round.round >= runState.round) continue;
  const prefix = `rounds/${String(round.round).padStart(3, "0")}/`;
  const collect = (map) =>
    [...map.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, hash]) => ({
        path: relative(RUN_DIR, join(RUN_DIR, path)).replace(/\\/g, "/"),
        hash,
      }));
  const before = collect(beforePaths);
  const after = collect(afterPaths);
  historicalRounds.push({
    round: round.round,
    file_count: before.length,
    aggregate_hash_before: aggregate(before),
    aggregate_hash_after: aggregate(after),
    unchanged: aggregate(before) === aggregate(after),
  });
}

const failover = {
  run_id: runState.run_id,
  triggered_at_round: 2,
  phase: "CHIEF_REVIEW",
  task_id: "dashboard-android-widget-p0",
  original_backend: "HOST_CODEX",
  failure_class: "QUOTA_EXHAUSTED",
  failure_class_evidence: "operator_reported",
  durable_failure_signals: {
    chief_provider: telemetry.chief_provider,
    selected_route: telemetry.review_chief_route?.selected_route,
    external_warm_code: telemetry.review_chief_route?.external_warm?.code,
    external_recovery_attempted:
      telemetry.review_chief_route?.external_recovery?.attempted,
    host_attempt_duration_ms: telemetry.review_chief_route?.duration,
    waiting_for_chief_started_at: telemetry.waiting_for_chief_started_at,
    chief_wait_budget_exhausted: telemetry.chief_wait_budget_exhausted ?? null,
  },
  selected_backend: "EXTERNAL_AGENT",
  same_run_id: true,
  same_phase: "CHIEF_REVIEW",
  same_task_id: "dashboard-android-widget-p0",
  takeover_rounds: rounds
    .filter((round) => round.chief_backend === "EXTERNAL_AGENT")
    .map((round) => round.round),
  supervisor_spin: supervisor
    ? {
        restart_count: supervisor.restart_count,
        event_count: (supervisor.events ?? []).length,
        parked_phase: supervisor.events?.at(-1)?.phase ?? null,
        parked_status: supervisor.events?.at(-1)?.status ?? null,
      }
    : null,
};

const fixture = {
  version: 1,
  source: "real production run, anonymized (run-relative paths only)",
  anonymized: true,
  run: {
    run_id: runState.run_id,
    task_id: "dashboard-android-widget-p0",
    project_id: projectState.project_id,
    started_at: runState.started_at,
    final_phase: runState.phase,
    final_status: runState.status,
    final_round: runState.round,
    final_head_sha: rounds.at(-1)?.head_sha ?? null,
    final_tree_sha: rounds.at(-1)?.expected_tree_sha ?? null,
    obligations: obligations.obligations.map((item) => ({
      id: item.id,
      status: item.status,
    })),
  },
  phase_chain: rounds.map((round) => ({
    round: round.round,
    chief_backend: round.chief_backend,
    review_action: round.review_action,
    final_review_action: round.final_review_action,
  })),
  rounds,
  historical_rounds_unchanged: historicalRounds,
  backend_failover: failover,
};

await writeFile(OUT, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
process.stdout.write(
  `wrote ${OUT}\n` +
    `rounds=${rounds.length} historical_unchanged=${historicalRounds.every((item) => item.unchanged)}\n` +
    `final=${fixture.run.final_phase}/${fixture.run.final_status} head=${fixture.run.final_head_sha?.slice(0, 7)}\n`
);
