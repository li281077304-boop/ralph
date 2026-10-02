import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUN_MODE,
  RUN_MODE_ENV_VAR,
  RUN_MODES,
  describeV4Capabilities,
  isRunMode,
  parseRunMode,
  resolveRunMode,
  resolveV4Capabilities,
} from "../v4/run-mode.js";

describe("run mode declaration parsing", () => {
  it("reads the declaration from a task body", () => {
    const task = [
      "# Task",
      "",
      "RUN_MODE: RALPH_V4",
      "",
      "Fix the handout duplication.",
    ].join("\n");
    expect(parseRunMode(task)).toBe("RALPH_V4");
  });

  it("accepts either mode and tolerates spacing/case", () => {
    expect(parseRunMode("run_mode : ralph_v4")).toBe("RALPH_V4");
    expect(parseRunMode("  Run_Mode:  RALPH_V3  ")).toBe("RALPH_V3");
  });

  it("only matches a declaration on its own line", () => {
    expect(parseRunMode("see RUN_MODE: RALPH_V4 above")).toBeUndefined();
  });

  it("returns undefined when nothing is declared", () => {
    expect(parseRunMode(undefined)).toBeUndefined();
    expect(parseRunMode("")).toBeUndefined();
    expect(parseRunMode("just a plan with no run mode")).toBeUndefined();
  });

  it("rejects an unknown mode value", () => {
    expect(parseRunMode("RUN_MODE: RALPH_V9")).toBeUndefined();
  });

  it("validates run mode values", () => {
    expect(isRunMode("RALPH_V4")).toBe(true);
    expect(RUN_MODES.every(isRunMode)).toBe(true);
    expect(isRunMode("V4")).toBe(false);
  });
});

describe("run mode resolution", () => {
  it("defaults to V3 when nothing is declared", () => {
    expect(resolveRunMode()).toBe("RALPH_V3");
    expect(DEFAULT_RUN_MODE).toBe("RALPH_V3");
  });

  it("reads the task declaration", () => {
    expect(resolveRunMode({ inputs: "RUN_MODE: RALPH_V4" })).toBe("RALPH_V4");
  });

  // The env var is the configuration entry point and outranks the task text.
  it("lets the environment variable override the task declaration", () => {
    expect(
      resolveRunMode({ env: "RALPH_V4", inputs: "RUN_MODE: RALPH_V3" })
    ).toBe("RALPH_V4");
    expect(
      resolveRunMode({ env: "RALPH_V3", inputs: "RUN_MODE: RALPH_V4" })
    ).toBe("RALPH_V3");
  });

  it("normalises the environment value", () => {
    expect(resolveRunMode({ env: " ralph_v4 " })).toBe("RALPH_V4");
  });

  // Fail closed: a run that asked for V4 must not silently continue as V3.
  it("refuses an unrecognised environment value", () => {
    expect(() => resolveRunMode({ env: "RALPH_V5" })).toThrow(
      new RegExp(RUN_MODE_ENV_VAR)
    );
    expect(() => resolveRunMode({ env: "yes" })).toThrow();
  });

  it("ignores an empty environment value", () => {
    expect(resolveRunMode({ env: "   " })).toBe("RALPH_V3");
  });
});

describe("V4 capabilities", () => {
  // Regression 9 — the legacy path turns nothing on.
  it("enables nothing under V3", () => {
    const capabilities = resolveV4Capabilities("RALPH_V3");
    expect(capabilities).toEqual({
      runMode: "RALPH_V3",
      productAnchor: false,
      productGate: false,
      p0StopLoss: false,
      v4Chief: false,
    });
    expect(describeV4Capabilities(capabilities)).toContain("RALPH_V3");
  });

  it("enables the whole V4 control plane under V4", () => {
    const capabilities = resolveV4Capabilities("RALPH_V4");
    expect(capabilities).toEqual({
      runMode: "RALPH_V4",
      productAnchor: true,
      productGate: true,
      p0StopLoss: true,
      v4Chief: true,
    });
    const described = describeV4Capabilities(capabilities);
    expect(described).toContain("RALPH_V4");
    for (const name of [
      "Product Anchor",
      "Product Gate",
      "P0 stop-loss",
      "V4 chief contract",
    ])
      expect(described).toContain(name);
    // The log must separate what the loop enforces from what it merely offers.
    expect(described).toContain("enforced by the loop");
    expect(described).toContain("available for the chief flow");
  });

  it("keeps V3 and V4 describable apart in the log", () => {
    expect(describeV4Capabilities(resolveV4Capabilities("RALPH_V3"))).not.toBe(
      describeV4Capabilities(resolveV4Capabilities("RALPH_V4"))
    );
  });
});
