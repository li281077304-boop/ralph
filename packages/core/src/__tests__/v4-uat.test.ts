/**
 * Ralph V4 — end-to-end UAT.
 *
 * The incident V4 was written for, abstracted: a run whose machine gate is
 * completely green — tests pass, the package is valid, the file opens — while
 * the artifact the user receives is corrupt. Under V3 that run could still walk
 * to Release. This suite is the acceptance case that says it no longer can.
 *
 * No domain code is involved: the artifact, the checks and the issues are
 * generic. A real project (a handout generator, say) supplies its own integrity
 * checks; the harness only decides what a failing one means.
 *
 * Regression map (V4 plan §14):
 *   1 Machine PASS + Product FAIL → overall FAIL
 *   2 Machine PASS + Product NOT_RUN two rounds → stop
 *   3 P0 → release-class work suppressed
 *   4 product artifact missing → FAIL
 *   5 GENERATED_OUTPUT as ordinary UAT input → invalid
 *   6 chief without product evidence → no RELEASE PASS
 *   7 Machine FAIL + Product PASS → no release
 *   8 Machine PASS + Product PASS → release-ready
 *   9 V3 legacy mode enables nothing
 *  10 anchor counter survives a restart
 * Items 1–9 are pinned across v4-domain / v4-supervisor / v4-chief /
 * v4-run-mode; item 10 lives in v4-anchor-store. This file is the joined-up
 * walk through all of them at once.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { recordAnchor } from "../v4/anchor-store.js";
import { evaluateV4ChiefOutcome } from "../v4/chief.js";
import type { ProductAnchor, ProductEvidence, ProductIssue } from "../v4/domain.js";
import {
  deriveProductGateRecord,
  deriveReleaseReadiness,
} from "../v4/policy.js";
import { evaluateV4Round } from "../v4/supervisor.js";

/** A green machine gate: everything the V3 world could see is fine. */
const GREEN_MACHINE = { level: "MACHINE", outcome: "PASS", failures: [] } as const;

/** Hostile product issues: the template reappears and a block is duplicated. */
const CORRUPTION_ISSUES: ProductIssue[] = [
  {
    priority: "P0",
    summary: "the full section template reappears inside the body",
    corruption: "RECURSIVE_CONTENT",
  },
  {
    priority: "P1",
    summary: "a long content sequence is duplicated",
    corruption: "SEVERE_DUPLICATION",
  },
];

/** The artifact exists and opens — it is simply wrong. */
const CORRUPT_EVIDENCE: ProductEvidence = {
  artifact_ref: "out/handout.docx",
  artifact_sha256: "d".repeat(64),
  exists: true,
  inspected_by: "agent",
  inspection_note: "opened the document; section headings repeat from page 1",
  checks: [
    {
      id: "recursive-template",
      severity: "error",
      outcome: "FAIL",
      reason: "the complete template fingerprint appears a second time",
    },
    {
      id: "long-block-duplication",
      severity: "error",
      outcome: "FAIL",
      reason: "a 40-block sequence repeats verbatim",
    },
    { id: "expansion-ratio", severity: "warning", outcome: "FAIL", reason: "3.4x growth" },
  ],
};

const CLEAN_EVIDENCE: ProductEvidence = {
  artifact_ref: "out/handout.docx",
  artifact_sha256: "e".repeat(64),
  exists: true,
  inspected_by: "agent",
  inspection_note: "read start, middle and end; structure and roles correct",
  checks: [
    { id: "recursive-template", severity: "error", outcome: "PASS" },
    { id: "long-block-duplication", severity: "error", outcome: "PASS" },
    { id: "expansion-ratio", severity: "info", outcome: "PASS" },
  ],
};

function anchor(round: number, gate: ProductAnchor["product_gate"]): ProductAnchor {
  return {
    round,
    sha: `sha${round}`,
    user_value_delta:
      gate === "PASS"
        ? "the student edition no longer carries teacher answers"
        : "no product-visible change this round",
    product_artifact: "out/handout.docx",
    product_gate: gate,
    product_issues: [],
    goal_drift_check: "PASS",
    next_highest_value_action: "inspect the artifact",
  };
}

