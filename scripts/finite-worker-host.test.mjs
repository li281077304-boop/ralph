import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  finiteWorkerArgs,
  runFiniteCodexWorker,
} from "../packages/core/dist/index.js";

function fakeChild(lines, code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => {
    for (const line of lines)
      child.stdout.emit("data", `${JSON.stringify(line)}\n`);
    child.emit("close", code, null);
  });
  return child;
}

test("finite worker uses one host Codex invocation and consumes final JSONL message", async () => {
  let invocation;
  const root = await mkdtemp(join(tmpdir(), "ralph-finite-worker-"));
  const logPath = join(root, ".ralph", "worker.ndjson");
  const result = await runFiniteCodexWorker({
    projectRoot: root,
    prompt: "do the task",
    logPath,
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    spawn(binary, args, options) {
      invocation = { binary, args, options };
      return fakeChild([
        { type: "thread.started", thread_id: "t1" },
        {
          type: "item.completed",
          item: { type: "agent_message", text: "done" },
        },
        { type: "turn.completed" },
      ]);
    },
  });
  assert.equal(result.text, "done");
  assert.equal(invocation.binary, "codex");
  assert.equal(invocation.options.cwd, root);
  assert.ok(invocation.args.includes("exec"));
  assert.ok(invocation.args.includes("--json"));
  assert.ok(invocation.args.includes("--ephemeral"));
  assert.ok(invocation.args.includes("workspace-write"));
  assert.ok(!invocation.args.includes("docker"));
  assert.match(await readFile(logPath, "utf8"), /turn\.completed/);
});

test("finite worker arguments keep approval and sandbox flags top-level", () => {
  const args = finiteWorkerArgs({
    projectRoot: "/repo",
    model: "m",
    reasoningEffort: "high",
    prompt: "p",
  });
  assert.deepEqual(args.slice(0, 8), [
    "--ask-for-approval",
    "never",
    "--sandbox",
    "workspace-write",
    "exec",
    "--json",
    "--ephemeral",
    "-C",
  ]);
  assert.equal(args.at(-1), "p");
});
