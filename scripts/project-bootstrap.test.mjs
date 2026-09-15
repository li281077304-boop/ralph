import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadObligationLedger,
  loadProjectStateFromProject,
  loadRunState,
} from "../packages/core/dist/index.js";

test("project bootstrap writes canonical state into the target repo, not cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-project-bootstrap-"));
  const outside = await mkdtemp(join(tmpdir(), "ralph-bootstrap-cwd-"));
  const taskFile = join(outside, "tasks.json");
  await writeFile(
    taskFile,
    JSON.stringify([
      {
        id: "task-a",
        title: "A",
        goal: "Inspect evidence",
        priority: 1,
        acceptance: ["read source"],
        verification: ["report"],
        evidence: ["README"],
        source: "README",
      },
    ])
  );
  execFileSync(
    process.execPath,
    [
      join(process.cwd(), "scripts/bootstrap-project.mjs"),
      "--repo",
      root,
      "--run-id",
      "bootstrap-test",
      "--goal",
      "Imported evidence goal",
      "--task-file",
      taskFile,
    ],
    { cwd: outside, encoding: "utf8" }
  );
  const project = await loadProjectStateFromProject(root);
  const run = await loadRunState(
    join(root, ".ralph/chief-runs/bootstrap-test/RUN_STATE.json")
  );
  const ledger = await loadObligationLedger(root, "bootstrap-test");
  assert.equal(project.goal, "Imported evidence goal");
  assert.equal(project.tasks[0].id, "task-a");
  assert.equal(run.phase, "SELECT");
  assert.equal(ledger.obligations.length, 1);
  await assert.rejects(
    readFile(join(outside, ".ralph/chief/PROJECT_STATE.json"))
  );
});
