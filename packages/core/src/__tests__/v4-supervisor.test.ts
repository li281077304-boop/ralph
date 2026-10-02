import { describe, expect, it } from "vitest";

import { P0_OBLIGATION_CHAIN, P0_SUPPRESSED_WORK } from "../v4/domain.js";
import {
  P0_DEMOTED_PRIORITY_CAP,
  P0_OBLIGATION_PRIORITY,
  evaluateV4Round,
  isWorkAllowed,
  p0ChainObligations,
  reprioritiseObligationsForP0,
  type V4RoundInput,
} from "../v4/supervisor.js";
import type { Obligation } from "../v3/obligations.js";
import type { ProductIssue } from "../v4/domain.js";

function obligation(id: string, priority = 1): Obligation {
  return {
    id,
    source: "PROJECT_STATE",
    description: id,
    status: "RUNNABLE",
    priority,
    verification: [],
    evidence: [],
    created_round: 1,
    updated_round: 1,
  };
}

const P0_ISSUE: ProductIssue = {
  priority: "P0",
  summary: "template reappears in the body",
  corruption: "RECURSIVE_CONTENT",
};

function round(overrides: Partial<V4RoundInput> = {}): V4RoundInput {
  return {
    round: 3,
    machineGate: "PASS",
    productGate: "PASS",
    consecutiveProductNotRun: 0,
    productIssues: [],
    recentWorkKinds: [],
    obligations: [obligation("task:a")],
    ...overrides,
  };
}

describe("V4 P0 obligation restructuring", () => {
  it("builds the lineage chain with sequential dependencies", () => {
    const chain = p0ChainObligations(4, [P0_ISSUE]);
    expect(chain.map((item) => item.id)).toEqual(
      P0_OBLIGATION_CHAIN.map((step) => `v4-p0:${step}`)
    );
    expect(chain[0].dependencies).toEqual([]);
    expect(chain[1].dependencies).toEqual(["v4-p0:TRACE_PRODUCT_LINEAGE"]);
    expect(chain[0].priority).toBe(P0_OBLIGATION_PRIORITY);
    expect(chain.at(-1)!.priority).toBeLessThan(P0_OBLIGATION_PRIORITY);
    expect(chain[0].evidence).toContain("corruption:RECURSIVE_CONTENT");
  });

  it("leaves obligations untouched without a P0 issue", () => {
    const list = [obligation("task:a", 5), obligation("task:b", 2)];
    expect(reprioritiseObligationsForP0(list, [], 1)).toEqual(list);
  });

  it("puts the chain first and caps everything else below it", () => {
    const list = [obligation("task:a", 9999), obligation("task:b", 3)];
    const next = reprioritiseObligationsForP0(list, [P0_ISSUE], 2);
    expect(next.slice(0, P0_OBLIGATION_CHAIN.length).map((i) => i.id)).toEqual(
      P0_OBLIGATION_CHAIN.map((step) => `v4-p0:${step}`)
    );
    const rest = next.slice(P0_OBLIGATION_CHAIN.length);
    expect(rest.every((item) => (item.priority ?? 0) <= P0_DEMOTED_PRIORITY_CAP)).toBe(
      true
    );
    expect(rest.map((item) => item.id)).toEqual(["task:a", "task:b"]);
  });

  it("does not duplicate the chain when one is already present", () => {
    const once = reprioritiseObligationsForP0(
      [obligation("task:a")],
      [P0_ISSUE],
      2
    );
    const twice = reprioritiseObligationsForP0(once, [P0_ISSUE], 3);
    const ids = twice.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(twice.filter((item) => item.id.startsWith("v4-p0:"))).toHaveLength(
      P0_OBLIGATION_CHAIN.length
    );
  });

  // Rebuilding the chain must not reset progress, or the chain can never
  // advance past its first step.
  it("preserves the recorded status of steps already on the chain", () => {
    const started = reprioritiseObligationsForP0(
      [obligation("task:a")],
      [P0_ISSUE],
      1
    );
    const advanced = started.map((item) =>
      item.id === "v4-p0:TRACE_PRODUCT_LINEAGE"
        ? { ...item, status: "PASS" as const }
        : item
    );
    const next = reprioritiseObligationsForP0(advanced, [P0_ISSUE], 2);
    const trace = next.find(
      (item) => item.id === "v4-p0:TRACE_PRODUCT_LINEAGE"
    );
    expect(trace?.status).toBe("PASS");
    expect(next.filter((item) => item.id.startsWith("v4-p0:"))).toHaveLength(
      P0_OBLIGATION_CHAIN.length
    );
    // The remaining steps are still fresh, so the chain can continue.
    const root = next.find((item) => item.id === "v4-p0:ROOT_CAUSE");
    expect(root?.status).toBe("RUNNABLE");
  });
});

