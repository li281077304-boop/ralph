import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  MalformedAnchorRecordError,
  anchorsPath,
  appendAnchor,
  emptyAnchorRecord,
  loadAnchorRecord,
  recordAnchor,
  saveAnchorRecord,
} from "../v4/anchor-store.js";
import type { ProductAnchor } from "../v4/domain.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ralph-v4-anchor-"));
});

function anchor(
  round: number,
  productGate: ProductAnchor["product_gate"]
): ProductAnchor {
  return {
    round,
    sha: `sha${round}`,
    user_value_delta: `round ${round} improved the artifact`,
    product_artifact: "out/handout.docx",
    product_gate: productGate,
    product_issues: [],
    goal_drift_check: "PASS",
    next_highest_value_action: "inspect the artifact",
  };
}

describe("V4 anchor store", () => {
  it("starts empty for a run that has never anchored", async () => {
    const record = await loadAnchorRecord(root, "run-1");
    expect(record.anchors).toEqual([]);
    expect(record.consecutive_product_not_run).toBe(0);
    expect(record.run_id).toBe("run-1");
  });

  it("round-trips an anchor through disk", async () => {
    await recordAnchor(root, anchor(1, "PASS"), "run-1");
    const loaded = await loadAnchorRecord(root, "run-1");
    expect(loaded.anchors).toHaveLength(1);
    expect(loaded.anchors[0].product_gate).toBe("PASS");
    expect(loaded.anchors[0].sha).toBe("sha1");
  });

  it("counts consecutive NOT_RUN anchors and resets on a real verdict", () => {
    let record = emptyAnchorRecord("run-1");
    record = appendAnchor(record, anchor(1, "NOT_RUN"));
    record = appendAnchor(record, anchor(2, "NOT_RUN"));
    expect(record.consecutive_product_not_run).toBe(2);

    record = appendAnchor(record, anchor(3, "FAIL"));
    expect(record.consecutive_product_not_run).toBe(0);
    expect(record.anchors).toHaveLength(3);
  });

  // Regression 10 — the counter must survive a restart.
  it("persists the unrun counter across a restart", async () => {
    await recordAnchor(root, anchor(1, "NOT_RUN"), "run-1");
    await recordAnchor(root, anchor(2, "NOT_RUN"), "run-1");

    // Simulate a fresh process: nothing is carried in memory, only the file.
    const afterRestart = await loadAnchorRecord(root, "run-1");
    expect(afterRestart.consecutive_product_not_run).toBe(2);
    expect(afterRestart.anchors.map((item) => item.round)).toEqual([1, 2]);

    // And the counter keeps advancing from the restored value.
    const next = await recordAnchor(root, anchor(3, "NOT_RUN"), "run-1");
    expect(next.consecutive_product_not_run).toBe(3);
  });

  it("writes under the run's chief directory", async () => {
    await recordAnchor(root, anchor(1, "PASS"), "run-9");
    expect(anchorsPath(root, "run-9")).toContain(join("chief-runs", "run-9"));
    const loaded = await loadAnchorRecord(root, "run-9");
    expect(loaded.run_id).toBe("run-9");
  });

  it("refuses a record whose identity does not match", async () => {
    await saveAnchorRecord(root, emptyAnchorRecord("run-1"));
    const parsed = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        anchorsPath(root, "run-1"),
        "utf8"
      )
    ) as Record<string, unknown>;
    await writeFile(
      anchorsPath(root, "run-1"),
      JSON.stringify({ ...parsed, run_id: "someone-else" }),
      "utf8"
    );
    await expect(loadAnchorRecord(root, "run-1")).rejects.toBeInstanceOf(
      MalformedAnchorRecordError
    );
  });
});
