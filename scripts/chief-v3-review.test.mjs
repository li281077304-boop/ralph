import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireActiveWriterLock,
  getChiefRunDir,
  releaseActiveWriterLock,
  runV3WorkSlice,
  saveProjectStateToProject,
  saveRunState,
} from "../packages/core/dist/index.js";
import {
  REVIEW_CLOSE_MARKER,
  REVIEW_OPEN_MARKER,
  chiefReviewPrompt,
  runV3ReviewTransport as runV3ReviewTransportImpl,
} from "../apps/cli/bin/ralph-chief-v3-review.js";

const now = "2026-09-13T00:00:00.000Z";
function runV3ReviewTransport(options) {
  return runV3ReviewTransportImpl({
    resolveRemoteUrl: () => "https://github.com/acme/ralph.git",
    ...options,
  });
}
function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function config() {
  return {
    worker: { agent: "codex" },
    commands: [],
    timeout_seconds: 10,
    gate_allowed_paths: [],
    required_clean_patterns: [],
    forbidden_paths: [],
    protected_paths: [],
  };
}
async function seed(gatePassed = true) {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-review-"));
  const bare = await mkdtemp(join(tmpdir(), "ralph-v3-review-remote-"));
  git(root, ["init", "-q", "-b", "feature/test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Ralph Test"]);
  await writeFile(join(root, ".gitignore"), ".ralph/\n");
  await writeFile(join(root, "app.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  git(bare, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", bare]);
  git(root, ["push", "-q", "-u", "origin", "feature/test"]);
  const runId = `review-${Math.random().toString(16).slice(2)}`;
  await saveProjectStateToProject(root, {
    version: 1,
    project_id: "review-test",
    goal: "review a checkpoint",
    status: "active",
    current_milestone: "m1",
    current_task_id: "task-1",
    tasks: [
      {
        id: "task-1",
        title: "change app",
        goal: "make the fixture change",
        status: "in_progress",
        priority: 1,
        dependencies: [],
        acceptance: ["app changes"],
        verification: ["gate"],
        evidence: ["fixture"],
        source: "test",
        created_round: 1,
        updated_round: 1,
      },
    ],
    created_at: now,
    updated_at: now,
  });
  await saveRunState(join(getChiefRunDir(root, runId), "RUN_STATE.json"), {
    run_id: runId,
    version: 1,
    phase: "WORKER",
    status: "running",
    round: 1,
    current_task_id: "task-1",
    started_at: now,
    updated_at: now,
  });
  const work = await runV3WorkSlice({
    projectRoot: root,
    runId,
    config: config(),
    runAgent: async () => {
      await writeFile(join(root, "app.txt"), "worker\n");
      return { text: "implemented", meta: {} };
    },
    runGate: async () => ({
      passed: gatePassed,
      commands: [
        {
          command: "pytest",
          kind: "required",
          exitCode: gatePassed ? 0 : 1,
          stdout: "",
          stderr: gatePassed ? "" : "failed",
          durationMs: 1,
          timedOut: false,
        },
      ],
    }),
  });
  const checkpointPath = join(
    getChiefRunDir(root, runId),
    "rounds/001/checkpoint.json"
  );
  // A failed REQUIRED command must not produce a checkpoint at all, so the
  // fixture only rewrites the remote URL when a checkpoint legitimately exists.
  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (checkpoint) {
    checkpoint.remote_url = "https://github.com/acme/ralph.git";
    await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  }
  return {
    root,
    bare,
    runId,
    work,
    checkpoint,
    resolveRemoteUrl: () => "https://github.com/acme/ralph.git",
  };
}
function decisionFromMessage(message, overrides = {}) {
  const value = (label) =>
    message.match(new RegExp(`${label}: ([^\\n]+)`))?.[1];
  return {
    action: "PASS",
    summary: "independent review complete",
    repo_reviewed: true,
    reviewed_repo: "acme/ralph",
    reviewed_base_sha: value("base_sha"),
    reviewed_head_sha: value("head_sha"),
    findings: [],
    patch_instructions: [],
    human_question: "",
    human_options: [],
    run_id: value("run_id"),
    round: Number(value("round")),
    handoff_hash: value("handoff_hash"),
    project_state_hash: value("project_state_hash"),
    checkpoint_hash: value("checkpoint_hash"),
    gate_artifact_hash: value("gate_artifact_hash"),
    ...overrides,
  };
}
function transport(calls, overrides = {}) {
  return async ({ message }) => {
    calls.count += 1;
    const decision = decisionFromMessage(message, overrides);
    return {
      reply: `${REVIEW_OPEN_MARKER}\n${JSON.stringify(decision)}\n${REVIEW_CLOSE_MARKER}`,
    };
  };
}

