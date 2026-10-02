import { describe, expect, it } from "vitest";

import {
  evaluateV4ChiefOutcome,
  parseV4ChiefDecision,
  renderV4ChiefEvidence,
  type V4ChiefDecision,
  type V4ChiefEvidence,
} from "../v4/chief.js";
import type {
  MachineGateRecord,
  ProductAnchor,
  ProductGateRecord,
  ProductIssue,
} from "../v4/domain.js";

function machine(outcome: MachineGateRecord["outcome"]): MachineGateRecord {
  return { level: "MACHINE", outcome, failures: [] };
}

function product(
  outcome: ProductGateRecord["outcome"],
  withEvidence = true
): ProductGateRecord {
  return {
    level: "PRODUCT",
    outcome,
    issues: [],
    ...(withEvidence
      ? {
          evidence: {
            artifact_ref: "out/handout.docx",
            exists: outcome === "PASS",
            checks: [],
            inspected_by: "agent" as const,
          },
        }
      : {}),
  };
}

function anchor(productGate: ProductGateRecord["outcome"]): ProductAnchor {
  return {
    round: 3,
    sha: "abc1234",
    user_value_delta: "student edition stopped carrying answers",
    product_artifact: "out/handout.docx",
    product_gate: productGate,
    product_issues: [],
    goal_drift_check: "PASS",
    next_highest_value_action: "ship",
  };
}

function evidence(overrides: Partial<V4ChiefEvidence> = {}): V4ChiefEvidence {
  return {
    machine: machine("PASS"),
    product: product("PASS"),
    anchor: anchor("PASS"),
    artifact_ref: "out/handout.docx",
    outstanding_issues: [],
    ...overrides,
  };
}

function decision(overrides: Partial<V4ChiefDecision> = {}): V4ChiefDecision {
  return {
    PRODUCT: "PASS",
    ENGINEERING: "PASS",
    RELEASE: "PASS",
    summary: "clean",
    product_findings: [],
    engineering_findings: [],
    release_findings: [],
    next_step: "release",
    ...overrides,
  };
}

describe("V4 chief decision parsing", () => {
  it("parses the three-judgement protocol", () => {
    const parsed = parseV4ChiefDecision(
      JSON.stringify({
        PRODUCT: "PASS",
        ENGINEERING: "PATCH",
        RELEASE: "BLOCKED",
        summary: "artifact corrupt",
        product_findings: ["duplicate block"],
        engineering_findings: [],
        release_findings: ["blocked on product"],
        next_step: "fix the template",
      })
    );
    expect(parsed?.PRODUCT).toBe("PASS");
    expect(parsed?.ENGINEERING).toBe("PATCH");
    expect(parsed?.RELEASE).toBe("BLOCKED");
  });

  it.each([
    ["prose instead of JSON", "looks good to me"],
    ["unknown verdict", JSON.stringify({ ...decision(), RELEASE: "SHIP" })],
    [
      "missing dimension",
      JSON.stringify({
        ENGINEERING: "PASS",
        RELEASE: "PASS",
        summary: "s",
        product_findings: [],
        engineering_findings: [],
        release_findings: [],
        next_step: "n",
      }),
    ],
    ["extra key", JSON.stringify({ ...decision(), confidence: 0.9 })],
    [
      "wrong field type",
      JSON.stringify({ ...decision(), product_findings: "duplicate" }),
    ],
  ])("rejects %s", (_label, text) => {
    expect(parseV4ChiefDecision(text)).toBeUndefined();
  });
});