describe("V4 round decision", () => {
  it("is clean when machine and product both pass", () => {
    const decision = evaluateV4Round(round());
    expect(decision.mustStopExpanding).toBe(false);
    expect(decision.stopSignal).toBeUndefined();
    expect(decision.release.readiness).toBe("RELEASE_READY");
    expect(decision.suppressedWork).toEqual([]);
    expect(decision.obligations.map((item) => item.id)).toEqual(["task:a"]);
  });

  it("blocks release on machine PASS + product FAIL without stopping work", () => {
    const decision = evaluateV4Round(round({ productGate: "FAIL" }));
    expect(decision.release.readiness).toBe("RELEASE_BLOCKED");
    expect(decision.mustStopExpanding).toBe(false);
  });

  // Regression 3 — P0 suppresses release-class work and reprioritises.
  it("activates the P0 chain and suppresses peripheral work", () => {
    const decision = evaluateV4Round(round({ productIssues: [P0_ISSUE] }));
    expect(decision.p0.active).toBe(true);
    expect(decision.mustStopExpanding).toBe(true);
    expect(decision.stopSignal).toBe("P0_PRODUCT_CORRUPTION");
    expect(decision.suppressedWork).toEqual(P0_SUPPRESSED_WORK);
    expect(decision.nextObligationId).toBe("v4-p0:TRACE_PRODUCT_LINEAGE");
    expect(isWorkAllowed("RELEASE", decision)).toBe(false);
    expect(isWorkAllowed("NEW_FEATURE", decision)).toBe(false);
  });

  // Regression 2 (integration) — two unrun rounds stop expansion.
  it("requires a product anchor after two unrun rounds", () => {
    const decision = evaluateV4Round(
      round({ productGate: "NOT_RUN", consecutiveProductNotRun: 2 })
    );
    expect(decision.mustStopExpanding).toBe(true);
    expect(decision.stopSignal).toBe("PRODUCT_ANCHOR_REQUIRED");
    expect(decision.suppressedWork).toEqual([]);
  });

  it("does not stop after a single unrun round", () => {
    const decision = evaluateV4Round(
      round({ productGate: "NOT_RUN", consecutiveProductNotRun: 1 })
    );
    expect(decision.mustStopExpanding).toBe(false);
  });

  it("flags goal drift when only peripheral work happened", () => {
    const decision = evaluateV4Round(
      round({
        productGate: "NOT_RUN",
        recentWorkKinds: ["MUTEX", "PORT", "PACKAGING_METADATA"],
      })
    );
    expect(decision.goalDrift).toBe("FAIL");
    expect(decision.mustStopExpanding).toBe(true);
    expect(decision.stopSignal).toBe("GOAL_DRIFT");
  });

  it("ranks corruption above a missing anchor above drift", () => {
    const decision = evaluateV4Round(
      round({
        productGate: "NOT_RUN",
        consecutiveProductNotRun: 5,
        recentWorkKinds: ["HASHES"],
        productIssues: [P0_ISSUE],
      })
    );
    expect(decision.stopSignal).toBe("P0_PRODUCT_CORRUPTION");
    expect(decision.anchor.required).toBe(true);
    expect(decision.goalDrift).toBe("FAIL");
    expect(decision.reasons.length).toBeGreaterThan(1);
  });

  it("does not flag drift once the product gate has passed", () => {
    const decision = evaluateV4Round(
      round({ productGate: "PASS", recentWorkKinds: ["MUTEX", "HASHES"] })
    );
    expect(decision.goalDrift).toBe("PASS");
    expect(decision.mustStopExpanding).toBe(false);
  });
});