test("CHIEF_REVIEW prepares strict waiting handoff and PASS returns to SELECT", async () => {
  const f = await seed(true);
  const calls = { count: 0 };
  const result = await runV3ReviewTransport({
    projectRoot: f.root,
    runId: f.runId,
    transport: transport(calls),
  });
  assert.equal(calls.count, 1);
  assert.equal(result.runState.phase, "SELECT");
  assert.equal(result.runState.round, 2);
  assert.equal(result.projectState.current_task_id, null);
  assert.equal(result.projectState.tasks[0].status, "done");
  const round = join(getChiefRunDir(f.root, f.runId), "rounds/001");
  assert.match(
    await readFile(join(round, "review_handoff.md"), "utf8"),
    /GitHub/
  );
  assert.match(
    await readFile(join(round, "review_decision.json"), "utf8"),
    /repo_reviewed/
  );
});

test("V3 staged review routes Chief PASS to UAT and Final PASS to DONE", async () => {
  const f = await seed(true);
  const calls = { count: 0 };
  const chief = await runV3ReviewTransport({
    projectRoot: f.root,
    runId: f.runId,
    reviewStage: "chief",
    transport: transport(calls),
  });
  assert.equal(chief.runState.phase, "INTEGRATION_UAT");
  assert.equal(chief.projectState.tasks[0].status, "in_progress");
  const runPath = join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json");
  await saveRunState(runPath, {
    ...chief.runState,
    phase: "FINAL_REVIEW",
    status: "running",
  });
  const final = await runV3ReviewTransport({
    projectRoot: f.root,
    runId: f.runId,
    reviewStage: "final",
    transport: transport(calls),
  });
  assert.equal(final.runState.phase, "DONE");
  assert.equal(final.runState.status, "done");
  assert.equal(final.projectState.status, "done");
});

test("existing review handoff is reused and accepted recovery skips GUI", async () => {
  const f = await seed(true);
  const calls = { count: 0 };
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: async ({ message }) => {
        calls.count += 1;
        throw new Error("stop after handoff");
      },
    })
  );
  const waiting = JSON.parse(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json"),
      "utf8"
    )
  );
  assert.equal(waiting.phase, "WAITING_FOR_CHIEF");
  assert.equal(waiting.waiting_handoff.kind, "review");
  await runV3ReviewTransport({
    projectRoot: f.root,
    runId: f.runId,
    transport: transport(calls),
  });
  assert.equal(calls.count, 2);
  // Simulate a crash after the durable decision/transition artifacts were
  // accepted but before the RUN_STATE write became durable.
  await saveRunState(
    join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json"),
    waiting
  );
  await readFile(
    join(getChiefRunDir(f.root, f.runId), "rounds/001/review_decision.json"),
    "utf8"
  );
  assert.equal(waiting.round, 1);
  const recovered = await runV3ReviewTransport({
    projectRoot: f.root,
    runId: f.runId,
    transport: async () => {
      throw new Error("GUI must not run");
    },
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.guiCalls, 0);
});

test("a failed required gate command can never be reviewed: no checkpoint exists", async () => {
  const f = await seed(false);
  assert.equal(f.work.runState.phase, "CHIEF_RECOVERY");
  assert.equal(f.checkpoint, undefined);
  const calls = { count: 0 };
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: transport(calls),
    }),
    /Review requires CHIEF_REVIEW\/FINAL_REVIEW/
  );
  assert.equal(calls.count, 0, "no Chief call may happen without a checkpoint");
  const state = JSON.parse(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json"),
      "utf8"
    )
  );
  assert.equal(state.phase, "CHIEF_RECOVERY");
  assert.equal(state.round, 1);
});

test("PASS is rejected when durable Gate evidence says passed=false", async () => {
  const f = await seed(true);
  const roundDir = join(getChiefRunDir(f.root, f.runId), "rounds/001");
  const gatePath = join(roundDir, "machine_gate.json");
  const checkpointPath = join(roundDir, "checkpoint.json");
  const gate = JSON.parse(await readFile(gatePath, "utf8"));
  // Forge the strongest-looking evidence: policy and required attestation both
  // hold, yet the gate as a whole reports failure. PASS must still be refused.
  const forged = { ...gate, passed: false };
  const forgedBytes = `${JSON.stringify(forged, null, 2)}\n`;
  await writeFile(gatePath, forgedBytes);
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  checkpoint.gate_artifact_hash = createHash("sha256")
    .update(Buffer.from(forgedBytes, "utf8"))
    .digest("hex");
  await writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);

  const calls = { count: 0 };
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: transport(calls),
    }),
    /PASS requires Machine Gate/
  );
  const state = JSON.parse(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json"),
      "utf8"
    )
  );
  assert.equal(state.phase, "WAITING_FOR_CHIEF");
  assert.equal(state.round, 1);
});