describe("V4 chief evidence pack", () => {
  it("carries all six evidence classes", () => {
    const rendered = renderV4ChiefEvidence(
      evidence({
        product: product("FAIL", true),
        provenance: {
          filename: "unit-04.docx",
          sha256: "c".repeat(64),
          origin: "ORIGINAL_SOURCE",
          job_id: "job-9",
          attempt: 1,
        },
      })
    );
    for (const key of [
      "MACHINE_GATE:",
      "PRODUCT_GATE:",
      "PRODUCT_ARTIFACT_REF:",
      "PRODUCT_INTEGRITY_CHECKS:",
      "PRODUCT_ANCHOR:",
      "OUTSTANDING_PRODUCT_ISSUES:",
      "SOURCE_PROVENANCE:",
    ])
      expect(rendered).toContain(key);
    expect(rendered).toContain("ORIGINAL_SOURCE unit-04.docx");
    expect(rendered).toContain("USER_VALUE_DELTA:");
  });

  it("says so when no provenance was recorded", () => {
    expect(renderV4ChiefEvidence(evidence())).toContain(
      "SOURCE_PROVENANCE: not recorded"
    );
  });
});

describe("V4 chief fail-closed outcome", () => {
  it("passes only when all three judgements pass on complete evidence", () => {
    const outcome = evaluateV4ChiefOutcome(decision(), evidence());
    expect(outcome.overall).toBe("PASS");
    expect(outcome.corrected).toBe(false);
    expect(outcome.blockers).toEqual([]);
  });

  // Regression 6 — a chief with no product evidence may not approve a release.
  it("refuses a RELEASE PASS when no product evidence exists", () => {
    const outcome = evaluateV4ChiefOutcome(
      decision(),
      evidence({ product: product("NOT_RUN", false), artifact_ref: undefined, anchor: undefined })
    );
    expect(outcome.judgement.RELEASE).toBe("BLOCKED");
    expect(outcome.judgement.PRODUCT).toBe("BLOCKED");
    expect(outcome.overall).not.toBe("PASS");
    expect(outcome.corrected).toBe(true);
  });

  it("refuses a RELEASE PASS when the machine gate did not pass", () => {
    const outcome = evaluateV4ChiefOutcome(
      decision(),
      evidence({ machine: machine("FAIL") })
    );
    expect(outcome.judgement.RELEASE).toBe("BLOCKED");
    expect(outcome.blockers.join(" ")).toContain("MACHINE gate is FAIL");
  });

  it("refuses a RELEASE PASS when the product gate did not pass", () => {
    const outcome = evaluateV4ChiefOutcome(
      decision(),
      evidence({ product: product("FAIL"), anchor: anchor("FAIL") })
    );
    expect(outcome.judgement.RELEASE).toBe("BLOCKED");
    expect(outcome.blockers.join(" ")).toContain("PRODUCT gate is FAIL");
  });

  it("refuses a RELEASE PASS when the anchor records no passing gate", () => {
    const outcome = evaluateV4ChiefOutcome(
      decision(),
      evidence({ anchor: undefined })
    );
    expect(outcome.judgement.RELEASE).toBe("BLOCKED");
    expect(outcome.blockers.join(" ")).toContain("Product Anchor");
  });

  it("refuses a RELEASE PASS while a P0 issue is open", () => {
    const p0: ProductIssue[] = [
      { priority: "P0", summary: "recursive template", corruption: "RECURSIVE_CONTENT" },
    ];
    const outcome = evaluateV4ChiefOutcome(
      decision(),
      evidence({ outstanding_issues: p0 })
    );
    expect(outcome.judgement.RELEASE).toBe("BLOCKED");
    expect(outcome.judgement.PRODUCT).toBe("BLOCKED");
    expect(outcome.overall).not.toBe("PASS");
  });

  it("never downgrades a stricter chief judgement", () => {
    const outcome = evaluateV4ChiefOutcome(
      decision({ PRODUCT: "PATCH", RELEASE: "PATCH" }),
      evidence()
    );
    expect(outcome.judgement.PRODUCT).toBe("PATCH");
    expect(outcome.judgement.RELEASE).toBe("PATCH");
    expect(outcome.overall).toBe("PATCH");
    expect(outcome.corrected).toBe(false);
  });

  it("reports BLOCKED overall when a dimension is blocked", () => {
    const outcome = evaluateV4ChiefOutcome(
      decision({ ENGINEERING: "BLOCKED" }),
      evidence()
    );
    expect(outcome.overall).toBe("BLOCKED");
  });
});
