import { describe, expect, it } from "vitest";

import {
  P0_OBLIGATION_CHAIN,
  PERIPHERAL_WORK_KINDS,
  type MachineGateRecord,
  type ProductEvidence,
  type ProductGateRecord,
  type ProductIssue,
  type SourceProvenance,
} from "../v4/domain.js";
import {
  auditUserValueDelta,
  buildRunJournalEntry,
  deriveP0Reprioritisation,
  deriveProductGateRecord,
  deriveReleaseReadiness,
  evaluateGoalDrift,
  evaluateProductAnchorRequirement,
  evaluateSourceProvenance,
  p0CorruptionKinds,
  renderRunJournal,
  sortIssuesByPriority,
} from "../v4/policy.js";

const MACHINE_PASS: MachineGateRecord = {
  level: "MACHINE",
  outcome: "PASS",
  failures: [],
};

function product(outcome: ProductGateRecord["outcome"]): ProductGateRecord {
  return { level: "PRODUCT", outcome, issues: [] };
}

function evidence(overrides: Partial<ProductEvidence> = {}): ProductEvidence {
  return {
    artifact_ref: "out/handout.docx",
    artifact_sha256: "a".repeat(64),
    exists: true,
    checks: [],
    inspected_by: "agent",
    ...overrides,
  };
}

function provenance(origin: SourceProvenance["origin"]): SourceProvenance {
  return {
    filename: "unit-04.docx",
    sha256: "b".repeat(64),
    origin,
    job_id: "job-1",
    attempt: 1,
  };
}

describe("V4 release readiness (Gate 3)", () => {
  it("Machine PASS + Product PASS is the only RELEASE_READY", () => {
    const verdict = deriveReleaseReadiness(MACHINE_PASS, product("PASS"));
    expect(verdict.readiness).toBe("RELEASE_READY");
    expect(verdict.blockers).toEqual([]);
  });

  // Regression 1 — Machine PASS + Product FAIL → overall FAIL.
  it("Machine PASS + Product FAIL blocks the release", () => {
    const verdict = deriveReleaseReadiness(MACHINE_PASS, product("FAIL"));
    expect(verdict.readiness).toBe("RELEASE_BLOCKED");
    expect(verdict.blockers.join(" ")).toContain("PRODUCT gate is FAIL");
  });

  // Regression 7 — Machine FAIL + Product PASS may not release.
  it("Machine FAIL + Product PASS blocks the release", () => {
    const verdict = deriveReleaseReadiness("FAIL", product("PASS"));
    expect(verdict.readiness).toBe("RELEASE_BLOCKED");
    expect(verdict.blockers.join(" ")).toContain("MACHINE gate is FAIL");
  });

  it("an unrun product gate is not a partial pass", () => {
    for (const outcome of ["NOT_RUN", "BLOCKED"] as const) {
      const verdict = deriveReleaseReadiness(MACHINE_PASS, product(outcome));
      expect(verdict.readiness).toBe("RELEASE_BLOCKED");
    }
  });

  it("accepts bare GateOutcome values as well as gate records", () => {
    expect(deriveReleaseReadiness("PASS", "PASS").readiness).toBe(
      "RELEASE_READY"
    );
  });
});