describe("UAT: machine green, artifact corrupt", () => {
  it("fails the product gate even though every machine check passed", () => {
    const product = deriveProductGateRecord(CORRUPTION_ISSUES, CORRUPT_EVIDENCE);
    expect(product.outcome).toBe("FAIL");
    expect(product.reason).toContain("P0 product corruption");
  });

  it("blocks the release and names both gates", () => {
    const product = deriveProductGateRecord(CORRUPTION_ISSUES, CORRUPT_EVIDENCE);
    const release = deriveReleaseReadiness(GREEN_MACHINE, product);
    expect(release.readiness).toBe("RELEASE_BLOCKED");
    expect(release.blockers.join(" ")).toContain("PRODUCT gate is FAIL");
    // The machine gate is not blamed — it genuinely passed.
    expect(release.blockers.join(" ")).not.toContain("MACHINE gate");
  });

  it("sends the next obligation to the product lineage, not to packaging", () => {
    const product = deriveProductGateRecord(CORRUPTION_ISSUES, CORRUPT_EVIDENCE);
    const decision = evaluateV4Round({
      round: 4,
      machineGate: "PASS",
      productGate: product.outcome,
      consecutiveProductNotRun: 0,
      productIssues: CORRUPTION_ISSUES,
      recentWorkKinds: ["PACKAGING_METADATA", "MUTEX"],
      obligations: [],
    });
    expect(decision.stopSignal).toBe("P0_PRODUCT_CORRUPTION");
    expect(decision.nextObligationId).toBe("v4-p0:TRACE_PRODUCT_LINEAGE");
    expect(decision.suppressedWork).toContain("RELEASE");
    expect(decision.suppressedWork).toContain("PACKAGING");
    expect(decision.release.readiness).toBe("RELEASE_BLOCKED");
  });

  // Regression 6, end to end: the chief that tries to sign this off is refused.
  it("refuses a chief verdict that releases the corrupt artifact", () => {
    const product = deriveProductGateRecord(CORRUPTION_ISSUES, CORRUPT_EVIDENCE);
    const outcome = evaluateV4ChiefOutcome(
      {
        PRODUCT: "PASS",
        ENGINEERING: "PASS",
        RELEASE: "PASS",
        summary: "418 tests green, package valid",
        product_findings: [],
        engineering_findings: [],
        release_findings: [],
        next_step: "release",
      },
      {
        machine: GREEN_MACHINE,
        product,
        anchor: anchor(4, "FAIL"),
        artifact_ref: "out/handout.docx",
        outstanding_issues: CORRUPTION_ISSUES,
      }
    );
    expect(outcome.overall).not.toBe("PASS");
    expect(outcome.judgement.RELEASE).toBe("BLOCKED");
    expect(outcome.corrected).toBe(true);
    expect(outcome.blockers.join(" ")).toContain("P0");
  });
});

describe("UAT: machine green, artifact clean", () => {
  it("passes the product gate and reaches release-ready", () => {
    const product = deriveProductGateRecord([], CLEAN_EVIDENCE);
    expect(product.outcome).toBe("PASS");
    const release = deriveReleaseReadiness(GREEN_MACHINE, product);
    expect(release.readiness).toBe("RELEASE_READY");
    expect(release.blockers).toEqual([]);
  });

  it("lets a chief that saw the artifact approve the release", () => {
    const product = deriveProductGateRecord([], CLEAN_EVIDENCE);
    const outcome = evaluateV4ChiefOutcome(
      {
        PRODUCT: "PASS",
        ENGINEERING: "PASS",
        RELEASE: "PASS",
        summary: "artifact inspected end to end; structure and roles correct",
        product_findings: ["read start, middle and end"],
        engineering_findings: [],
        release_findings: [],
        next_step: "release",
      },
      {
        machine: GREEN_MACHINE,
        product,
        anchor: anchor(5, "PASS"),
        artifact_ref: "out/handout.docx",
        outstanding_issues: [],
      }
    );
    expect(outcome.overall).toBe("PASS");
    expect(outcome.corrected).toBe(false);
  });

  it("stops the run when two rounds go by without a product verdict", () => {
    const decision = evaluateV4Round({
      round: 9,
      machineGate: "PASS",
      productGate: "NOT_RUN",
      consecutiveProductNotRun: 2,
      productIssues: [],
      recentWorkKinds: ["HASHES"],
      obligations: [],
    });
    expect(decision.mustStopExpanding).toBe(true);
    expect(decision.stopSignal).toBe("PRODUCT_ANCHOR_REQUIRED");
  });

  // Regression 10, joined up: the stop still fires after a restart.
  it("keeps stopping after a restart, from the durable counter alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-v4-uat-"));
    await recordAnchor(root, anchor(1, "NOT_RUN"), "run-uat");
    await recordAnchor(root, anchor(2, "NOT_RUN"), "run-uat");

    const { loadAnchorRecord } = await import("../v4/anchor-store.js");
    const restored = await loadAnchorRecord(root, "run-uat");

    const decision = evaluateV4Round({
      round: 3,
      machineGate: "PASS",
      productGate: "NOT_RUN",
      consecutiveProductNotRun: restored.consecutive_product_not_run,
      productIssues: [],
      recentWorkKinds: [],
      obligations: [],
    });
    expect(decision.mustStopExpanding).toBe(true);
    expect(decision.stopSignal).toBe("PRODUCT_ANCHOR_REQUIRED");
  });
});
