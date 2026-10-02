import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { recordAnchor } from "../v4/anchor-store.js";
import type { ProductAnchor } from "../v4/domain.js";
import {
  journalPath,
  readJournal,
  recordJournalEntry,
} from "../v4/journal.js";
import { evaluateV4Preflight, v4PreflightError } from "../v4/preflight.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ralph-v4-preflight-"));
});

function anchor(round: number, gate: ProductAnchor["product_gate"]): ProductAnchor {
  return {
    round,
    sha: `sha${round}`,
    user_value_delta: `round ${round} changed the artifact`,
    product_artifact: "out/handout.docx",
    product_gate: gate,
    product_issues: [],
    goal_drift_check: "PASS",
    next_highest_value_action: "inspect the artifact",
  };
}

describe("V4 preflight gate", () => {
  it("lets a run start when nothing has been anchored", async () => {
    const result = await evaluateV4Preflight({ workspaceDir: root, runId: "r1" });
    expect(result.blocked).toBe(false);
    expect(result.recordedAnchors).toBe(0);
  });

  it("lets a run start after a real product verdict", async () => {
    await recordAnchor(root, anchor(1, "PASS"), "r1");
    const result = await evaluateV4Preflight({ workspaceDir: root, runId: "r1" });
    expect(result.blocked).toBe(false);
  });

  it("refuses to start once the product gate is overdue", async () => {
    await recordAnchor(root, anchor(1, "NOT_RUN"), "r1");
    await recordAnchor(root, anchor(2, "NOT_RUN"), "r1");
    const result = await evaluateV4Preflight({ workspaceDir: root, runId: "r1" });
    expect(result.blocked).toBe(true);
    expect(result.signal).toBe("PRODUCT_ANCHOR_REQUIRED");
    expect(result.consecutiveProductNotRun).toBe(2);
  });

  it("starts again once a real verdict resets the counter", async () => {
    await recordAnchor(root, anchor(1, "NOT_RUN"), "r1");
    await recordAnchor(root, anchor(2, "NOT_RUN"), "r1");
    await recordAnchor(root, anchor(3, "FAIL"), "r1");
    const result = await evaluateV4Preflight({ workspaceDir: root, runId: "r1" });
    expect(result.blocked).toBe(false);
    expect(result.consecutiveProductNotRun).toBe(0);
  });

  it("keeps runs isolated by run id", async () => {
    await recordAnchor(root, anchor(1, "NOT_RUN"), "r1");
    await recordAnchor(root, anchor(2, "NOT_RUN"), "r1");
    const other = await evaluateV4Preflight({ workspaceDir: root, runId: "r2" });
    expect(other.blocked).toBe(false);
  });

  it("explains how to unblock", async () => {
    await recordAnchor(root, anchor(1, "NOT_RUN"), "r1");
    await recordAnchor(root, anchor(2, "NOT_RUN"), "r1");
    const message = v4PreflightError(
      await evaluateV4Preflight({ workspaceDir: root, runId: "r1" })
    );
    expect(message).toContain("PRODUCT_ANCHOR_REQUIRED");
    expect(message).toContain("Product Anchor");
  });
});

describe("V4 durable journal", () => {
  const entry = {
    round: 2,
    sha: "abc1234",
    userValueDelta: "student edition stopped carrying answers",
    machineGate: "PASS" as const,
    productArtifact: "out/handout.docx",
    productGate: "FAIL" as const,
    productIssues: [
      { priority: "P0" as const, summary: "recursive template", corruption: "RECURSIVE_CONTENT" as const },
    ],
    goalDriftCheck: "PASS" as const,
    nextHighestValueAction: "trace the template lineage",
  };

  it("writes the journal under the run's chief directory", () => {
    expect(journalPath(root, "r1")).toContain(join("chief-runs", "r1"));
  });

  it("persists every journal field", async () => {
    await recordJournalEntry(root, "r1", entry);
    const text = await readJournal(root, "r1");
    for (const key of [
      "ROUND:",
      "SHA:",
      "USER_VALUE_DELTA:",
      "MACHINE_GATE:",
      "PRODUCT_ARTIFACT:",
      "PRODUCT_GATE:",
      "PRODUCT_ISSUES:",
      "SOURCE_PROVENANCE:",
      "GOAL_DRIFT_CHECK:",
      "NEXT_HIGHEST_VALUE_ACTION:",
    ])
      expect(text).toContain(key);
    expect(text).toContain("P0/RECURSIVE_CONTENT");
  });

  it("appends across rounds instead of overwriting", async () => {
    await recordJournalEntry(root, "r1", entry);
    await recordJournalEntry(root, "r1", { ...entry, round: 3 });
    const text = await readJournal(root, "r1");
    expect(text).toContain("ROUND: 2");
    expect(text).toContain("ROUND: 3");
  });

  it("returns empty when nothing was journalled", async () => {
    expect(await readJournal(root, "never-ran")).toBe("");
  });
});