test("PASS is rejected when the independent review has a blocking finding", async () => {
  const f = await seed(true);
  const calls = { count: 0 };
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: transport(calls, {
        findings: [{ severity: "blocking", detail: "unsafe", file: "app.txt" }],
      }),
    }),
    /blocking findings/
  );
  assert.equal(calls.count, 1);
  const state = JSON.parse(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json"),
      "utf8"
    )
  );
  assert.equal(state.phase, "WAITING_FOR_CHIEF");
});

test("review identity bindings reject stale coordinates", async () => {
  const cases = [
    ["reviewed_base_sha", "0".repeat(40), /reviewed_base_sha/],
    ["reviewed_head_sha", "1".repeat(40), /reviewed_head_sha/],
    ["checkpoint_hash", "2".repeat(64), /checkpoint_hash/],
    ["gate_artifact_hash", "3".repeat(64), /gate_artifact_hash/],
    ["project_state_hash", "4".repeat(64), /project_state_hash/],
    ["handoff_hash", "5".repeat(64), /handoff_hash/],
  ];
  for (const [field, value, expected] of cases) {
    const f = await seed(true);
    await assert.rejects(
      runV3ReviewTransport({
        projectRoot: f.root,
        runId: f.runId,
        transport: transport({ count: 0 }, { [field]: value }),
      }),
      expected
    );
  }
});

test("a concurrent project writer prevents Review GUI calls", async () => {
  const f = await seed(true);
  const owner = await acquireActiveWriterLock(f.root, {
    run_id: "other-run",
    run_state_path: join(f.root, ".ralph", "other", "RUN_STATE.json"),
  });
  const calls = { count: 0 };
  try {
    await assert.rejects(
      runV3ReviewTransport({
        projectRoot: f.root,
        runId: f.runId,
        transport: transport(calls),
      }),
      /active writer lock/
    );
    assert.equal(calls.count, 0);
  } finally {
    await releaseActiveWriterLock(f.root, owner);
  }
});

test("malformed Review replies preserve WAITING_FOR_CHIEF", async () => {
  const f = await seed(true);
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: async () => ({ reply: "not a machine block" }),
    }),
    /Reply marker is missing/
  );
  const state = JSON.parse(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json"),
      "utf8"
    )
  );
  assert.equal(state.phase, "WAITING_FOR_CHIEF");
});

test("external Chief timeout evidence is durably recorded for recovery", async () => {
  const f = await seed(true);
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: async () => {
        throw new Error("stop after handoff");
      },
    })
  );
  const timeout = Object.assign(new Error("assistant timeout"), {
    chief_request_attempts: 2,
    chief_existing_reply_recoveries: 1,
    chief_timeouts: 2,
    chief_last_attempt_at: now,
  });
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: async () => {
        throw timeout;
      },
    }),
    /assistant timeout/
  );
  const evidence = JSON.parse(
    await readFile(
      join(
        getChiefRunDir(f.root, f.runId),
        "rounds/001/external_chief_transport.json"
      ),
      "utf8"
    )
  );
  assert.equal(evidence.chief_request_attempts, 2);
  assert.equal(evidence.chief_existing_reply_recoveries, 1);
  assert.equal(evidence.chief_timeouts, 2);
  assert.equal(evidence.chief_last_attempt_at, now);
});

test("waiting Review revalidates current remote identity before GUI", async () => {
  const f = await seed(true);
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: async () => {
        throw new Error("stop after handoff");
      },
    })
  );
  git(f.root, [
    "remote",
    "set-url",
    "origin",
    "https://github.com/acme/ralph.git",
  ]);
  git(f.root, [
    "config",
    `url.${f.bare}.insteadOf`,
    "https://github.com/acme/ralph.git",
  ]);
  const calls = { count: 0 };
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      resolveRemoteUrl: () => git(f.root, ["remote", "get-url", "origin"]),
      transport: transport(calls),
    }),
    /github\.com remote|current Git remote repository/
  );
  assert.equal(calls.count, 0);
});

