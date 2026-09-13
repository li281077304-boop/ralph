import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getChiefRunDir,
  inspectActiveWriterLock,
  runMachineGatePhase,
  runWorkerPhase,
  runV3WorkSlice,
  saveProjectStateToProject,
  saveRunState,
} from "../packages/core/dist/index.js";

const now = "2026-09-13T00:00:00.000Z";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixture(branch = "feature/test") {
  const root = await mkdtemp(join(tmpdir(), "ralph-v3-work-"));
  const bare = await mkdtemp(join(tmpdir(), "ralph-v3-work-remote-"));
  git(root, ["init", "-q", "-b", branch]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Ralph Test"]);
  await writeFile(join(root, ".gitignore"), ".ralph/\n");
  await writeFile(join(root, "app.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  git(bare, ["init", "-q", "--bare"]);
  git(root, ["remote", "add", "origin", bare]);
  git(root, ["push", "-q", "-u", "origin", branch]);
  const runId = `run-${Math.random().toString(16).slice(2)}`;
  await saveProjectStateToProject(root, {
    version: 1,
    project_id: "work-test",
    goal: "exercise worker gate checkpoint",
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
  return { root, bare, runId };
}

function config(overrides = {}) {
  return {
    worker: { agent: "codex" },
    commands: [],
    timeout_seconds: 10,
    gate_allowed_paths: [],
    required_clean_patterns: [],
    forbidden_paths: [],
    protected_paths: [],
    ...overrides,
  };
}

function changedPaths(root) {
  const paths = new Set(
    git(root, ["diff", "--name-only", "HEAD"]).split(/\r?\n/).filter(Boolean)
  );
  for (const line of git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ])
    .split(/\r?\n/)
    .filter(Boolean)) {
    const path = line.slice(3).trim();
    if (path && !path.includes(" -> ")) paths.add(path);
  }
  return [...paths].sort();
}

function workingTreeDiffHash(root) {
  return createHash("sha256")
    .update(
      `${git(root, ["diff", "--binary", "HEAD"])}\n${changedPaths(root).join("\n")}`
    )
    .digest("hex");
}

async function prepareCheckpoint(f, overrides = {}) {
  const workerConfig = config(overrides);
  await runWorkerPhase({
    projectRoot: f.root,
    runId: f.runId,
    config: workerConfig,
    runAgent:
      overrides.runAgent ??
      (async () => {
        await writeFile(join(f.root, "app.txt"), "worker\n");
        return { text: "done", meta: {} };
      }),
  });
  await runMachineGatePhase({
    projectRoot: f.root,
    runId: f.runId,
    config: workerConfig,
    runGate:
      overrides.runGate ?? (async () => ({ passed: true, commands: [] })),
  });
  return workerConfig;
}

test("V3 work runs fresh Worker, normal gate, and canonical pushed checkpoint", async () => {
  const f = await fixture();
  const calls = { worker: 0, uat: 0 };
  const result = await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    runAgent: async () => {
      calls.worker += 1;
      await writeFile(join(f.root, "app.txt"), "worker\n");
      return { text: "implemented", meta: {} };
    },
    runGate: async (_root, options) => {
      calls.uat += options.uatCommands?.length ?? 0;
      return { passed: true, commands: [] };
    },
  });
  assert.equal(calls.worker, 1);
  assert.equal(calls.uat, 0);
  assert.equal(result.runState.phase, "CHIEF_REVIEW");
  assert.equal(result.runState.current_task_id, "task-1");
  assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), "2");
  assert.equal(
    git(f.root, ["rev-parse", "HEAD"]),
    git(f.root, ["ls-remote", "--heads", "origin", "feature/test"]).split(
      /\s+/
    )[0]
  );
  assert.match(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "rounds/001/worker_prompt.md"),
      "utf8"
    ),
    /task-1/
  );
  assert.match(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "rounds/001/checkpoint.json"),
      "utf8"
    ),
    /pushed/
  );
  const checkpoint = JSON.parse(
    await readFile(
      join(getChiefRunDir(f.root, f.runId), "rounds/001/checkpoint.json"),
      "utf8"
    )
  );
  assert.match(checkpoint.gate_artifact_hash, /^[0-9a-f]{64}$/);
  assert.match(checkpoint.diff_hash, /^[0-9a-f]{64}$/);
  assert.equal((await inspectActiveWriterLock(f.root, f.runId)).kind, "none");
});

