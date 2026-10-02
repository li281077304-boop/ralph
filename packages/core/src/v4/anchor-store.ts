/**
 * Ralph V4 — durable Product Anchor store.
 *
 * The anchor cadence only works if it survives a restart. A run that is killed
 * and resumed (the supervisor restart matrix, a crash, an unattended recovery)
 * must not lose count of how many rounds have gone by without a product
 * verdict, or the anti-drift stop silently resets every time the process
 * bounces.
 *
 * The record therefore lives beside the obligation ledger under the run's chief
 * directory and is written atomically, the same way V3 persists its own state.
 */

import { resolve } from "node:path";

import { readJson, writeJsonAtomic } from "../v3/atomic-json.js";
import { getChiefRunDir } from "../v3/rounds.js";
import type { ProductAnchor } from "./domain.js";

export const V4_ANCHOR_VERSION = 1 as const;
export const V4_ANCHORS_FILENAME = "V4_ANCHORS.json";

export interface ProductAnchorRecord {
  version: typeof V4_ANCHOR_VERSION;
  run_id: string;
  anchors: ProductAnchor[];
  /**
   * Consecutive rounds the product gate has been `NOT_RUN`. Durable on purpose:
   * this is the counter `PRODUCT_ANCHOR_REQUIRED` reads.
   */
  consecutive_product_not_run: number;
  updated_at: string;
}

export function anchorsPath(projectRoot: string, runId: string): string {
  return resolve(getChiefRunDir(projectRoot, runId), V4_ANCHORS_FILENAME);
}

export function emptyAnchorRecord(runId: string): ProductAnchorRecord {
  return {
    version: V4_ANCHOR_VERSION,
    run_id: runId,
    anchors: [],
    consecutive_product_not_run: 0,
    updated_at: new Date().toISOString(),
  };
}

export class MalformedAnchorRecordError extends Error {
  readonly code = "MALFORMED_V4_ANCHOR_RECORD";
  constructor(message: string) {
    super(message);
    this.name = "MalformedAnchorRecordError";
  }
}

function isAnchor(value: unknown): value is ProductAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.round) &&
    typeof record.sha === "string" &&
    typeof record.user_value_delta === "string" &&
    typeof record.product_artifact === "string" &&
    typeof record.product_gate === "string" &&
    Array.isArray(record.product_issues) &&
    (record.goal_drift_check === "PASS" || record.goal_drift_check === "FAIL") &&
    typeof record.next_highest_value_action === "string"
  );
}

function assertRecord(
  value: unknown,
  runId: string
): asserts value is ProductAnchorRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MalformedAnchorRecordError("V4 anchor record is not an object");
  const record = value as Record<string, unknown>;
  if (
    record.version !== V4_ANCHOR_VERSION ||
    record.run_id !== runId ||
    !Array.isArray(record.anchors) ||
    !Number.isInteger(record.consecutive_product_not_run) ||
    (record.consecutive_product_not_run as number) < 0
  )
    throw new MalformedAnchorRecordError(
      "V4 anchor record identity is malformed"
    );
  if (!record.anchors.every(isAnchor))
    throw new MalformedAnchorRecordError("V4 anchor entry is malformed");
}

/** Load the record, or an empty one when the run has not anchored yet. */
export async function loadAnchorRecord(
  projectRoot: string,
  runId: string
): Promise<ProductAnchorRecord> {
  try {
    const parsed = await readJson(anchorsPath(projectRoot, runId));
    assertRecord(parsed, runId);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return emptyAnchorRecord(runId);
  }
}

export async function saveAnchorRecord(
  projectRoot: string,
  record: ProductAnchorRecord
): Promise<void> {
  assertRecord(record, record.run_id);
  await writeJsonAtomic(anchorsPath(projectRoot, record.run_id), {
    ...record,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Append an anchor and advance the unrun counter: a `NOT_RUN` product gate
 * increments it, any real verdict resets it to zero.
 */
export function appendAnchor(
  record: ProductAnchorRecord,
  anchor: ProductAnchor
): ProductAnchorRecord {
  return {
    ...record,
    anchors: [...record.anchors, anchor],
    consecutive_product_not_run:
      anchor.product_gate === "NOT_RUN"
        ? record.consecutive_product_not_run + 1
        : 0,
    updated_at: new Date().toISOString(),
  };
}

/** Record an anchor durably in one step. */
export async function recordAnchor(
  projectRoot: string,
  anchor: ProductAnchor,
  runId: string
): Promise<ProductAnchorRecord> {
  const next = appendAnchor(await loadAnchorRecord(projectRoot, runId), anchor);
  await saveAnchorRecord(projectRoot, next);
  return next;
}
