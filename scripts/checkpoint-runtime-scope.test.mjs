import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GitGuard,
  isControllerOwnedPath,
  workspaceFingerprint,
} from "../packages/core/dist/index.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "ralph-checkpoint-scope-"));
  git(root, ["init", "-q", "-b", "feature/test"]);
  git(root, ["config", "user.email", "ralph@example.test"]);
  git(root, ["config", "user.name", "Ralph Test"]);
  await writeFile(join(root, "README.md"), "base\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

test("controller-owned runtime paths are excluded from product fingerprints", async () => {
  assert.equal(isControllerOwnedPath(".ralph/RUN_STATE.json"), true);
  assert.equal(isControllerOwnedPath("devlog/001/context.md"), true);
  assert.equal(isControllerOwnedPath("src/product.ts"), false);

  const root = await repo();
  const guard = new GitGuard(root);
  const before = guard.snapshot();
  await mkdir(join(root, ".ralph"), { recursive: true });
  await mkdir(join(root, "devlog"), { recursive: true });
  await writeFile(join(root, ".ralph/RUN_STATE.json"), '{"phase":"WORKER"}\n');
  await writeFile(join(root, "devlog/001-context.md"), "runtime evidence\n");
  const runtimeOnly = guard.snapshot();
  assert.deepEqual(guard.changedPaths(before, runtimeOnly), []);
  assert.deepEqual(
    workspaceFingerprint(before),
    workspaceFingerprint(runtimeOnly)
  );

  await writeFile(join(root, "src-product.txt"), "product change\n");
  const productAndRuntime = guard.snapshot();
  assert.deepEqual(guard.changedPaths(before, productAndRuntime), [
    "src-product.txt",
  ]);
  assert.notDeepEqual(
    workspaceFingerprint(before),
    workspaceFingerprint(productAndRuntime)
  );
});