test("effective non-GitHub remote fails closed before GUI", async () => {
  const f = await seed(true);
  const calls = { count: 0 };
  await assert.rejects(
    runV3ReviewTransportImpl({
      projectRoot: f.root,
      runId: f.runId,
      transport: transport(calls),
    }),
    /github.com remote/
  );
  assert.equal(calls.count, 0);
});

test("effective GitHub repository mismatch fails closed before GUI", async () => {
  const f = await seed(true);
  const calls = { count: 0 };
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      resolveRemoteUrl: () => "https://github.com/other/ralph.git",
      transport: transport(calls),
    }),
    /current Git remote repository/
  );
  assert.equal(calls.count, 0);
});

test("modified waiting Review handoff is rejected before GUI", async () => {
  const f = await seed(true);
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: async () => {
        throw new Error("stop after handoff");
      },
    })
  );
  const handoffPath = join(
    getChiefRunDir(f.root, f.runId),
    "rounds/001/review_handoff.md"
  );
  await writeFile(
    handoffPath,
    `${await readFile(handoffPath, "utf8")}tampered\n`
  );
  const calls = { count: 0 };
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: transport(calls),
    }),
    /handoff content has changed/
  );
  assert.equal(calls.count, 0);
});

test("corrupted Review transition journals fail closed", async () => {
  const variants = [
    ["after_project_state", /project hash is invalid/],
    ["after_run_state", /run hash is invalid/],
    ["action", /action does not match/],
  ];
  for (const [field, expected] of variants) {
    const f = await seed(true);
    await assert.rejects(
      runV3ReviewTransport({
        projectRoot: f.root,
        runId: f.runId,
        transport: async () => {
          throw new Error("stop after handoff");
        },
      })
    );
    const waiting = JSON.parse(
      await readFile(
        join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json"),
        "utf8"
      )
    );
    await runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: transport({ count: 0 }),
    });
    await saveRunState(
      join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json"),
      waiting
    );
    const transitionPath = join(
      getChiefRunDir(f.root, f.runId),
      "rounds/001/review_transition.json"
    );
    const transition = JSON.parse(await readFile(transitionPath, "utf8"));
    if (field === "after_project_state")
      transition.after_project_state.goal = "tampered";
    if (field === "after_run_state")
      transition.after_run_state.updated_at = "2020-01-01T00:00:00.000Z";
    if (field === "action") transition.action = "PATCH";
    await writeFile(transitionPath, JSON.stringify(transition, null, 2) + "\n");
    await assert.rejects(
      runV3ReviewTransport({
        projectRoot: f.root,
        runId: f.runId,
        transport: async () => {
          throw new Error("GUI must not run");
        },
      }),
      expected
    );
  }
});

test("PATCH keeps task active, advances round, and reaches Worker with patch context", async () => {
  const f = await seed(true);
  const calls = { count: 0 };
  const result = await runV3ReviewTransport({
    projectRoot: f.root,
    runId: f.runId,
    transport: transport(calls, {
      action: "PATCH",
      patch_instructions: ["fix app behavior"],
    }),
  });
  assert.equal(result.runState.phase, "WORKER");
  assert.equal(result.runState.round, 2);
  assert.equal(result.projectState.current_task_id, "task-1");
  assert.equal(result.projectState.tasks[0].status, "in_progress");
  await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    runAgent: async (_stage, prompt) => {
      assert.match(prompt, /fix app behavior/);
      return { text: "patched", meta: {} };
    },
    runGate: async () => ({ passed: true, commands: [] }),
  });
});

test("PASS review context cannot authorize a Worker continuation", async () => {
  const f = await seed(true);
  await runV3ReviewTransport({
    projectRoot: f.root,
    runId: f.runId,
    transport: transport({ count: 0 }),
  });
  const runPath = join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  await saveRunState(runPath, {
    ...run,
    phase: "WORKER",
    status: "running",
    round: 2,
    current_task_id: "task-1",
  });
  let invoked = 0;
  await assert.rejects(
    runV3WorkSlice({
      projectRoot: f.root,
      runId: f.runId,
      config: config(),
      runAgent: async () => {
        invoked += 1;
        return { text: "should not run", meta: {} };
      },
      runGate: async () => ({ passed: true, commands: [] }),
    })
  );
  assert.equal(invoked, 0);
});

