import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ActiveWriterLockError,
  PHASE_REGISTRY,
  acquireActiveWriterLock,
  activeWriterLockPath,
  assertProjectState,
  clearStaleActiveWriterLock,
  dispatchPhase,
  getRoundArtifactPath,
  getRoundDir,
  getChiefRunDir,
  hydrateRunState,
  inspectActiveWriterLock,
  isRunnablePhase,
  loadRunState,
  parseProjectState,
  parseRunState,
  releaseActiveWriterLock,
  roundName,
  saveRunState,
  writeJsonAtomic,
  type ProjectState,
  type RunState,
} from "../index.js";

const timestamp = "2026-09-13T00:00:00.000Z";
function run(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: "run-1",
    version: 1,
    phase: "SELECT",
    status: "running",
    round: 1,
    current_task_id: null,
    started_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}
function project(): ProjectState {
  return {
    version: 1,
    project_id: "p-1",
    goal: "goal",
    status: "active",
    current_milestone: "m1",
    current_task_id: "t1",
    tasks: [
      {
        id: "t1",
        title: "task",
        status: "queued",
        priority: 1,
        dependencies: [],
        acceptance: ["gate"],
        evidence: [],
        source: "user",
        created_round: 1,
        updated_round: 1,
      },
    ],
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("Chief V3 durable foundation", () => {
  it("round-trips strict run and project state separately", () => {
    expect(parseRunState(run())).toEqual(run());
    expect(parseProjectState(project()).project_id).toBe("p-1");
    expect(() => parseRunState({ ...run(), version: 2 })).toThrow(/version/);
    expect(() => parseRunState({ ...run(), phase: "NOPE" })).toThrow(/phase/);
    expect(() => parseRunState({ ...run(), unexpected: true })).toThrow(
      /unknown/
    );
    expect(() =>
      parseRunState({ ...run(), phase: "DONE", status: "running" })
    ).toThrow(/DONE/);
    expect(() =>
      parseRunState({
        ...run(),
        waiting_handoff: {
          handoff_path: "x",
          handoff_hash: "h",
          created_at: timestamp,
        },
      })
    ).toThrow(/waiting_handoff/);
    expect(() =>
      assertProjectState({ ...project(), current_task_id: "missing" })
    ).toThrow(/current_task_id/);
    expect(() => parseProjectState(run())).toThrow(/Invalid durable state/);
  });

  it("atomically saves, reloads, and preserves the exact current phase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-v3-state-"));
    const path = join(dir, "RUN_STATE.json");
    await saveRunState(path, run({ phase: "CHIEF_REVIEW", round: 2 }));
    expect(await loadRunState(path)).toMatchObject({
      phase: "CHIEF_REVIEW",
      round: 2,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty(
      "version",
      1
    );
    await writeFile(path, "{broken", "utf8");
    await expect(loadRunState(path)).rejects.toThrow();
    expect(() =>
      hydrateRunState(JSON.stringify(run({ phase: "MACHINE_GATE" })))
    ).not.toThrow();
  });

  it("uses deterministic round artifact paths", () => {
    const runDir = "/tmp/run";
    expect(getChiefRunDir("/repo", "abc")).toBe("/repo/.ralph/chief-runs/abc");
    expect(() => getChiefRunDir("/repo", "../escape")).toThrow();
    expect(roundName(1)).toBe("001");
    expect(getRoundDir(runDir, 2)).toBe("/tmp/run/rounds/002");
    expect(getRoundArtifactPath(runDir, 2, "review")).toBe(
      "/tmp/run/rounds/002/review.json"
    );
    expect(() => roundName(0)).toThrow();
    expect(() => getRoundArtifactPath(runDir, 1, "unknown" as never)).toThrow();
  });

  it("only dispatches registered runnable phases", async () => {
    expect(PHASE_REGISTRY.size).toBe(11);
    expect(isRunnablePhase("SELECT")).toBe(true);
    expect(isRunnablePhase("DONE")).toBe(false);
    const seen: string[] = [];
    await dispatchPhase(run(), {
      SELECT: () => {
        seen.push("select");
      },
    });
    expect(seen).toEqual(["select"]);
    await expect(
      dispatchPhase(run({ phase: "DONE", status: "done" }), {})
    ).rejects.toThrow(/not runnable/);
  });

  it("enforces exclusive locks and classifies stale/cross-host locks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-v3-lock-"));
    const first = await acquireActiveWriterLock(dir, {
      run_id: "run-1",
      run_state_path: "RUN_STATE.json",
    });
    const live = await inspectActiveWriterLock(dir, "run-2");
    expect(live.kind).toBe("live_different_run");
    await expect(
      acquireActiveWriterLock(dir, {
        run_id: "run-2",
        run_state_path: "RUN_STATE.json",
      })
    ).rejects.toMatchObject({ inspection: { kind: "live_different_run" } });
    expect(await releaseActiveWriterLock(dir, first)).toBe(true);

    await writeJsonAtomic(activeWriterLockPath(dir), {
      version: 1,
      run_id: "old",
      run_state_path: "x",
      pid: 999999,
      hostname: (await import("node:os")).hostname(),
      cwd: dir,
      started_at: timestamp,
      updated_at: timestamp,
    });
    expect((await inspectActiveWriterLock(dir, "old")).kind).toBe(
      "stale_same_host"
    );
    expect(await clearStaleActiveWriterLock(dir, "old")).toBe(true);
    await writeJsonAtomic(activeWriterLockPath(dir), {
      version: 1,
      run_id: "foreign",
      run_state_path: "x",
      pid: 999999,
      hostname: "different-host",
      cwd: dir,
      started_at: timestamp,
      updated_at: timestamp,
    });
    expect((await inspectActiveWriterLock(dir, "foreign")).kind).toBe(
      "cross_host"
    );
    await expect(
      acquireActiveWriterLock(dir, { run_id: "new", run_state_path: "x" })
    ).rejects.toBeInstanceOf(ActiveWriterLockError);
  });
});
