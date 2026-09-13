import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { writeJsonAtomic } from "./atomic-json.js";

export interface ActiveWriterLock {
  version: 1;
  run_id: string;
  run_state_path: string;
  pid: number;
  hostname: string;
  cwd: string;
  started_at: string;
  updated_at: string;
}

export type LockKind =
  | "none"
  | "unreadable"
  | "cross_host"
  | "live_same_run"
  | "live_different_run"
  | "stale_same_host"
  | "stale_different_run";
export interface LockInspection {
  kind: LockKind;
  lock?: ActiveWriterLock;
  detail?: string;
}

export class ActiveWriterLockError extends Error {
  constructor(public readonly inspection: LockInspection) {
    super(`active writer lock: ${inspection.kind}`);
    this.name = "ActiveWriterLockError";
  }
}

function lockPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".ralph", "chief-active-run.lock");
}
async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function validLock(value: unknown): value is ActiveWriterLock {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.run_id === "string" &&
    typeof v.run_state_path === "string" &&
    typeof v.pid === "number" &&
    typeof v.hostname === "string" &&
    typeof v.cwd === "string" &&
    typeof v.started_at === "string" &&
    typeof v.updated_at === "string"
  );
}

export async function inspectActiveWriterLock(
  runDir: string,
  requestedRunId?: string
): Promise<LockInspection> {
  const path = lockPath(runDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "none" };
    return { kind: "unreadable", detail: String(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return { kind: "unreadable", detail: String(error) };
  }
  if (!validLock(parsed))
    return { kind: "unreadable", detail: "invalid lock metadata" };
  if (parsed.hostname !== hostname())
    return { kind: "cross_host", lock: parsed };
  const live = await processIsAlive(parsed.pid);
  const sameRun =
    requestedRunId !== undefined && parsed.run_id === requestedRunId;
  return {
    kind: live
      ? sameRun
        ? "live_same_run"
        : "live_different_run"
      : sameRun
        ? "stale_same_host"
        : "stale_different_run",
    lock: parsed,
  };
}

export async function acquireActiveWriterLock(
  projectRoot: string,
  metadata: Pick<ActiveWriterLock, "run_id" | "run_state_path">
): Promise<ActiveWriterLock> {
  await mkdir(dirname(lockPath(projectRoot)), { recursive: true });
  const normalizedRoot = resolve(projectRoot);
  const now = new Date().toISOString();
  const lock: ActiveWriterLock = {
    version: 1,
    ...metadata,
    pid: process.pid,
    hostname: hostname(),
    cwd: normalizedRoot,
    started_at: now,
    updated_at: now,
  };
  try {
    const handle = await open(lockPath(normalizedRoot), "wx");
    try {
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const inspection = await inspectActiveWriterLock(
      projectRoot,
      metadata.run_id
    );
    throw new ActiveWriterLockError(inspection);
  }
}

export async function refreshActiveWriterLock(
  projectRoot: string,
  owner: Pick<ActiveWriterLock, "run_id" | "pid" | "hostname">
): Promise<ActiveWriterLock> {
  const inspection = await inspectActiveWriterLock(projectRoot, owner.run_id);
  if (
    !inspection.lock ||
    inspection.kind !== "live_same_run" ||
    inspection.lock.pid !== owner.pid ||
    inspection.lock.hostname !== owner.hostname
  )
    throw new ActiveWriterLockError(inspection);
  const next = { ...inspection.lock, updated_at: new Date().toISOString() };
  await writeJsonAtomic(lockPath(projectRoot), next);
  return next;
}

export async function releaseActiveWriterLock(
  projectRoot: string,
  owner: Pick<ActiveWriterLock, "run_id" | "pid" | "hostname">
): Promise<boolean> {
  const inspection = await inspectActiveWriterLock(projectRoot, owner.run_id);
  if (
    !inspection.lock ||
    inspection.lock.run_id !== owner.run_id ||
    inspection.lock.pid !== owner.pid ||
    inspection.lock.hostname !== owner.hostname
  )
    return false;
  await rm(lockPath(projectRoot), { force: true });
  return true;
}

export async function clearStaleActiveWriterLock(
  projectRoot: string,
  staleEvidence: LockInspection
): Promise<boolean> {
  if (
    (staleEvidence.kind !== "stale_same_host" &&
      staleEvidence.kind !== "stale_different_run") ||
    !staleEvidence.lock
  )
    return false;
  const expected = staleEvidence.lock;
  const inspection = await inspectActiveWriterLock(
    projectRoot,
    expected.run_id
  );
  if (
    inspection.kind !== "stale_same_host" &&
    inspection.kind !== "stale_different_run"
  )
    return false;
  if (
    !inspection.lock ||
    inspection.lock.run_id !== expected.run_id ||
    inspection.lock.pid !== expected.pid ||
    inspection.lock.hostname !== expected.hostname
  )
    return false;
  await rm(lockPath(projectRoot), { force: true });
  return true;
}

export function activeWriterLockPath(projectRoot: string): string {
  return lockPath(projectRoot);
}
