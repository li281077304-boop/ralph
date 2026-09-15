import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NativeCodexGoalTransport,
  pauseGoalForShutdown,
  runNativeGoalWorker,
} from "../packages/core/dist/index.js";

async function fakeCodex(root, mode) {
  const path = join(root, `${mode}.mjs`);
  await writeFile(
    path,
    `#!/usr/bin/env node
import readline from "node:readline";
let polls = 0; let paused = false;
const rl = readline.createInterface({input:process.stdin});
function reply(id, result) { process.stdout.write(JSON.stringify({id,result})+"\\n"); }
rl.on("line", line => { const req=JSON.parse(line); const p=req.params||{};
  if (req.method === "initialize") { reply(req.id, {}); ${mode === "exit" ? "setTimeout(() => process.exit(17), 5);" : ""} return; }
  if (req.method === "thread/start") return reply(req.id, {thread:{id:"thread-1"}});
  if (req.method === "thread/resume") return reply(req.id, {});
  if (req.method === "thread/goal/get") {
    polls += 1;
    const status = paused ? "paused" : ${mode === "complete" ? "(polls > 1 ? 'complete' : 'active')" : "'active'"};
    return reply(req.id, {goal:{threadId:p.threadId,objective:"objective",status,tokensUsed:polls*100,timeUsedSeconds:polls}});
  }
  if (req.method === "thread/goal/set") { paused = p.status === "paused"; return reply(req.id, {goal:{threadId:p.threadId,objective:"objective",status:p.status||"active"}}); }
});
`,
    "utf8"
  );
  await chmod(path, 0o755);
  return path;
}

test("lost terminal notification is reconciled by polling getGoal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-goal-live-"));
  const binary = await fakeCodex(root, "complete");
  const transport = await NativeCodexGoalTransport.create(binary);
  await transport.initialize();
  const observations = [];
  const result = await transport.waitForGoal("thread-1", 2_000, {
    pollIntervalMs: 100,
    onObservation: (observation) => observations.push(observation),
  });
  assert.equal(result.goal.status, "complete");
  assert.ok(observations.length >= 1);
  await transport.close();
});

test("active Goal with no progress is classified as stalled and paused", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-goal-stall-"));
  const binary = await fakeCodex(root, "active");
  const transport = await NativeCodexGoalTransport.create(binary);
  await transport.initialize();
  let tick = 0;
  try {
    await assert.rejects(
      transport.waitForGoal("thread-1", 2_000, {
        pollIntervalMs: 100,
        stallAfterMs: 1,
        now: () => ++tick,
        progressProbe: () => false,
      }),
      /GOAL_STALLED:NO_MEANINGFUL_PROGRESS/
    );
  } finally {
    await transport.close();
  }
});

test("app-server exit is surfaced instead of an unbounded wait", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-goal-disconnect-"));
  const binary = await fakeCodex(root, "exit");
  const transport = await NativeCodexGoalTransport.create(binary);
  try {
    await transport.initialize();
    await assert.rejects(
      transport.waitForGoal("thread-1", 1_000, {
        pollIntervalMs: 100,
        stallAfterMs: 10_000,
      }),
      /NATIVE_GOAL_TRANSPORT_DISCONNECTED|reconnect failed/
    );
  } finally {
    await transport.close();
  }
});

test("token growth without observable progress still stalls", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-goal-token-stall-"));
  const binary = await fakeCodex(root, "active-growth");
  const transport = await NativeCodexGoalTransport.create(binary);
  await transport.initialize();
  let tick = 0;
  try {
    await assert.rejects(
      transport.waitForGoal("thread-1", 2_000, {
        pollIntervalMs: 100,
        stallAfterMs: 1,
        now: () => ++tick,
        progressProbe: () => false,
      }),
      /GOAL_STALLED:NO_MEANINGFUL_PROGRESS/
    );
  } finally {
    await transport.close();
  }
});

test("controlled shutdown explicitly pauses and confirms the Goal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-goal-shutdown-"));
  const binary = await fakeCodex(root, "active");
  const transport = await NativeCodexGoalTransport.create(binary);
  await transport.initialize();
  try {
    const paused = await pauseGoalForShutdown(transport, "thread-1");
    assert.equal(paused.status, "paused");
  } finally {
    await transport.close();
  }
});

test("runNativeGoalWorker persists goal_liveness evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-goal-evidence-"));
  const binary = await fakeCodex(root, "complete");
  const result = await runNativeGoalWorker({
    projectRoot: root,
    runId: "run-1",
    round: 1,
    taskId: "task-1",
    prompt: "objective",
    transport: await NativeCodexGoalTransport.create(binary),
    goalPollIntervalMs: 100,
  });
  assert.equal(result.error, undefined);
  const liveness = JSON.parse(
    await readFile(
      join(
        root,
        ".ralph",
        "chief-runs",
        "run-1",
        "rounds",
        "001",
        "goal_liveness.json"
      ),
      "utf8"
    )
  );
  assert.equal(liveness.thread_id, "thread-1");
  assert.equal(liveness.last_goal_status, "complete");
  assert.equal(liveness.transport_connected, true);
});