describe("V4 product gate derivation", () => {
  it("fails the gate on P0 corruption", () => {
    const issues: ProductIssue[] = [
      {
        priority: "P0",
        summary: "template reappears in the body",
        corruption: "RECURSIVE_CONTENT",
      },
    ];
    const record = deriveProductGateRecord(issues, evidence());
    expect(record.outcome).toBe("FAIL");
    expect(record.reason).toContain("P0 product corruption");
    expect(p0CorruptionKinds(issues)).toEqual(["RECURSIVE_CONTENT"]);
  });

  // Regression 4 — a missing artifact fails rather than silently skipping.
  it("reports NOT_RUN when no evidence was recorded", () => {
    const record = deriveProductGateRecord([]);
    expect(record.outcome).toBe("NOT_RUN");
    expect(record.reason).toContain("never inspected");
  });

  it("fails when the artifact does not exist", () => {
    const record = deriveProductGateRecord([], evidence({ exists: false }));
    expect(record.outcome).toBe("FAIL");
    expect(record.reason).toContain("artifact not found");
  });

  it("fails when an integrity check failed", () => {
    const record = deriveProductGateRecord(
      [],
      evidence({
        checks: [
          { id: "recursive-template", severity: "error", outcome: "FAIL" },
          { id: "expansion-ratio", severity: "info", outcome: "PASS" },
        ],
      })
    );
    expect(record.outcome).toBe("FAIL");
    expect(record.reason).toContain("recursive-template");
  });

  it("blocks on an open P1/P2 issue even with clean evidence", () => {
    const record = deriveProductGateRecord(
      [{ priority: "P2", summary: "chapter 3 truncated" }],
      evidence()
    );
    expect(record.outcome).toBe("BLOCKED");
  });

  // Regression 8 — clean machine + clean product can reach the release gate.
  it("passes on clean evidence and no issues", () => {
    const record = deriveProductGateRecord(
      [{ priority: "P5", summary: "minor wording" }],
      evidence()
    );
    expect(record.outcome).toBe("PASS");
  });
});

describe("V4 product anchor cadence", () => {
  // Regression 2 — NOT_RUN for the threshold number of rounds stops expansion.
  it("requires an anchor after the threshold of unrun rounds", () => {
    expect(evaluateProductAnchorRequirement(1).required).toBe(false);
    const hit = evaluateProductAnchorRequirement(2);
    expect(hit.required).toBe(true);
    expect(hit.signal).toBe("PRODUCT_ANCHOR_REQUIRED");
  });

  it("honours a caller-supplied threshold", () => {
    expect(evaluateProductAnchorRequirement(2, 3).required).toBe(false);
    expect(evaluateProductAnchorRequirement(3, 3).required).toBe(true);
  });
});

describe("V4 goal drift", () => {
  it("does not flag drift when the product gate has passed", () => {
    expect(
      evaluateGoalDrift({
        recentWorkKinds: [...PERIPHERAL_WORK_KINDS],
        productGateOutcome: "PASS",
      })
    ).toBe("PASS");
  });

  // A gate that ran and failed is a known product problem, not drift.
  it("does not flag drift when the gate ran and failed", () => {
    expect(
      evaluateGoalDrift({
        recentWorkKinds: [...PERIPHERAL_WORK_KINDS],
        productGateOutcome: "FAIL",
      })
    ).toBe("PASS");
  });

  it("flags drift when recent work is only peripheral", () => {
    expect(
      evaluateGoalDrift({
        recentWorkKinds: ["MUTEX", "PORT", "PACKAGING_METADATA"],
        productGateOutcome: "NOT_RUN",
      })
    ).toBe("FAIL");
  });

  it("does not flag drift when at least one change touched the product", () => {
    expect(
      evaluateGoalDrift({
        recentWorkKinds: ["MUTEX", "PRODUCT_FIX"],
        productGateOutcome: "NOT_RUN",
      })
    ).toBe("PASS");
  });

  it("does not flag drift with no recorded work", () => {
    expect(evaluateGoalDrift({ recentWorkKinds: [] })).toBe("PASS");
  });
});

describe("V4 USER_VALUE_DELTA audit", () => {
  it("accepts a concrete user-facing improvement", () => {
    expect(
      auditUserValueDelta(
        "the teacher edition no longer leaks answers into the student edition"
      ).ok
    ).toBe(true);
  });

  it.each([
    "12 more tests, coverage up",
    "test count increased to 418",
    "refactored the supervisor loop",
    "hash matches the previous build",
    "新增 12 个测试",
    "覆盖率提高到 90%",
    "重构完成",
  ])("rejects machine evidence as a value delta: %s", (text) => {
    const audit = auditUserValueDelta(text);
    expect(audit.ok).toBe(false);
    expect(audit.reasons.length).toBeGreaterThan(0);
  });

  it("rejects an empty delta", () => {
    expect(auditUserValueDelta("   ").ok).toBe(false);
  });
});

