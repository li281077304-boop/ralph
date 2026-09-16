import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runV3Supervisor } from "../apps/cli/bin/ralph-v3-supervisor.js";

const fixture = join(
  process.cwd(),
  "scripts/supervisor-fixture-controller.mjs"
);
const execFileAsync = promisify(execFile);

for (const scenario of ["worker", "chief", "gate"]) {
  test(`supervisor resumes after controller kill at ${scenario} boundary`, async () => {
    const root = await mkdtemp(join(tmpdir(), `ralph-supervisor-${scenario}-`));
    const runDir = join(root, ".ralph", "chief-runs", `run-${scenario}`);
    await mkdir(runDir, { recursive: true });
    const runId = `run-${scenario}`;
    await writeFile(
      join(runDir, "RUN_STATE.json"),
      `${JSON.stringify({ version: 1, run_id: runId, phase: "SELECT", status: "running", round: 1, current_task_id: "task-1", started_at: new Date().toISOString(), updated_at: new Date().toISOString() }, null, 2)}\n`
    );
    const attempts = join(runDir, "attempts.txt");
    const result = await runV3Supervisor({
      projectRoot: root,
      runId,
      controller: fixture,
      controllerArgs: [],
      maxRestarts: 2,
      restartDelayMs: 0,
      stdio: "ignore",
      spawnImpl: undefined,
      childEnv: {
        RALPH_FIXTURE_RUN_STATE: join(runDir, "RUN_STATE.json"),
        RALPH_FIXTURE_ATTEMPTS: attempts,
        RALPH_FIXTURE_SCENARIO: scenario,
      },
    });
    assert.equal(result.status, "DONE");
    assert.equal(result.restartCount, 1);
    assert.equal(result.events.length, 2);
    assert.equal(result.events[0].exit.signal, "SIGKILL");
    assert.equal(await readFile(attempts, "utf8"), "2");
    const supervisorState = JSON.parse(
      await readFile(join(runDir, "SUPERVISOR_STATE.json"), "utf8")
    );
    assert.equal(supervisorState.restart_count, 1);
    assert.equal(supervisorState.events.length, 2);
  });
}

test("public ralph-v3 entrypoint is supervised by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-public-entry-"));
  const runId = "public-entry";
  const runDir = join(root, ".ralph", "chief-runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "RUN_STATE.json"),
    `${JSON.stringify({ version: 1, run_id: runId, phase: "SELECT", status: "running", round: 1, current_task_id: "task-1", started_at: new Date().toISOString(), updated_at: new Date().toISOString() }, null, 2)}\n`
  );
  const attempts = join(runDir, "attempts.txt");
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(process.cwd(), "apps/cli/bin/ralph-v3.js"),
      "--repo",
      root,
      "--run-id",
      runId,
      "--config",
      "unused.yaml",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        RALPH_V3_CONTROLLER: fixture,
        RALPH_FIXTURE_RUN_STATE: join(runDir, "RUN_STATE.json"),
        RALPH_FIXTURE_ATTEMPTS: attempts,
        RALPH_FIXTURE_SCENARIO: "worker",
      },
      encoding: "utf8",
    }
  );
  assert.match(stdout, /SUPERVISOR_DONE restarts=1/);
  assert.equal(await readFile(attempts, "utf8"), "2");
});