test("Final Review PATCH takes precedence over an earlier PASS when resuming Worker", async () => {
  const f = await seed(true);
  const runPath = join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json");
  const run = JSON.parse(await readFile(runPath, "utf8"));
  const roundDir = join(getChiefRunDir(f.root, f.runId), "rounds/001");
  const binding = "a".repeat(64);
  await writeFile(
    join(roundDir, "review_decision.json"),
    JSON.stringify({
      action: "PASS",
      run_id: f.runId,
      round: 1,
      handoff_hash: binding,
      project_state_hash: binding,
      checkpoint_hash: binding,
      gate_artifact_hash: binding,
      reviewed_repo: "acme/ralph",
      reviewed_base_sha: binding,
      reviewed_head_sha: binding,
      repo_reviewed: true,
      findings: [],
      patch_instructions: [],
      human_question: "",
      human_options: [],
      summary: "pass",
    }) + "\n"
  );
  await writeFile(
    join(roundDir, "final_review_decision.json"),
    JSON.stringify({
      action: "PATCH",
      run_id: f.runId,
      round: 1,
      handoff_hash: binding,
      project_state_hash: binding,
      checkpoint_hash: binding,
      gate_artifact_hash: binding,
      reviewed_repo: "acme/ralph",
      reviewed_base_sha: binding,
      reviewed_head_sha: binding,
      repo_reviewed: true,
      findings: [],
      patch_instructions: ["fix the final review finding"],
      human_question: "",
      human_options: [],
      summary: "patch",
    }) + "\n"
  );
  await saveRunState(runPath, {
    ...run,
    phase: "WORKER",
    status: "running",
    round: 2,
    current_task_id: "task-1",
  });
  let prompt = "";
  await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    runAgent: async (_stage, workerPrompt) => {
      prompt = workerPrompt;
      await writeFile(join(f.root, "app.txt"), "patched\n");
      return { text: "patched", meta: {} };
    },
    runGate: async () => ({ passed: true, commands: [] }),
  });
  assert.match(prompt, /fix the final review finding/);
});

test("PATCH continuation rejects a previous checkpoint for another task", async () => {
  const f = await seed(true);
  await runV3ReviewTransport({
    projectRoot: f.root,
    runId: f.runId,
    transport: transport(
      { count: 0 },
      { action: "PATCH", patch_instructions: ["fix"] }
    ),
  });
  const checkpointPath = join(
    getChiefRunDir(f.root, f.runId),
    "rounds/001/checkpoint.json"
  );
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  checkpoint.task_id = "other-task";
  await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2) + "\n");
  let invoked = 0;
  await assert.rejects(
    runV3WorkSlice({
      projectRoot: f.root,
      runId: f.runId,
      config: config(),
      runAgent: async () => {
        invoked += 1;
        return { text: "should not run", meta: {} };
      },
      runGate: async () => ({ passed: true, commands: [] }),
    }),
    /task continuity/
  );
  assert.equal(invoked, 0);
});

test("HUMAN_REQUIRED pauses without changing round or task", async () => {
  const f = await seed(true);
  const result = await runV3ReviewTransport({
    projectRoot: f.root,
    runId: f.runId,
    transport: transport(
      { count: 0 },
      {
        action: "HUMAN_REQUIRED",
        human_question: "Choose policy",
        human_options: ["A"],
      }
    ),
  });
  assert.equal(result.runState.phase, "HUMAN_REQUIRED");
  assert.equal(result.runState.status, "paused");
  assert.equal(result.runState.round, 1);
  assert.equal(result.projectState.tasks[0].status, "in_progress");
});

test("wrong repository and stale remote are rejected before acceptance", async () => {
  const f = await seed(true);
  const wrong = { count: 0 };
  await assert.rejects(
    runV3ReviewTransport({
      projectRoot: f.root,
      runId: f.runId,
      transport: transport(wrong, { reviewed_repo: "other/repo" }),
    }),
    /reviewed_repo/
  );
  const calls = { count: 0 };
  await runV3ReviewTransport({
    projectRoot: f.root,
    runId: f.runId,
    transport: async ({ message }) => {
      calls.count += 1;
      const clone = await mkdtemp(join(tmpdir(), "ralph-v3-review-move-"));
      git(clone, ["clone", "-q", "--branch", "feature/test", f.bare, "."]);
      git(clone, ["config", "user.email", "move@example.com"]);
      git(clone, ["config", "user.name", "Move"]);
      await writeFile(join(clone, "remote.txt"), "moved\n");
      git(clone, ["add", "."]);
      git(clone, ["commit", "-qm", "move remote"]);
      git(clone, ["push", "-q", "origin", "feature/test"]);
      const decision = decisionFromMessage(message);
      return {
        reply: `${REVIEW_OPEN_MARKER}\n${JSON.stringify(decision)}\n${REVIEW_CLOSE_MARKER}`,
      };
    },
  }).catch((error) => assert.match(String(error), /remote/));
  assert.equal(calls.count, 1);
});