test("dirty workspace blocks Worker before invocation", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "preexisting.txt"), "user work\n");
  let calls = 0;
  const result = await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    runAgent: async () => {
      calls += 1;
      return { text: "bad", meta: {} };
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.runState.phase, "FAILED");
});

test("Worker commit and protected/forbidden edits fail closed", async () => {
  for (const mode of ["commit", "forbidden"]) {
    const f = await fixture();
    const result = await runV3WorkSlice({
      projectRoot: f.root,
      runId: f.runId,
      config: config({ forbidden_paths: ["secret.txt"] }),
      runAgent: async () => {
        if (mode === "commit") {
          await writeFile(join(f.root, "app.txt"), "worker\n");
          git(f.root, ["add", "app.txt"]);
          git(f.root, ["commit", "-qm", "forbidden worker commit"]);
        } else {
          await writeFile(join(f.root, "secret.txt"), "secret\n");
        }
        return { text: "done", meta: {} };
      },
    });
    assert.equal(result.runState.phase, "FAILED");
  }
});

test("Machine Gate command failure still reaches checkpoint with failed evidence", async () => {
  const f = await fixture();
  const result = await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    runAgent: async () => {
      await writeFile(join(f.root, "app.txt"), "worker\n");
      return { text: "done", meta: {} };
    },
    runGate: async () => ({
      passed: false,
      commands: [
        {
          command: "gate",
          kind: "required",
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          durationMs: 1,
          timedOut: false,
        },
      ],
    }),
  });
  assert.equal(result.runState.phase, "CHIEF_REVIEW");
  assert.equal(result.gate?.passed, false);
});

test("Gate tracked source mutation is a policy failure and never checkpoints", async () => {
  const f = await fixture();
  const result = await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    runAgent: async () => {
      await writeFile(join(f.root, "app.txt"), "worker\n");
      return { text: "done", meta: {} };
    },
    runGate: async () => {
      await writeFile(join(f.root, "app.txt"), "gate changed source\n");
      return { passed: true, commands: [] };
    },
  });
  assert.equal(result.runState.phase, "FAILED");
  assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), "1");
});

test("protected branch refuses checkpoint", async () => {
  const f = await fixture("main");
  await assert.rejects(
    runV3WorkSlice({
      projectRoot: f.root,
      runId: f.runId,
      config: config(),
      runAgent: async () => {
        await writeFile(join(f.root, "app.txt"), "worker\n");
        return { text: "done", meta: {} };
      },
    }),
    /protected branch/
  );
  assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), "1");
});

test("checkpoint recovery reuses the canonical commit without duplication", async () => {
  const f = await fixture();
  const first = await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
    runAgent: async () => {
      await writeFile(join(f.root, "app.txt"), "worker\n");
      return { text: "done", meta: {} };
    },
  });
  const head = git(f.root, ["rev-parse", "HEAD"]);
  const statePath = join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.phase = "CHECKPOINT";
  state.status = "running";
  await rm(join(getChiefRunDir(f.root, f.runId), "rounds/001/checkpoint.json"));
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const resumed = await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: config(),
  });
  assert.equal(first.runState.phase, "CHIEF_REVIEW");
  assert.equal(resumed.runState.phase, "CHIEF_REVIEW");
  assert.equal(git(f.root, ["rev-parse", "HEAD"]), head);
  assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), "2");
});

