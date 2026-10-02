import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const runLoopMock = vi.hoisted(() => vi.fn());

vi.mock("../loop.js", () => ({
  runLoop: runLoopMock,
}));

import { runBin, type RunBinConfig } from "../run-bin.js";
import { recordAnchor } from "../v4/anchor-store.js";
import type { ProductAnchor } from "../v4/domain.js";

const stage = { name: "implementer", template: "afk.md" };

function config(takesInputArg: boolean): RunBinConfig {
  return {
    bin: takesInputArg ? "ralph-afk" : "ralph-ghafk",
    usage: takesInputArg ? "<plan-and-prd> <iterations>" : "<iterations>",
    desc: "test",
    stages: [stage],
    takesInputArg,
  };
}

afterEach(() => {
  runLoopMock.mockReset();
  delete process.env.RALPH_AGENT;
  delete process.env.RALPH_RUN_MODE;
  delete process.env.RALPH_WORKSPACE;
});

describe("runBin agent forwarding", () => {
  it("forwards explicit Codex settings for ralph-afk", async () => {
    await runBin(
      ["--agent", "codex", "--codex-user-config", "plan.md", "2"],
      config(true)
    );
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        codexUserConfig: true,
        inputs: "plan.md",
        iterations: 2,
      })
    );
  });

  it("forwards RALPH_AGENT for ralph-ghafk", async () => {
    process.env.RALPH_AGENT = "codex";
    await runBin(["2"], config(false));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        codexUserConfig: false,
        inputs: "",
        iterations: 2,
      })
    );
  });

  it("keeps Claude as the default", async () => {
    await runBin(["plan.md", "1"], config(true));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "claude",
        codexUserConfig: false,
      })
    );
  });

  it("rejects Codex user config with Claude", async () => {
    await expect(
      runBin(["--codex-user-config", "plan.md", "1"], config(true))
    ).rejects.toThrow(
      "--codex-user-config requires Codex; select it with --agent codex or RALPH_AGENT=codex"
    );
    expect(runLoopMock).not.toHaveBeenCalled();
  });
});

describe("runBin run-mode forwarding", () => {
  it("defaults to RALPH_V3 on the legacy path", async () => {
    await runBin(["plan.md", "1"], config(true));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ runMode: "RALPH_V3" })
    );
  });

  it("forwards RALPH_RUN_MODE from the environment", async () => {
    process.env.RALPH_RUN_MODE = "RALPH_V4";
    await runBin(["plan.md", "1"], config(true));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ runMode: "RALPH_V4" })
    );
  });

  it("reads an inline RUN_MODE declaration from the task input", async () => {
    await runBin(["RUN_MODE: RALPH_V4", "1"], config(true));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ runMode: "RALPH_V4" })
    );
  });

  it("reads the declaration from a plan file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-runmode-"));
    const plan = join(dir, "plan.md");
    await writeFile(plan, "# Plan\n\nRUN_MODE: RALPH_V4\n", "utf8");
    await runBin([plan, "1"], config(true));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ runMode: "RALPH_V4" })
    );
  });
});

describe("runBin V4 preflight gate", () => {
  function unrun(round: number): ProductAnchor {
    return {
      round,
      sha: `sha${round}`,
      user_value_delta: "none",
      product_artifact: "n/a",
      product_gate: "NOT_RUN",
      product_issues: [],
      goal_drift_check: "PASS",
      next_highest_value_action: "inspect the artifact",
    };
  }

  async function overdueWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ralph-v4-gate-"));
    await recordAnchor(dir, unrun(1), "default");
    await recordAnchor(dir, unrun(2), "default");
    return dir;
  }

  // The V4 rule set has to change what the runtime does, not just what it logs.
  it("refuses to start a V4 run whose product anchor is overdue", async () => {
    process.env.RALPH_WORKSPACE = await overdueWorkspace();
    process.env.RALPH_RUN_MODE = "RALPH_V4";
    await expect(runBin(["plan.md", "1"], config(true))).rejects.toThrow(
      /PRODUCT_ANCHOR_REQUIRED/
    );
    expect(runLoopMock).not.toHaveBeenCalled();
  });

  it("starts a V4 run whose anchor is not overdue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-v4-gate-"));
    process.env.RALPH_WORKSPACE = dir;
    process.env.RALPH_RUN_MODE = "RALPH_V4";
    await runBin(["plan.md", "1"], config(true));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ runMode: "RALPH_V4" })
    );
  });

  // Regression 9, at the seam: V3 must be unaffected by the same workspace.
  it("leaves the V3 path ungated by an overdue anchor", async () => {
    process.env.RALPH_WORKSPACE = await overdueWorkspace();
    await runBin(["plan.md", "1"], config(true));
    expect(runLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({ runMode: "RALPH_V3" })
    );
  });
});
