import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { loadAnchorRecord } from "../v4/anchor-store.js";
import { readJournal } from "../v4/journal.js";
import {
  parseProductGatePayload,
  runProductGateCommand,
} from "../v4/product-gate.js";
import { runV4Round } from "../v4/runtime.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ralph-v4-runtime-"));
});

/** Write a fake product gate that prints the given payload. */
async function gateCommand(payload: unknown): Promise<string> {
  const file = join(root, `gate-${Math.random().toString(36).slice(2)}.cjs`);
  await writeFile(
    file,
    `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`,
    "utf8"
  );
  return `node "${file}"`;
}

async function failingCommand(): Promise<string> {
  const file = join(root, `fail-${Math.random().toString(36).slice(2)}.cjs`);
  await writeFile(file, "process.exit(3);", "utf8");
  return `node "${file}"`;
}

const PASS_PAYLOAD = {
  evidence: {
    artifact_ref: "out/handout.docx",
    exists: true,
    inspected_by: "agent",
    checks: [
      { id: "recursive-template", severity: "error", outcome: "PASS" },
    ],
  },
  issues: [],
  user_value_delta: "the student edition stopped carrying teacher answers",
};

const CORRUPT_PAYLOAD = {
  evidence: {
    artifact_ref: "out/handout.docx",
    exists: true,
    inspected_by: "agent",
    checks: [
      {
        id: "recursive-template",
        severity: "error",
        outcome: "FAIL",
        reason: "template reappeared",
      },
    ],
  },
  issues: [
    {
      priority: "P0",
      summary: "the template reappears in the body",
      corruption: "RECURSIVE_CONTENT",
    },
  ],
  user_value_delta: "no user-visible change recorded this round",
};

describe("product gate payload parsing", () => {
  it("accepts a well-formed payload", () => {
    const parsed = parseProductGatePayload(JSON.stringify(PASS_PAYLOAD));
    expect(parsed?.evidence.artifact_ref).toBe("out/handout.docx");
    expect(parsed?.issues).toEqual([]);
    expect(parsed?.user_value_delta).toContain("student edition");
  });

  it.each([
    ["prose", "all good"],
    ["no evidence", JSON.stringify({ issues: [] })],
    ["malformed evidence", JSON.stringify({ evidence: { artifact_ref: 1 } })],
    ["issues not an array", JSON.stringify({ ...PASS_PAYLOAD, issues: "x" })],
  ])("rejects %s", (_label, text) => {
    expect(parseProductGatePayload(text)).toBeUndefined();
  });
});

describe("product gate command", () => {
  it("treats a missing command as no gate at all", async () => {
    const result = await runProductGateCommand(undefined, root);
    expect(result.source).toBe("NONE");
    expect(result.payload).toBeUndefined();
  });

  it("reads the payload from a configured command", async () => {
    const result = await runProductGateCommand(await gateCommand(PASS_PAYLOAD), root);
    expect(result.source).toBe("COMMAND");
    expect(result.payload?.evidence.exists).toBe(true);
  });

  it("reports an error rather than a pass when the command fails", async () => {
    const result = await runProductGateCommand(await failingCommand(), root);
    expect(result.payload).toBeUndefined();
    expect(result.error).toContain("failed");
  });

  it("reports an error when the output is not the contract", async () => {
    const result = await runProductGateCommand(await gateCommand({ nope: true }), root);
    expect(result.payload).toBeUndefined();
    expect(result.error).toContain("not a usable JSON payload");
  });
});

describe("V4 round runtime", () => {
  // The core of the fix: without a gate command the round still records an
  // anchor, so the durable NOT_RUN counter actually advances.
  it("records a NOT_RUN anchor when no gate is declared", async () => {
    const outcome = await runV4Round(
      { workspaceDir: root, runId: "r1" },
      { round: 1, sha: "sha1", machineGate: "PASS" }
    );
    expect(outcome.productGate.outcome).toBe("NOT_RUN");
    expect(outcome.productGateSource).toBe("NONE");
    expect(outcome.record.consecutive_product_not_run).toBe(1);

    const persisted = await loadAnchorRecord(root, "r1");
    expect(persisted.consecutive_product_not_run).toBe(1);
    expect(persisted.anchors).toHaveLength(1);
  });

  it("stops expanding on the second unrun round", async () => {
    const options = { workspaceDir: root, runId: "r1" };
    const first = await runV4Round(options, {
      round: 1,
      sha: "sha1",
      machineGate: "PASS",
    });
    expect(first.decision.mustStopExpanding).toBe(false);

    const second = await runV4Round(options, {
      round: 2,
      sha: "sha2",
      machineGate: "PASS",
    });
    expect(second.decision.mustStopExpanding).toBe(true);
    expect(second.decision.stopSignal).toBe("PRODUCT_ANCHOR_REQUIRED");
  });

  it("records a passing product gate and resets the counter", async () => {
    const options = { workspaceDir: root, runId: "r1" };
    await runV4Round(
      { ...options, productGateCommand: await gateCommand(CORRUPT_PAYLOAD) },
      { round: 1, sha: "sha1", machineGate: "PASS" }
    );
    const passing = await runV4Round(
      { ...options, productGateCommand: await gateCommand(PASS_PAYLOAD) },
      { round: 2, sha: "sha2", machineGate: "PASS" }
    );
    expect(passing.productGate.outcome).toBe("PASS");
    expect(passing.record.consecutive_product_not_run).toBe(0);
    expect(passing.decision.release.readiness).toBe("RELEASE_READY");
  });

  // Regression 1/16, end to end through the runtime.
  it("fails the product gate and blocks release on a corrupt artifact", async () => {
    const outcome = await runV4Round(
      {
        workspaceDir: root,
        runId: "r1",
        productGateCommand: await gateCommand(CORRUPT_PAYLOAD),
      },
      { round: 1, sha: "sha1", machineGate: "PASS" }
    );
    expect(outcome.productGate.outcome).toBe("FAIL");
    expect(outcome.decision.release.readiness).toBe("RELEASE_BLOCKED");
    expect(outcome.decision.stopSignal).toBe("P0_PRODUCT_CORRUPTION");
    expect(outcome.decision.nextObligationId).toBe("v4-p0:TRACE_PRODUCT_LINEAGE");
  });

  it("persists the journal for every round", async () => {
    const options = { workspaceDir: root, runId: "r1" };
    await runV4Round(options, { round: 1, sha: "sha1", machineGate: "PASS" });
    await runV4Round(options, { round: 2, sha: "sha2", machineGate: "PASS" });
    const journal = await readJournal(root, "r1");
    expect(journal).toContain("ROUND: 1");
    expect(journal).toContain("ROUND: 2");
    expect(journal).toContain("PRODUCT_GATE: NOT_RUN");
    expect(journal).toContain("MACHINE_GATE:");
  });

  it("carries the gate's own user value delta into the anchor", async () => {
    const outcome = await runV4Round(
      {
        workspaceDir: root,
        runId: "r1",
        productGateCommand: await gateCommand(PASS_PAYLOAD),
      },
      { round: 1, sha: "sha1", machineGate: "PASS" }
    );
    expect(outcome.anchor.user_value_delta).toContain("student edition");
  });
});
