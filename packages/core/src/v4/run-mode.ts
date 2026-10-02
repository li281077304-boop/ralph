/**
 * Ralph V4 — run mode.
 *
 * V4 is opt-in. A run is V3 unless it explicitly declares `RALPH_V4`, so the
 * existing V3 orchestration keeps its behaviour untouched (V4 doctrine §12:
 * opt-in mode, clean feature boundary — never silently convert old runs).
 *
 * The mode is resolved from two places, in order:
 *
 *   1. `RALPH_RUN_MODE` — the configuration entry point; an operator can turn
 *      V4 on for a whole session without editing the task text.
 *   2. `RUN_MODE: RALPH_V4` — a line in the task/plan the run was handed, so a
 *      task can carry its own rule set instead of the user pasting the doctrine
 *      into every prompt.
 *
 * Parsing is pure; reading a plan file is the caller's job. An unrecognised
 * explicit value is an error rather than a silent fallback to V3 — a run that
 * believes it enabled V4 must not quietly continue without it.
 */

export const RUN_MODES = ["RALPH_V3", "RALPH_V4"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const DEFAULT_RUN_MODE: RunMode = "RALPH_V3";

export const RUN_MODE_ENV_VAR = "RALPH_RUN_MODE";

/** `RUN_MODE: RALPH_V4` on a line of its own, case-insensitive on the key. */
const RUN_MODE_DECLARATION = /^[ \t]*RUN_MODE[ \t]*:[ \t]*(RALPH_V[34])[ \t]*$/im;

export function isRunMode(value: unknown): value is RunMode {
  return (
    typeof value === "string" && (RUN_MODES as readonly string[]).includes(value)
  );
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

/** Read the mode declared inside a task body or plan, if any. */
export function parseRunMode(text: string | undefined): RunMode | undefined {
  if (!text) return undefined;
  const match = RUN_MODE_DECLARATION.exec(text);
  if (!match) return undefined;
  const candidate = normalize(match[1]);
  return isRunMode(candidate) ? candidate : undefined;
}

export interface ResolveRunModeInput {
  /** Raw `RALPH_RUN_MODE` value, if set. */
  env?: string | undefined;
  /** Task body or plan contents, if the caller read one. */
  inputs?: string | undefined;
}

/**
 * Resolve the effective mode. Priority: explicit env → task declaration →
 * V3.
 */
export function resolveRunMode(input: ResolveRunModeInput = {}): RunMode {
  if (input.env !== undefined && input.env.trim() !== "") {
    const fromEnv = normalize(input.env);
    if (!isRunMode(fromEnv))
      throw new Error(
        `${RUN_MODE_ENV_VAR} must be one of ${RUN_MODES.join(" | ")}, got "${input.env}"`
      );
    return fromEnv;
  }
  return parseRunMode(input.inputs) ?? DEFAULT_RUN_MODE;
}

/**
 * What a run mode turns on. V3 turns nothing on here — the V3 orchestration is
 * always present, these flags describe only the V4 additions.
 */
export interface V4Capabilities {
  runMode: RunMode;
  /** Periodic PRODUCT_ANCHOR_CHECK every two rounds. */
  productAnchor: boolean;
  /** Gate 2 over the real artifact, with PASS/FAIL/NOT_RUN/BLOCKED. */
  productGate: boolean;
  /** P0 corruption stop-loss and obligation reprioritisation. */
  p0StopLoss: boolean;
  /** Three-judgement chief contract with an injected evidence pack. */
  v4Chief: boolean;
}

export function resolveV4Capabilities(runMode: RunMode): V4Capabilities {
  const enabled = runMode === "RALPH_V4";
  return {
    runMode,
    productAnchor: enabled,
    productGate: enabled,
    p0StopLoss: enabled,
    v4Chief: enabled,
  };
}

/**
 * One line an operator can see in the log to confirm what actually activated.
 *
 * It distinguishes what this loop *enforces* from what V4 merely *makes
 * available*: the afk loop has no chief stage, so the three-judgement chief
 * contract is consumed by the chief flow, not here. Saying otherwise would
 * advertise a guarantee the loop does not provide.
 */
export function describeV4Capabilities(capabilities: V4Capabilities): string {
  if (capabilities.runMode === "RALPH_V3")
    return "run mode RALPH_V3 (V3 orchestration only; Product Anchor/Gate disabled)";
  const enforced = ["Product Anchor", "Product Gate", "P0 stop-loss"];
  return [
    `run mode RALPH_V4 (V3 orchestration + ${enforced.join(", ")} enforced by the loop)`,
    "  V4 chief contract available for the chief flow (the afk loop runs no chief stage)",
  ].join("\n");
}
