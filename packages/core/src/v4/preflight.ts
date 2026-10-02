/**
 * Ralph V4 — preflight.
 *
 * The seam that makes the V4 decision layer actually affect a run. It is called
 * from the CLI entry point before a run starts: when the run is in V4 mode and
 * the durable Product Anchor record shows the product gate has gone unrun for
 * the threshold number of consecutive rounds, the run is *refused* instead of
 * being allowed to keep expanding.
 *
 * This is deliberately the smallest honest wiring. V4's decision functions are
 * pure; this module is the one place they read durable state and produce an
 * effect a user can observe — a run that will not start.
 */

import { loadAnchorRecord } from "./anchor-store.js";
import type { V4Signal } from "./domain.js";
import {
  evaluateProductAnchorRequirement,
  type ProductAnchorRequirement,
} from "./policy.js";

export interface V4PreflightInput {
  /** Host repo the run will work in; holds the run's durable anchor record. */
  workspaceDir: string;
  runId: string;
}

export interface V4PreflightResult {
  blocked: boolean;
  signal?: V4Signal;
  reason?: string;
  consecutiveProductNotRun: number;
  recordedAnchors: number;
}

/**
 * Read the durable anchor record and decide whether V4 lets this run start.
 * A run with a clean or absent record always starts; only an overdue product
 * anchor stops it.
 */
export async function evaluateV4Preflight(
  input: V4PreflightInput
): Promise<V4PreflightResult> {
  const record = await loadAnchorRecord(input.workspaceDir, input.runId);
  const requirement: ProductAnchorRequirement =
    evaluateProductAnchorRequirement(record.consecutive_product_not_run);
  return {
    blocked: requirement.required,
    signal: requirement.signal,
    reason: requirement.reason,
    consecutiveProductNotRun: record.consecutive_product_not_run,
    recordedAnchors: record.anchors.length,
  };
}

/** The message a blocked run fails with — actionable, not just a stop. */
export function v4PreflightError(result: V4PreflightResult): string {
  return [
    `${result.signal}: the product gate has not been run for ${result.consecutiveProductNotRun} consecutive rounds`,
    "V4 refuses to start another round of development until the real artifact has been inspected.",
    "Record a Product Anchor (anchor-store recordAnchor) with a real product verdict, or unset RUN_MODE to fall back to V3.",
  ].join("\n");
}