describe("V4 source provenance", () => {
  it("accepts an original source", () => {
    expect(evaluateSourceProvenance(provenance("ORIGINAL_SOURCE")).valid).toBe(
      true
    );
  });

  // Regression 5 — GENERATED_OUTPUT may not be used as an ordinary UAT input.
  it("invalidates a generated output used as ordinary input", () => {
    const verdict = evaluateSourceProvenance(provenance("GENERATED_OUTPUT"));
    expect(verdict.valid).toBe(false);
    expect(verdict.signal).toBe("UAT_INPUT_INVALID");
  });

  it("allows a generated output only for an explicit re-ingestion test", () => {
    expect(
      evaluateSourceProvenance(provenance("GENERATED_OUTPUT"), {
        reingestionTest: true,
      }).valid
    ).toBe(true);
  });

  it("invalidates a missing provenance record", () => {
    expect(evaluateSourceProvenance(undefined).valid).toBe(false);
  });
});

describe("V4 P0 reprioritisation", () => {
  // Regression 3 — P0 activates the trace chain and suppresses release work.
  it("activates the P0 chain and starts at the lineage trace", () => {
    const p0: ProductIssue[] = [
      { priority: "P0", summary: "mass loss", corruption: "MASS_CONTENT_LOSS" },
    ];
    const result = deriveP0Reprioritisation(p0);
    expect(result.active).toBe(true);
    expect(result.chain).toEqual(P0_OBLIGATION_CHAIN);
    expect(result.next).toBe("TRACE_PRODUCT_LINEAGE");
  });

  it("stays inactive without a P0 issue", () => {
    const result = deriveP0Reprioritisation([
      { priority: "P3", summary: "flake" },
    ]);
    expect(result.active).toBe(false);
    expect(result.next).toBeUndefined();
  });
});

describe("V4 run journal", () => {
  const entry = buildRunJournalEntry({
    round: 7,
    sha: "abc1234",
    userValueDelta: "student edition no longer carries answers",
    machineGate: "PASS",
    productArtifact: "out/handout.docx",
    productGate: "FAIL",
    productIssues: [
      { priority: "P4", summary: "minor wording" },
      {
        priority: "P0",
        summary: "recursive template",
        corruption: "RECURSIVE_CONTENT",
      },
    ],
    sourceProvenance: provenance("ORIGINAL_SOURCE"),
    goalDriftCheck: "PASS",
    nextHighestValueAction: "trace the template lineage",
  });

  it("orders journal issues by priority", () => {
    expect(entry.PRODUCT_ISSUES[0]).toContain("P0");
    expect(entry.PRODUCT_ISSUES[1]).toContain("P4");
  });

  it("sorts issues along the priority ladder", () => {
    const sorted = sortIssuesByPriority([
      { priority: "P5", summary: "polish" },
      { priority: "P1", summary: "truncated" },
      { priority: "P0", summary: "corrupt" },
    ]);
    expect(sorted.map((issue) => issue.priority)).toEqual(["P0", "P1", "P5"]);
  });

  it("renders every durable journal field", () => {
    const rendered = renderRunJournal(entry);
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
      expect(rendered).toContain(key);
    expect(rendered).toContain("ORIGINAL_SOURCE unit-04.docx");
  });

  it("renders an explicit none when there is no provenance", () => {
    const bare = buildRunJournalEntry({
      round: 1,
      sha: "deadbee",
      userValueDelta: "first artifact produced",
      machineGate: "PASS",
      productArtifact: "n/a",
      productGate: "NOT_RUN",
      productIssues: [],
      goalDriftCheck: "PASS",
      nextHighestValueAction: "inspect the artifact",
    });
    expect(bare.SOURCE_PROVENANCE).toBe("none");
    expect(renderRunJournal(bare)).toContain("  - none");
  });
});