test("local checkpoint commit created before a crash is reused and pushed", async () => {
  const f = await fixture();
  const workerConfig = config();
  await runWorkerPhase({
    projectRoot: f.root,
    runId: f.runId,
    config: workerConfig,
    runAgent: async () => ({ text: "no-op", meta: {} }),
  });
  await runMachineGatePhase({
    projectRoot: f.root,
    runId: f.runId,
    config: workerConfig,
    runGate: async () => ({ passed: true, commands: [] }),
  });
  const runDir = getChiefRunDir(f.root, f.runId);
  const state = JSON.parse(
    await readFile(join(runDir, "RUN_STATE.json"), "utf8")
  );
  const base = git(f.root, ["rev-parse", "HEAD"]);
  const round = join(runDir, "rounds/001");
  const gatePath = join(round, "machine_gate.json");
  const gateBytes = await readFile(gatePath);
  const gateArtifact = JSON.parse(gateBytes);
  const intent = {
    version: 1,
    run_id: f.runId,
    round: 1,
    task_id: "task-1",
    base_sha: base,
    branch: "feature/test",
    remote: "origin",
    changed_paths: [],
    diff_hash: workingTreeDiffHash(f.root),
    gate_passed: true,
    gated_workspace_fingerprint: gateArtifact.after_workspace_fingerprint,
    gate_artifact_hash: createHash("sha256").update(gateBytes).digest("hex"),
    commit_subject: "ralph(v3): task-1 round 1",
    created_at: now,
  };
  await writeFile(
    join(round, "checkpoint_intent.json"),
    `${JSON.stringify(intent, null, 2)}\n`
  );
  git(f.root, [
    "commit",
    "--allow-empty",
    "-qm",
    `ralph(v3): task-1 round 1\n\nRalph-Run-ID: ${f.runId}\nRalph-Round: 1\nRalph-Task-ID: task-1`,
  ]);
  const resumed = await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: workerConfig,
  });
  assert.equal(resumed.runState.phase, "CHIEF_REVIEW");
  assert.equal(
    git(f.root, ["ls-remote", "--heads", "origin", "feature/test"]).split(
      /\s+/
    )[0],
    git(f.root, ["rev-parse", "HEAD"])
  );
  assert.equal(state.phase, "CHECKPOINT");
});

test("completed Worker evidence resumes from WORKER without rerunning the Worker", async () => {
  const f = await fixture();
  const workerConfig = config();
  await runWorkerPhase({
    projectRoot: f.root,
    runId: f.runId,
    config: workerConfig,
    runAgent: async () => {
      await writeFile(join(f.root, "app.txt"), "worker\n");
      return { text: "done", meta: {} };
    },
  });
  const statePath = join(getChiefRunDir(f.root, f.runId), "RUN_STATE.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.phase = "WORKER";
  state.status = "running";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const result = await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: workerConfig,
    runAgent: async () => {
      throw new Error("Worker must not be called during recovery");
    },
  });
  assert.equal(result.runState.phase, "CHIEF_REVIEW");
});

test("untracked content mutation after checkpoint intent fails closed", async () => {
  const f = await fixture();
  const workerConfig = await prepareCheckpoint(f, {
    runAgent: async () => {
      await writeFile(join(f.root, "app.txt"), "worker\n");
      await writeFile(join(f.root, "generated.txt"), "one\n");
      return { text: "done", meta: {} };
    },
  });
  const round = join(getChiefRunDir(f.root, f.runId), "rounds/001");
  const gatePath = join(round, "machine_gate.json");
  const gateBytes = await readFile(gatePath);
  const gateArtifact = JSON.parse(gateBytes);
  const base = git(f.root, ["rev-parse", "HEAD"]);
  await writeFile(
    join(round, "checkpoint_intent.json"),
    `${JSON.stringify(
      {
        version: 1,
        run_id: f.runId,
        round: 1,
        task_id: "task-1",
        base_sha: base,
        branch: "feature/test",
        remote: "origin",
        changed_paths: ["app.txt", "generated.txt"],
        diff_hash: workingTreeDiffHash(f.root),
        gate_passed: true,
        gated_workspace_fingerprint: gateArtifact.after_workspace_fingerprint,
        gate_artifact_hash: createHash("sha256")
          .update(gateBytes)
          .digest("hex"),
        commit_subject: "ralph(v3): task-1 round 1",
        created_at: now,
      },
      null,
      2
    )}\n`
  );
  await writeFile(join(f.root, "generated.txt"), "two\n");
  await assert.rejects(
    runV3WorkSlice({
      projectRoot: f.root,
      runId: f.runId,
      config: workerConfig,
    }),
    /workspace/
  );
  assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal((await inspectActiveWriterLock(f.root, f.runId)).kind, "none");
});

