import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GitGuard,
  MissingRequiredGateEvidenceError,
  evaluateRequiredGateEvidence,
  getChiefRunDir,
  getRoundDir,
  loadRunState,
  runCheckpointPhase,
  runV3WorkSlice,
  saveProjectStateToProject,
  saveRunState,
  syncObligationsFromProject,
  workspaceFingerprint,
} from "../packages/core/dist/index.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function remoteHead(cwd, remote, branch) {
  return execFileSync("git", ["ls-remote", "--heads", remote, branch], {
    cwd,
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)[0];
}

function task() {
  return {
    id: "task-1",
    title: "fixture task",
    goal: "fixture goal",
    status: "in_progress",
    priority: 10,
    dependencies: [],
    acceptance: ["a"],
    verification: ["v"],
    evidence: ["e"],
    source: "test",
    created_round: 1,
    updated_round: 1,
  };
}

function blankGateArtifact({ root, runId, phase = "MACHINE_GATE", round = 1 }) {
  const snapshot = new GitGuard(root).snapshot();
  return {
    version: 1,
    run_id: runId,
    round,
    phase,
    passed: false,
    commands: [],
    before_workspace_fingerprint: workspaceFingerprint(snapshot),
    after_workspace_fingerprint: workspaceFingerprint(snapshot),
    before_branch: snapshot.branch,
    after_branch: snapshot.branch,
    policy_passed: true,
    policy_violations: [],
    created_at: new Date().toISOString(),
  };
}

/**
 * Build a real Git repository with a real bare remote, a durable RUN_STATE and
 * a matching Worker evidence artifact, so the gate boundary can be exercised
 * end to end instead of against a mock.
 */
async function createRepo({
  runId = `gate-${Math.random().toString(16).slice(2, 10)}`,
  phase = "MACHINE_GATE",
  status = "running",
  gateArtifact,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ralph-gate-"));
  git(root, ["init", "-q", "-b", "feature/gate"]);
  git(root, ["config", "user.email", "ralph@example.test"]);
  git(root, ["config", "user.name", "Ralph Test"]);
  await writeFile(join(root, "README.md"), "# gate fixture\n");
  await writeFile(
    join(root, ".gitignore"),
    [
      "node_modules/",
      ".ralph/chief-runs/",
      ".ralph/chief/",
      ".ralph/chief-active-run.lock",
      "",
    ].join("\n")
  );
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "chore: fixture"]);
  const remote = await mkdtemp(join(tmpdir(), "ralph-gate-remote-"));
  git(remote, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-q", "-u", "origin", "feature/gate"]);

  const runDir = getChiefRunDir(root, runId);
  const roundDir = getRoundDir(runDir, 1);
  await mkdir(roundDir, { recursive: true });
  const now = new Date().toISOString();
  await saveRunState(join(runDir, "RUN_STATE.json"), {
    version: 1,
    run_id: runId,
    phase,
    status,
    round: 1,
    current_task_id: "task-1",
    started_at: now,
    updated_at: now,
  });
  await saveProjectStateToProject(root, {
    version: 1,
    project_id: "fixture",
    goal: "fixture goal",
    status: "active",
    current_milestone: "fixture milestone",
    current_task_id: "task-1",
    tasks: [task()],
    created_at: now,
    updated_at: now,
  });
  const snapshot = new GitGuard(root).snapshot();
  await writeFile(
    join(roundDir, "worker_evidence.json"),
    `${JSON.stringify(
      {
        version: 1,
        completed: true,
        run_id: runId,
        round: 1,
        task_id: "task-1",
        after_workspace_fingerprint: workspaceFingerprint(snapshot),
        after_branch: snapshot.branch,
        changed_paths: [],
      },
      null,
      2
    )}\n`
  );
  if (gateArtifact) {
    await writeFile(
      join(roundDir, "machine_gate.json"),
      `${JSON.stringify(
        {
          ...blankGateArtifact({ root, runId, phase, round: 1 }),
          ...gateArtifact,
        },
        null,
        2
      )}\n`
    );
  }
  return { root, remote, runId, runDir, roundDir };
}

