import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseChiefReview, parseExternalChiefVerdict } from "../chief.js";
import { loadChiefConfig } from "../chief-config.js";
import { GitGuard } from "../git-guard.js";
import { runMachineGate } from "../machine-gate.js";
import { STAGES } from "../stages.js";

describe("Chief review contract", () => {
  it.each(["PASS", "PATCH", "RETURN", "HUMAN_REQUIRED"])(
    "accepts the %s verdict",
    (verdict) => {
      expect(
        parseChiefReview(
          JSON.stringify({
            verdict,
            summary: "summary",
            reasoning_summary: "reasoning",
            worker_task: verdict === "RETURN" ? "revisit" : "",
            human_question: verdict === "HUMAN_REQUIRED" ? "choose" : "",
            human_options: [],
            risk: "low",
            next_step: "continue",
          })
        )
      ).toEqual({
        verdict,
        summary: "summary",
        reasoning_summary: "reasoning",
        worker_task: verdict === "RETURN" ? "revisit" : "",
        human_question: verdict === "HUMAN_REQUIRED" ? "choose" : "",
        human_options: [],
        risk: "low",
        next_step: "continue",
      });
    }
  );

  it("rejects an invalid verdict instead of treating it as PASS", () => {
    expect(
      parseChiefReview('{"verdict":"DONE","summary":"ok"}')
    ).toBeUndefined();
    expect(parseChiefReview("not json")).toBeUndefined();
  });

  it("accepts only the compact external verdict schema", () => {
    expect(
      parseExternalChiefVerdict(
        JSON.stringify({
          verdict: "RETURN",
          summary: "needs one more fix",
          worker_task: "fix it",
          human_question: "",
          human_options: [],
          next_step: "resume",
          run_id: "run-1",
          iteration: 1,
          handoff_hash: "a".repeat(64),
        })
      )?.verdict
    ).toBe("RETURN");
    expect(parseExternalChiefVerdict('{"verdict":"PASS"}')).toBeUndefined();
    expect(
      parseExternalChiefVerdict(
        JSON.stringify({
          verdict: "PASS",
          summary: "ok",
          worker_task: "",
          human_question: "",
          human_options: [],
          next_step: "done",
          run_id: "run-1",
          iteration: 1,
          handoff_hash: "a".repeat(64),
          extra: "do not accept",
        })
      )
    ).toBeUndefined();
  });
});

describe("Chief machine gate and Git Guard", () => {
  it("captures independent gate output and fails on a command error", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-chief-gate-"));
    const result = await runMachineGate(workspace, {
      commands: [
        "node -e \"process.stdout.write('pass')\"",
        "node -e \"process.stderr.write('failure'); process.exit(7)\"",
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.commands[0]).toMatchObject({ exitCode: 0, stdout: "pass" });
    expect(result.commands[1]).toMatchObject({
      exitCode: 7,
      stderr: "failure",
    });
  });

  it("detects a Worker edit to ACCEPTANCE, CHIEF, or DECISIONS", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-chief-guard-"));
    for (const name of ["ACCEPTANCE.md", "CHIEF.md", "DECISIONS.md"]) {
      await writeFile(join(workspace, name), "original\n");
    }
    const guard = new GitGuard(workspace, {
      protectedPaths: ["ACCEPTANCE.md", "CHIEF.md", "DECISIONS.md"],
    });
    const before = guard.snapshot();
    await writeFile(join(workspace, "CHIEF.md"), "changed\n");
    expect(guard.violations(before)).toEqual([
      { kind: "protected", path: "CHIEF.md" },
    ]);
  });

  it("does not recurse through .git or Ralph run artifacts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-chief-walk-"));
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, ".ralph"));
    await writeFile(join(workspace, ".git", "secret"), "ignored");
    await writeFile(join(workspace, ".ralph", "state.json"), "ignored");
    const guard = new GitGuard(workspace, { forbiddenPaths: ["*"] });
    expect(guard.snapshot().files.size).toBe(0);
  });

  it("does not snapshot ignored directories in a Git worktree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-chief-ignore-"));
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
    await writeFile(join(workspace, ".gitignore"), "ignored/\n");
    await writeFile(join(workspace, "tracked.txt"), "tracked\n");
    await mkdir(join(workspace, "ignored"), { recursive: true });
    await writeFile(join(workspace, "ignored", "huge.bin"), "ignored\n");
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: workspace });
    const snapshot = new GitGuard(workspace).snapshot();
    expect(snapshot.files.has("ignored/huge.bin")).toBe(false);
    expect(snapshot.trackedFiles.has("tracked.txt")).toBe(true);
  });

  it("fails when a machine gate modifies tracked source", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-chief-gate-source-"));
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
    await writeFile(join(workspace, "source.txt"), "before\n");
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: workspace });
    const result = await runMachineGate(workspace, {
      commands: [
        "node -e \"require('fs').writeFileSync('source.txt','after\\n')\"",
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.trackedChanges).toContain("source.txt");
  });

  it("enforces configured diff-growth limits", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-chief-diff-"));
    const guard = new GitGuard(workspace, { maxChangedPaths: 1 });
    const before = guard.snapshot();
    await writeFile(join(workspace, "one.txt"), "one\n");
    await writeFile(join(workspace, "two.txt"), "two\n");
    expect(guard.violations(before)).toContainEqual({
      kind: "large-diff",
      path: "2 changed paths",
    });
  });

  it("loads Chief Sol defaults and stage-specific YAML settings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-chief-config-"));
    const path = join(workspace, "ACCEPTANCE.yaml");
    await writeFile(
      path,
      [
        "chief_mode: external",
        "max_iterations: 4",
        "max_diff_bytes: 42",
        "chief:",
        "  agent: codex",
        "  model: gpt-5.6-sol",
        "  reasoning_effort: high",
        "worker:",
        "  agent: codex",
        "  model: gpt-5.6-terra",
      ].join("\n")
    );
    const config = loadChiefConfig(path);
    expect(config.chief_mode).toBe("external");
    expect(config.max_iterations).toBe(4);
    expect(config.max_diff_bytes).toBe(42);
    expect(config.chief).toMatchObject({
      agent: "codex",
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
    });
    expect(config.worker.model).toBe("gpt-5.6-terra");
  });

  it("loads the optional external Chief GUI bridge settings", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-chief-gui-config-"));
    const path = join(workspace, "ACCEPTANCE.yaml");
    await writeFile(
      path,
      [
        "chief_mode: external",
        "gui_bridge:",
        "  enabled: true",
        "  conversation_url: https://chatgpt.com/c/fixed-chief",
        "  session: chrome",
        "  extension_env_file: ~/.config/playwright-mcp/env",
        "  timeout_ms: 180000",
      ].join("\n")
    );
    expect(loadChiefConfig(path).gui_bridge).toEqual({
      enabled: true,
      conversation_url: "https://chatgpt.com/c/fixed-chief",
      session: "chrome",
      extension_env_file: "~/.config/playwright-mcp/env",
      timeout_ms: 180000,
    });
  });

  it("keeps sensitive data patterns forbidden by default", () => {
    expect(loadChiefConfig().forbidden_paths).toEqual(
      expect.arrayContaining(["real_data/", "*.xlsx", "*.xls"])
    );
  });
});

describe("stage safety defaults", () => {
  it("keeps Chief as a separately configurable stage", () => {
    expect(STAGES.chief).toMatchObject({ name: "chief", template: "chief.md" });
    expect(STAGES.chief.model).toBeUndefined();
    expect(STAGES.chief.agent).toBeUndefined();
  });
});
