import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultChiefConfig,
  finiteWorkerArgs,
  summarizeUsageLedger,
} from "../packages/core/dist/index.js";
import { runCodexTask } from "./codex-task.mjs";
import {
  createExternalFirstChiefTransport,
  workConfig,
} from "../apps/cli/bin/ralph-chief-v3-loop.js";

function fakeChild(lines = []) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    for (const line of lines)
      child.stdout.emit("data", `${JSON.stringify(line)}\n`);
    child.emit("exit", 0, null);
  });
  return child;
}

test("model economics defaults ordinary development and Worker to Luna", () => {
  const config = defaultChiefConfig();
  assert.equal(config.worker.model, "gpt-5.6-luna");
  assert.equal(
    workConfig({ worker: { agent: "codex" } }).worker.model,
    "gpt-5.6-luna"
  );
  assert.equal(
    workConfig({ worker: { agent: "codex" } }).worker.reasoning_effort,
    "medium"
  );
  const workerArgs = finiteWorkerArgs({ projectRoot: "/repo", prompt: "work" });
  assert.equal(workerArgs[workerArgs.indexOf("--model") + 1], "gpt-5.6-luna");
});

test("codex-task explicitly selects Luna by default and Sol only for chief role", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-model-economics-"));
  const calls = [];
  const spawnImpl = (_binary, args) => {
    calls.push(args);
    return fakeChild([
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
    ]);
  };
  await runCodexTask({
    repoRoot: root,
    task: "worker",
    spawnImpl,
    date: "2026-09-15",
    minimalContext: true,
  });
  await runCodexTask({
    repoRoot: root,
    task: "chief",
    role: "chief",
    spawnImpl,
    date: "2026-09-15",
    minimalContext: true,
  });
  await runCodexTask({
    repoRoot: root,
    task: "override",
    model: "custom-model",
    spawnImpl,
    date: "2026-09-15",
    minimalContext: true,
  });
  assert.equal(calls[0][calls[0].indexOf("--model") + 1], "gpt-5.6-luna");
  assert.equal(calls[1][calls[1].indexOf("--model") + 1], "gpt-5.6-sol");
  assert.equal(calls[2][calls[2].indexOf("--model") + 1], "custom-model");
  assert.equal(
    calls[0].includes("--dangerously-bypass-approvals-and-sandbox"),
    false
  );
});

test("usage ledger records role/model/provider and token availability", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-model-ledger-"));
  await runCodexTask({
    repoRoot: root,
    task: "ledger",
    runId: "run-1",
    round: 2,
    spawnImpl: (_binary, _args) =>
      fakeChild([
        {
          type: "turn.completed",
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      ]),
    minimalContext: true,
  });
  const summary = await summarizeUsageLedger(root, "run-1");
  assert.equal(summary.invocation_count, 1);
  assert.equal(summary.luna_invocation_count, 1);
  assert.equal(summary.host_sol_count, 0);
  assert.equal(summary.by_role.codex_task, 1);
  const lines = await readFile(
    join(root, ".ralph", "chief-runs", "run-1", "usage-ledger.ndjson"),
    "utf8"
  );
  const entry = JSON.parse(lines.trim());
  assert.equal(entry.model, "gpt-5.6-luna");
  assert.equal(entry.provider, "codex");
  assert.equal(entry.total_tokens, 10);
  assert.equal(entry.tokens_available, true);
});

test("External Chief success avoids Host Sol and failure falls back exactly once", async () => {
  let external = 0;
  let hostSol = 0;
  const successful = createExternalFirstChiefTransport({
    primary: async () => {
      external += 1;
      return { reply: "pass" };
    },
    fallback: async () => {
      hostSol += 1;
      return { reply: "fallback" };
    },
  });
  assert.deepEqual(await successful({ message: "one" }), { reply: "pass" });
  assert.equal(external, 1);
  assert.equal(hostSol, 0);
  const failed = createExternalFirstChiefTransport({
    primary: async () => {
      external += 1;
      throw new Error("timeout");
    },
    fallback: async () => {
      hostSol += 1;
      return { reply: "fallback" };
    },
  });
  assert.deepEqual(await failed({ message: "two" }), { reply: "fallback" });
  assert.equal(hostSol, 1);
});