function workConfig(commands) {
  return {
    commands,
    timeout_seconds: 30,
    gate_allowed_paths: [],
    required_clean_patterns: [],
    remote: "origin",
  };
}

async function readArtifact(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("policy_passed=true + required command exit 1 fails closed: no checkpoint, no commit, no push, no phase advance", async () => {
  const { root, remote, runId, runDir, roundDir } = await createRepo();
  const headBefore = git(root, ["rev-parse", "HEAD"]);
  const remoteBefore = remoteHead(root, "origin", "feature/gate");

  const result = await runV3WorkSlice({
    projectRoot: root,
    runId,
    config: workConfig(["exit 1"]),
  });

  assert.equal(result.runState.phase, "CHIEF_RECOVERY");
  assert.equal(result.runState.status, "running");
  assert.notEqual(result.runState.phase, "CHECKPOINT");
  assert.notEqual(result.runState.phase, "CHIEF_REVIEW");

  const artifact = await readArtifact(join(roundDir, "machine_gate.json"));
  assert.equal(artifact.policy_passed, true);
  assert.equal(artifact.passed, false);
  assert.equal(artifact.gate_outcome, "FAILED");
  assert.equal(artifact.required_gate_passed, false);
  assert.deepEqual(
    [...new Set(artifact.required_gate_failures.map((item) => item.code))],
    ["REQUIRED_COMMAND_FAILED"]
  );
  assert.equal(
    artifact.required_gate_failures[0].command,
    "exit 1",
    "the failing command must be named in durable evidence"
  );

  assert.equal(existsSync(join(roundDir, "checkpoint.json")), false);
  assert.equal(existsSync(join(roundDir, "checkpoint_intent.json")), false);
  assert.equal(git(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(remoteHead(root, "origin", "feature/gate"), remoteBefore);

  const durable = await loadRunState(join(runDir, "RUN_STATE.json"));
  assert.equal(durable.phase, "CHIEF_RECOVERY");
  assert.match(String(durable.failure_reason), /required command failure/);

  const obligations = await syncObligationsFromProject(root, runId);
  assert.equal(obligations.obligations[0].status, "TECHNICAL_OPEN");
});

test("required command timeout fails closed", async () => {
  const { root, remote, runId, roundDir } = await createRepo();
  const headBefore = git(root, ["rev-parse", "HEAD"]);
  const remoteBefore = remoteHead(root, "origin", "feature/gate");

  const result = await runV3WorkSlice({
    projectRoot: root,
    runId,
    config: { ...workConfig(["sleep 8"]), timeout_seconds: 1 },
  });

  assert.equal(result.runState.phase, "CHIEF_RECOVERY");
  const artifact = await readArtifact(join(roundDir, "machine_gate.json"));
  assert.equal(artifact.required_gate_passed, false);
  assert.deepEqual(
    artifact.required_gate_failures.map((item) => item.code),
    ["REQUIRED_COMMAND_TIMEOUT"]
  );
  assert.equal(existsSync(join(roundDir, "checkpoint.json")), false);
  assert.equal(git(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(remoteHead(root, "origin", "feature/gate"), remoteBefore);
});

test("a required command that never executed fails closed", async () => {
  const { root, runId, roundDir } = await createRepo();

  const result = await runV3WorkSlice({
    projectRoot: root,
    runId,
    config: workConfig(["exit 1", "true"]),
  });

  assert.equal(result.runState.phase, "CHIEF_RECOVERY");
  const artifact = await readArtifact(join(roundDir, "machine_gate.json"));
  assert.equal(artifact.required_commands.length, 2);
  const codes = artifact.required_gate_failures.map((item) => item.code);
  assert.ok(codes.includes("REQUIRED_COMMAND_FAILED"));
  assert.ok(
    codes.includes("REQUIRED_COMMAND_NOT_EXECUTED"),
    "a required command with no recorded result must be reported, not assumed"
  );
});

test("all required commands pass: checkpoint is allowed", async () => {
  const { root, remote, runId, roundDir } = await createRepo();
  const headBefore = git(root, ["rev-parse", "HEAD"]);

  const result = await runV3WorkSlice({
    projectRoot: root,
    runId,
    config: workConfig(["true"]),
  });

  assert.equal(result.runState.phase, "CHIEF_REVIEW");
  const artifact = await readArtifact(join(roundDir, "machine_gate.json"));
  assert.equal(artifact.required_gate_passed, true);
  assert.equal(artifact.gate_outcome, "PASS");
  assert.deepEqual(artifact.required_gate_failures, []);
  const checkpoint = await readArtifact(join(roundDir, "checkpoint.json"));
  assert.equal(checkpoint.pushed, true);
  assert.equal(checkpoint.gate_passed, true);
  assert.notEqual(git(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(
    remoteHead(root, "origin", "feature/gate"),
    checkpoint.head_sha,
    "the remote may only advance on a genuinely passing gate"
  );
});

test("REAL UAT: a failing required command blocks the run, survives a re-run, and only the repair re-gates to PASS", async () => {
  const { root, remote, runId, runDir, roundDir } = await createRepo();
  const statePath = join(runDir, "RUN_STATE.json");
  const headBefore = git(root, ["rev-parse", "HEAD"]);
  const remoteBefore = remoteHead(root, "origin", "feature/gate");

  // 1. A REQUIRED gate command genuinely fails (exit 1) while policy passes.
  const blocked = await runV3WorkSlice({
    projectRoot: root,
    runId,
    config: workConfig(["exit 1"]),
  });
  assert.equal(blocked.runState.phase, "CHIEF_RECOVERY");
  assert.equal(existsSync(join(roundDir, "checkpoint.json")), false);
  assert.equal(git(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(remoteHead(root, "origin", "feature/gate"), remoteBefore);
  assert.equal(
    (await syncObligationsFromProject(root, runId)).obligations[0].status,
    "TECHNICAL_OPEN"
  );

  // 2. The recovery loop sends the run back to the gate (RUN_MACHINE_GATE).
  //    Re-attempting it while the command is still broken must genuinely
  //    re-execute that command — the recorded failure is never reused as a
  //    verdict — and must stay blocked. Nothing may advance either.
  const parked = await loadRunState(statePath);
  await saveRunState(statePath, {
    ...parked,
    phase: "MACHINE_GATE",
    status: "running",
  });

  const again = await runV3WorkSlice({
    projectRoot: root,
    runId,
    config: workConfig(["exit 1"]),
  });
  assert.equal(again.runState.phase, "CHIEF_RECOVERY");
  assert.equal(
    again.gate?.commands[0].exitCode,
    1,
    "the command really re-ran"
  );
  assert.equal(existsSync(join(roundDir, "checkpoint.json")), false);
  assert.equal(git(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(remoteHead(root, "origin", "feature/gate"), remoteBefore);

  // 3. The operator repairs the command and the gate is attempted again.
  const parkedAgain = await loadRunState(statePath);
  await saveRunState(statePath, {
    ...parkedAgain,
    phase: "MACHINE_GATE",
    status: "running",
  });

  const repaired = await runV3WorkSlice({
    projectRoot: root,
    runId,
    config: workConfig(["true"]),
  });
  assert.equal(repaired.runState.phase, "CHIEF_REVIEW");

  const artifact = await readArtifact(join(roundDir, "machine_gate.json"));
  assert.equal(artifact.required_gate_passed, true);
  assert.equal(artifact.gate_outcome, "PASS");
  assert.deepEqual(artifact.required_commands, ["true"]);
  assert.deepEqual(artifact.required_gate_failures, []);

  const checkpoint = await readArtifact(join(roundDir, "checkpoint.json"));
  assert.equal(checkpoint.pushed, true);
  assert.notEqual(git(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(remoteHead(root, "origin", "feature/gate"), checkpoint.head_sha);
});

test("checkpoint refuses to run when the gate recorded required failures", async () => {
  const { root, remote, runId, roundDir } = await createRepo({
    phase: "CHECKPOINT",
    gateArtifact: {
      passed: false,
      policy_passed: true,
      policy_violations: [],
      required_commands: ["exit 1"],
      required_gate_passed: false,
      required_gate_failures: [
        {
          code: "REQUIRED_COMMAND_FAILED",
          command: "exit 1",
          detail: "exit 1",
        },
      ],
      gate_outcome: "FAILED",
      commands: [
        {
          command: "exit 1",
          kind: "required",
          exitCode: 1,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        },
      ],
    },
  });
  const headBefore = git(root, ["rev-parse", "HEAD"]);
  const remoteBefore = remoteHead(root, "origin", "feature/gate");

  await assert.rejects(
    runCheckpointPhase({
      projectRoot: root,
      runId,
      config: { remote: "origin" },
    }),
    /required commands did not pass/
  );

  assert.equal(existsSync(join(roundDir, "checkpoint.json")), false);
  assert.equal(existsSync(join(roundDir, "checkpoint_intent.json")), false);
  assert.equal(git(root, ["rev-parse", "HEAD"]), headBefore);
  assert.equal(remoteHead(root, "origin", "feature/gate"), remoteBefore);
});

test("checkpoint refuses gate evidence that has no required-command attestation", async () => {
  const { root, runId, roundDir } = await createRepo({
    phase: "CHECKPOINT",
    gateArtifact: {
      passed: true,
      policy_passed: true,
      policy_violations: [],
      commands: [],
    },
  });

  await assert.rejects(
    runCheckpointPhase({
      projectRoot: root,
      runId,
      config: { remote: "origin" },
    }),
    (error) => {
      assert.ok(error instanceof MissingRequiredGateEvidenceError);
      return true;
    }
  );
  assert.equal(existsSync(join(roundDir, "checkpoint.json")), false);
});

test("a legacy gate artifact is regenerated by re-executing commands, never trusted", async () => {
  const { root, runId, roundDir } = await createRepo({
    phase: "CHECKPOINT",
    gateArtifact: {
      passed: true,
      policy_passed: true,
      policy_violations: [],
      commands: [
        {
          command: "true",
          kind: "required",
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        },
      ],
    },
  });

  const rewound = await runV3WorkSlice({
    projectRoot: root,
    runId,
    config: workConfig(["true"]),
  });
  assert.equal(rewound.runState.phase, "MACHINE_GATE");

  const resumed = await runV3WorkSlice({
    projectRoot: root,
    runId,
    config: workConfig(["true"]),
  });
  assert.equal(resumed.runState.phase, "CHIEF_REVIEW");
  const artifact = await readArtifact(join(roundDir, "machine_gate.json"));
  assert.equal(artifact.required_gate_passed, true);
  assert.deepEqual(artifact.required_commands, ["true"]);
});

test("required gate evidence evaluator fails closed on missing, malformed and mismatched evidence", () => {
  const passing = (command) => ({
    command,
    kind: "required",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
  });

  const missing = evaluateRequiredGateEvidence(undefined, ["true"]);
  assert.equal(missing.ok, false);
  assert.deepEqual(
    missing.failures.map((item) => item.code),
    ["GATE_EVIDENCE_MISSING"]
  );

  const noCommands = evaluateRequiredGateEvidence({ passed: true }, ["true"]);
  assert.equal(noCommands.ok, false);
  assert.deepEqual(
    noCommands.failures.map((item) => item.code),
    ["GATE_EVIDENCE_MALFORMED"]
  );

  const notAnArray = evaluateRequiredGateEvidence({ commands: "true" }, [
    "true",
  ]);
  assert.equal(notAnArray.ok, false);
  assert.deepEqual(
    notAnArray.failures.map((item) => item.code),
    ["GATE_EVIDENCE_MALFORMED"]
  );

  const badExitCode = evaluateRequiredGateEvidence(
    { commands: [{ ...passing("true"), exitCode: "0" }] },
    ["true"]
  );
  assert.equal(badExitCode.ok, false);
  assert.deepEqual(
    badExitCode.failures.map((item) => item.code),
    ["GATE_EVIDENCE_MALFORMED"]
  );

  const missingTimedOut = evaluateRequiredGateEvidence(
    { commands: [{ command: "true", kind: "required", exitCode: 0 }] },
    ["true"]
  );
  assert.equal(missingTimedOut.ok, false);
  assert.deepEqual(
    missingTimedOut.failures.map((item) => item.code),
    ["GATE_EVIDENCE_MALFORMED"]
  );

  const neverExecuted = evaluateRequiredGateEvidence(
    { commands: [passing("a")] },
    ["a", "b"]
  );
  assert.equal(neverExecuted.ok, false);
  assert.deepEqual(
    neverExecuted.failures.map((item) => item.code),
    ["REQUIRED_COMMAND_NOT_EXECUTED"]
  );

  const drifted = evaluateRequiredGateEvidence(
    { commands: [passing("a"), passing("z")] },
    ["a"]
  );
  assert.equal(
    drifted.ok,
    true,
    "a gate may report extra passing commands without failing the gate"
  );

  const hiddenFailure = evaluateRequiredGateEvidence(
    {
      commands: [passing("a"), { ...passing("z"), exitCode: 1 }],
    },
    ["a"]
  );
  assert.equal(
    hiddenFailure.ok,
    false,
    "an extra recorded required command that failed can never be ignored"
  );
  assert.deepEqual(
    hiddenFailure.failures.map((item) => item.code),
    ["REQUIRED_COMMAND_FAILED"]
  );

  const recordedDrift = evaluateRequiredGateEvidence(
    { commands: [passing("a")], required_commands: ["old"] },
    ["a"]
  );
  assert.equal(recordedDrift.ok, false);
  assert.deepEqual(
    recordedDrift.failures.map((item) => item.code),
    ["REQUIRED_COMMAND_LIST_MISMATCH"]
  );

  const timeout = evaluateRequiredGateEvidence(
    { commands: [{ ...passing("a"), timedOut: true, exitCode: 124 }] },
    ["a"]
  );
  assert.equal(timeout.ok, false);
  assert.deepEqual(
    timeout.failures.map((item) => item.code),
    ["REQUIRED_COMMAND_TIMEOUT"]
  );

  const ok = evaluateRequiredGateEvidence(
    { commands: [passing("a"), passing("b")], required_commands: ["a", "b"] },
    ["a", "b"]
  );
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.failures, []);
  assert.deepEqual(ok.executed, ["a", "b"]);

  const deduplicated = evaluateRequiredGateEvidence(
    { commands: [passing("a")] },
    ["a", "a", " a "]
  );
  assert.deepEqual(deduplicated.configured, ["a"]);
  assert.equal(deduplicated.ok, true);

  const noRequirement = evaluateRequiredGateEvidence({ commands: [] }, []);
  assert.equal(noRequirement.ok, true);
});

test("fail-closed failures produce a stable signature for crash-loop reasoning", () => {
  const first = evaluateRequiredGateEvidence(undefined, ["a"]);
  const second = evaluateRequiredGateEvidence(undefined, ["a"]);
  assert.equal(first.signature, second.signature);
  const different = evaluateRequiredGateEvidence(
    {
      commands: [
        {
          command: "a",
          kind: "required",
          exitCode: 1,
          stdout: "",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        },
      ],
    },
    ["a"]
  );
  assert.notEqual(first.signature, different.signature);
});
