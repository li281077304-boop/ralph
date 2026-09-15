import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { createIsolatedWorktree } from "../packages/core/dist/index.js";
import {
  createExternalFirstChiefTransport,
  workConfig,
} from "../apps/cli/bin/ralph-chief-v3-loop.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("V3 worker defaults to a finite stage turn", () => {
  assert.equal(workConfig({ worker: { agent: "codex" } }).worker.mode, "stage");
  assert.equal(
    workConfig({ worker: { agent: "codex", mode: "native_goal" } }).worker.mode,
    "native_goal"
  );
});

test("isolated worktree starts at an explicit base and leaves original untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-isolation-test-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-qm", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, "README.md"), "user change\n");
  const before = await readFile(join(root, "README.md"), "utf8");
  const isolated = await createIsolatedWorktree({
    projectRoot: root,
    runId: "finite-test",
    baseCommit: base,
  });
  assert.equal(isolated.baseCommit, base);
  assert.equal(git(isolated.worktreePath, ["rev-parse", "HEAD"]), base);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), before);
  assert.match(git(root, ["status", "--porcelain"]), /README\.md/);
});

test("External Chief failure automatically falls back to Host Sol", async () => {
  const calls = [];
  const transport = createExternalFirstChiefTransport({
    primary: async () => {
      calls.push("external");
      throw new Error("transport timeout");
    },
    fallback: async () => {
      calls.push("host-sol");
      return { reply: "ok" };
    },
  });
  assert.deepEqual(await transport({ message: "task" }), { reply: "ok" });
  assert.deepEqual(calls, ["external", "host-sol"]);
});