test("branch switch after Gate fails closed before checkpoint", async () => {
  const f = await fixture();
  const workerConfig = await prepareCheckpoint(f);
  git(f.root, ["checkout", "-q", "-b", "feature/other"]);
  await assert.rejects(
    runV3WorkSlice({
      projectRoot: f.root,
      runId: f.runId,
      config: workerConfig,
    }),
    /branch/
  );
  assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), "1");
  assert.equal((await inspectActiveWriterLock(f.root, f.runId)).kind, "none");
});

test("required_clean_patterns violation blocks checkpoint", async () => {
  const f = await fixture();
  const result = await runV3WorkSlice({
    projectRoot: f.root,
    runId: f.runId,
    config: config({ required_clean_patterns: ["app.txt"] }),
    runAgent: async () => {
      await writeFile(join(f.root, "app.txt"), "worker\n");
      return { text: "done", meta: {} };
    },
  });
  assert.equal(result.runState.phase, "FAILED");
  assert.match(result.runState.failure_reason ?? "", /required_clean/);
  assert.equal(git(f.root, ["rev-list", "--count", "HEAD"]), "1");
});

test("non-fast-forward remote rejection never force pushes", async () => {
  const f = await fixture();
  const workerConfig = await prepareCheckpoint(f);
  const divergent = await mkdtemp(join(tmpdir(), "ralph-v3-divergent-"));
  git(divergent, ["clone", "-q", "--branch", "feature/test", f.bare, "."]);
  git(divergent, ["config", "user.email", "other@example.com"]);
  git(divergent, ["config", "user.name", "Other"]);
  await writeFile(join(divergent, "remote.txt"), "remote\n");
  git(divergent, ["add", "."]);
  git(divergent, ["commit", "-qm", "remote divergence"]);
  git(divergent, ["push", "-q", "origin", "feature/test"]);
  const remoteBefore = git(f.root, [
    "ls-remote",
    "--heads",
    "origin",
    "feature/test",
  ]).split(/\s+/)[0];
  await assert.rejects(
    runV3WorkSlice({
      projectRoot: f.root,
      runId: f.runId,
      config: workerConfig,
    }),
    /push|rejected|remote/
  );
  assert.equal(
    git(f.root, ["ls-remote", "--heads", "origin", "feature/test"]).split(
      /\s+/
    )[0],
    remoteBefore
  );
  assert.equal((await inspectActiveWriterLock(f.root, f.runId)).kind, "none");
});

test("push failure releases the project writer lock", async () => {
  const f = await fixture();
  const workerConfig = await prepareCheckpoint(f);
  git(f.root, ["remote", "set-url", "origin", join(f.root, "missing-remote")]);
  await assert.rejects(
    runV3WorkSlice({
      projectRoot: f.root,
      runId: f.runId,
      config: workerConfig,
    }),
    /push|remote|does not exist/
  );
  assert.equal((await inspectActiveWriterLock(f.root, f.runId)).kind, "none");
});

test("post-commit dirty worktree blocks push", async () => {
  const f = await fixture();
  const workerConfig = await prepareCheckpoint(f);
  const hook = join(f.root, ".git", "hooks", "post-commit");
  await writeFile(hook, "#!/bin/sh\nprintf dirty > hook-dirty.txt\n");
  await chmod(hook, 0o755);
  const remoteBefore = git(f.root, [
    "ls-remote",
    "--heads",
    "origin",
    "feature/test",
  ]).split(/\s+/)[0];
  await assert.rejects(
    runV3WorkSlice({
      projectRoot: f.root,
      runId: f.runId,
      config: workerConfig,
    }),
    /worktree is not clean/
  );
  assert.notEqual(git(f.root, ["rev-parse", "HEAD"]), remoteBefore);
  assert.equal(
    git(f.root, ["ls-remote", "--heads", "origin", "feature/test"]).split(
      /\s+/
    )[0],
    remoteBefore
  );
  assert.equal((await inspectActiveWriterLock(f.root, f.runId)).kind, "none");
});
