import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRecentDevlogContext,
  createDevlogHandoff,
  validateDevlogHandoff,
  validateSemanticContext,
  writeDevlogDecision,
  writeDevlogResult,
} from "../packages/core/dist/index.js";
import { runCodexTask } from "./codex-task.mjs";

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const semanticContext = [
  "USER OBSERVATION",
  "The user needs a durable formal development handoff.",
  "CONFIRMED FACT",
  "The target repository and current baseline are known.",
  "TECHNICAL ASSESSMENT",
  "The gate must reject empty or template-only discussion context.",
  "REJECTED ASSUMPTIONS",
  "A present file does not prove substantive context.",
  "DECISION",
  "Persist, read back, and validate context before invoking an Agent.",
  "UNKNOWN / OPEN RISKS",
  "Provider behavior remains an open operational risk.",
].join("\n");

test("semantic context gate rejects missing, placeholder, and incomplete formal context", () => {
  assert.throws(() => validateSemanticContext(""), /DEVLOG_CONTEXT_REQUIRED/);
  assert.throws(
    () =>
      validateSemanticContext(
        "USER OBSERVATION\nA real observation is recorded."
      ),
    /DEVLOG_CONTEXT_SECTION_MISSING/
  );
  assert.throws(
    () =>
      validateSemanticContext(
        "USER OBSERVATION\nN/A\nCONFIRMED FACT\nN/A\nTECHNICAL ASSESSMENT\nN/A\nREJECTED ASSUMPTIONS\nN/A\nDECISION\nN/A\nUNKNOWN / OPEN RISKS\nN/A"
      ),
    /DEVLOG_CONTEXT_SECTION_NOT_SUBSTANTIVE/
  );
  assert.doesNotThrow(() => validateSemanticContext(semanticContext));
});

test("devlog handoff is durable and hash-bound before invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-devlog-"));
  const task = "exact task text\n";
  const entry = await createDevlogHandoff({
    root,
    date: "2026-09-15",
    slug: "contract",
    mode: "minimal",
    context: "USER OBSERVATION\nnot a confirmed fact",
    agentTask: task,
    runId: "run-1",
    round: 1,
    taskId: "task-1",
  });
  await validateDevlogHandoff(entry);
  assert.equal(await readFile(entry.agentTaskPath, "utf8"), task);
  assert.equal((await readFile(entry.taskHashPath, "utf8")).trim(), hash(task));
  const metadata = JSON.parse(await readFile(entry.metadataPath, "utf8"));
  assert.equal(metadata.run_id, "run-1");
  assert.equal(metadata.task_id, "task-1");
  assert.equal(metadata.mode, "minimal");
  await writeDevlogResult(
    entry,
    "TESTED\nREAL-UAT-VERIFIED: NOT-YET-VERIFIED\n"
  );
  await writeDevlogDecision(entry, "CONFIRMED\nopen risk\n");
  assert.equal(await readFile(entry.agentTaskPath, "utf8"), task);
  assert.equal((await stat(entry.resultPath)).isFile(), true);
  const recent = await buildRecentDevlogContext(root);
  assert.match(recent, /2026-09-15/);
  assert.match(recent, /USER OBSERVATION/);
  assert.match(recent, /not a confirmed fact/);
});

test("formal task without semantic context fails closed before spawning", async () => {
  let spawnCount = 0;
  await assert.rejects(
    runCodexTask({
      repoRoot: await mkdtemp(join(tmpdir(), "ralph-formal-context-")),
      task: "formal task must have discussion context",
      spawnImpl: () => {
        spawnCount += 1;
        throw new Error("spawned unexpectedly");
      },
    }),
    /DEVLOG_CONTEXT_REQUIRED/
  );
  assert.equal(spawnCount, 0);
});

test("default devlog root follows repo, not the launching cwd", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "ralph-codex-repo-"));
  const outside = await mkdtemp(join(tmpdir(), "ralph-codex-cwd-"));
  let observedArgs;
  const spawnImpl = (_binary, args) => {
    observedArgs = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const previous = process.cwd();
  process.chdir(outside);
  try {
    const result = await runCodexTask({
      repoRoot,
      task: "read-only repo smoke",
      spawnImpl,
      date: "2026-09-15",
      minimalContext: true,
    });
    assert.equal(result.entry.root, repoRoot);
    assert.equal(existsSync(join(repoRoot, "devlog")), true);
    assert.equal(existsSync(join(outside, "devlog")), false);
    assert.equal(observedArgs.at(-1), "read-only repo smoke");
  } finally {
    process.chdir(previous);
  }
});

test("devlog does not elevate Codex permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-codex-policy-"));
  let observedArgs;
  const spawnImpl = (_binary, args) => {
    observedArgs = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  await runCodexTask({
    repoRoot: root,
    task: "policy smoke",
    spawnImpl,
    minimalContext: true,
  });
  assert.equal(
    observedArgs.includes("--dangerously-bypass-approvals-and-sandbox"),
    false
  );
  assert.equal(observedArgs.includes("--ask-for-approval"), false);
  assert.equal(observedArgs.includes("--sandbox"), false);
});

test("fresh context reads historical conclusions with a deterministic bound", async () => {
  const root = process.cwd();
  const recent = await buildRecentDevlogContext(root, {
    limit: 3,
    maxChars: 16_000,
  });
  assert.match(recent, /status=active/);
  assert.match(recent, /file picker/);
  assert.match(recent, /真实 Payroll UAT 尚未重新运行/);
  assert.ok(recent.length <= 16_000);
});

test("devlog write failure prevents direct Codex invocation", async () => {
  let spawnCount = 0;
  await assert.rejects(
    runCodexTask({
      repoRoot: "/tmp",
      task: "must not run",
      devlogRoot: "/dev/null",
      spawnImpl: () => {
        spawnCount += 1;
        throw new Error("spawned unexpectedly");
      },
      minimalContext: true,
    }),
    /DEVLOG_HANDOFF_WRITE_FAILED/
  );
  assert.equal(spawnCount, 0);
});

test("direct Codex launcher invokes only after validated handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-codex-task-"));
  let spawnCount = 0;
  let observedTask;
  const spawnImpl = (_binary, args) => {
    spawnCount += 1;
    observedTask = args.at(-1);
    assert.equal(
      existsSync(join(root, "devlog")),
      true,
      "devlog must exist before spawn"
    );
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const result = await runCodexTask({
    repoRoot: root,
    task: "exact invocation payload",
    devlogRoot: root,
    spawnImpl,
    minimalContext: true,
  });
  assert.equal(spawnCount, 1);
  assert.equal(observedTask, "exact invocation payload");
  await validateDevlogHandoff(result.entry);
  assert.equal(
    (await readFile(result.entry.taskHashPath, "utf8")).trim(),
    hash(observedTask)
  );
});
