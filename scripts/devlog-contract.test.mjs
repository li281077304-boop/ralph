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
  writeDevlogDecision,
  writeDevlogResult,
} from "../packages/core/dist/index.js";
import { runCodexTask } from "./codex-task.mjs";

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("devlog handoff is durable and hash-bound before invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-devlog-"));
  const task = "exact task text\n";
  const entry = await createDevlogHandoff({
    root,
    date: "2026-09-15",
    slug: "contract",
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
  await writeDevlogResult(
    entry,
    "TESTED\nREAL-UAT-VERIFIED: NOT-YET-VERIFIED\n"
  );
  await writeDevlogDecision(entry, "CONFIRMED\nopen risk\n");
  assert.equal(await readFile(entry.agentTaskPath, "utf8"), task);
  assert.equal((await stat(entry.resultPath)).isFile(), true);
  assert.match(await buildRecentDevlogContext(root), /2026-09-15/);
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
  });
  assert.equal(spawnCount, 1);
  assert.equal(observedTask, "exact invocation payload");
  await validateDevlogHandoff(result.entry);
  assert.equal(
    (await readFile(result.entry.taskHashPath, "utf8")).trim(),
    hash(observedTask)
  );
});
