import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic, writeTextAtomic } from "./v3/atomic-json.js";

export type DevlogEntry = {
  root: string;
  directory: string;
  contextPath: string;
  agentTaskPath: string;
  taskHashPath: string;
  metadataPath: string;
  resultPath: string;
  decisionPath: string;
  taskHash: string;
  runId?: string;
  round?: number;
  taskId?: string;
  handoffHash?: string;
};

export type DevlogHandoffOptions = {
  root: string;
  slug: string;
  context: string;
  agentTask: string;
  runId?: string;
  round?: number;
  taskId?: string;
  handoffHash?: string;
  date?: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("Devlog slug must not be empty");
  return slug.slice(0, 80);
}

function dateLabel(value?: string): string {
  const label = value ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label))
    throw new Error("Devlog date must be YYYY-MM-DD");
  return label;
}

function normalizeContext(context: string): string {
  const sections = [
    "USER OBSERVATION",
    "CONFIRMED FACT",
    "TECHNICAL ASSESSMENT",
    "DECISION",
    "UNKNOWN",
  ];
  const missing = sections
    .filter((section) => !context.includes(section))
    .map((section) => `${section}\nN/A`);
  return missing.length ? `${context}\n\n${missing.join("\n\n")}` : context;
}

async function nextSequence(day: string, root: string): Promise<number> {
  const directory = join(root, "devlog", day);
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const numbers = names
    .map((name) => /^(\d{3})-/.exec(name)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .filter(Number.isFinite);
  return (numbers.length ? Math.max(...numbers) : 0) + 1;
}

async function appendIndex(root: string, line: string): Promise<void> {
  const path = join(root, "devlog", "INDEX.md");
  let current = "# Devlog Index\n\n";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!current.endsWith("\n")) current += "\n";
  await writeTextAtomic(path, `${current}${line}\n`);
}

export async function createDevlogHandoff(
  options: DevlogHandoffOptions
): Promise<DevlogEntry> {
  if (!options.root) throw new Error("Devlog root is required");
  if (!options.context) throw new Error("Devlog context is required");
  if (!options.agentTask) throw new Error("Devlog agent task is required");
  const day = dateLabel(options.date);
  let sequenceNumber: number;
  try {
    sequenceNumber = await nextSequence(day, options.root);
  } catch (error) {
    throw new Error(`DEVLOG_HANDOFF_WRITE_FAILED: ${String(error)}`, {
      cause: error,
    });
  }
  const sequence = String(sequenceNumber).padStart(3, "0");
  const directory = join(
    options.root,
    "devlog",
    day,
    `${sequence}-${safeSlug(options.slug)}`
  );
  const entry: DevlogEntry = {
    root: options.root,
    directory,
    contextPath: join(directory, "context.md"),
    agentTaskPath: join(directory, "agent-task.md"),
    taskHashPath: join(directory, "task-hash.txt"),
    metadataPath: join(directory, "metadata.json"),
    resultPath: join(directory, "result.md"),
    decisionPath: join(directory, "decision.md"),
    taskHash: sha256(options.agentTask),
    runId: options.runId,
    round: options.round,
    taskId: options.taskId,
    handoffHash: options.handoffHash,
  };
  try {
    await mkdir(join(options.root, "devlog", day), { recursive: true });
    await mkdir(directory, { recursive: false });
    await writeTextAtomic(entry.contextPath, normalizeContext(options.context));
    await writeTextAtomic(entry.agentTaskPath, options.agentTask);
    await writeTextAtomic(entry.taskHashPath, `${entry.taskHash}\n`);
    await writeJsonAtomic(entry.metadataPath, {
      version: 1,
      run_id: options.runId ?? null,
      round: options.round ?? null,
      task_id: options.taskId ?? null,
      handoff_hash: options.handoffHash ?? null,
      task_hash: entry.taskHash,
      created_at: new Date().toISOString(),
    });
    await validateDevlogHandoff(entry);
    const relative = directory.slice(join(options.root, "devlog").length + 1);
    await appendIndex(
      options.root,
      `- ${relative} — ${options.runId ?? "unbound"}/${options.round ?? "-"}/${options.taskId ?? "-"}${options.handoffHash ? `/${options.handoffHash}` : ""}`
    );
    return entry;
  } catch (error) {
    throw new Error(`DEVLOG_HANDOFF_WRITE_FAILED: ${String(error)}`, {
      cause: error,
    });
  }
}

export async function validateDevlogHandoff(entry: DevlogEntry): Promise<void> {
  await access(entry.contextPath, constants.F_OK);
  const task = await readFile(entry.agentTaskPath, "utf8");
  const recorded = (await readFile(entry.taskHashPath, "utf8")).trim();
  const actual = sha256(task);
  if (recorded !== actual || actual !== entry.taskHash)
    throw new Error("DEVLOG_TASK_HASH_MISMATCH");
  try {
    const metadata = JSON.parse(await readFile(entry.metadataPath, "utf8")) as {
      task_hash?: unknown;
    };
    if (metadata.task_hash !== actual)
      throw new Error("DEVLOG_METADATA_MISMATCH");
  } catch (error) {
    if (error instanceof Error && error.message === "DEVLOG_METADATA_MISMATCH")
      throw error;
    throw new Error("DEVLOG_METADATA_MISSING_OR_MALFORMED", { cause: error });
  }
}

export async function writeDevlogResult(
  entry: DevlogEntry,
  result: string
): Promise<void> {
  await validateDevlogHandoff(entry);
  await writeTextAtomic(entry.resultPath, result);
}

export async function writeDevlogDecision(
  entry: DevlogEntry,
  decision: string
): Promise<void> {
  await validateDevlogHandoff(entry);
  await writeTextAtomic(entry.decisionPath, decision);
}

export async function buildRecentDevlogContext(
  root: string,
  options: number | { limit?: number; maxChars?: number } = {}
): Promise<string> {
  const limit =
    typeof options === "number" ? options : Math.max(0, options.limit ?? 3);
  const maxChars =
    typeof options === "number"
      ? 12_000
      : Math.max(512, options.maxChars ?? 12_000);
  try {
    const index = await readFile(join(root, "devlog", "INDEX.md"), "utf8");
    const lines = index
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .slice(-Math.max(0, limit));
    if (!lines.length) return "Recent devlog entries: none";
    const entries = [];
    for (const line of lines) {
      let relative = line.slice(2).split(" — ", 1)[0].trim();
      if (relative.startsWith("devlog/")) relative = relative.slice(7);
      if (!relative) continue;
      const directory = join(root, "devlog", relative);
      let context = "";
      let decision = "";
      let result = "";
      try {
        context = await readFile(join(directory, "context.md"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        decision = await readFile(join(directory, "decision.md"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        result = await readFile(join(directory, "result.md"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      entries.push(`${line}\n${context}\n${decision}\n${result}`.trim());
    }
    const header = "Recent devlog context (read from disk):\n";
    let output = header;
    for (const entry of entries) {
      const separator = output === header ? "" : "\n\n";
      const remaining = maxChars - output.length - separator.length;
      if (remaining <= 0) break;
      output += `${separator}${entry.slice(0, remaining)}`;
      if (entry.length > remaining) break;
    }
    return output;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return "Recent devlog entries: none";
    throw error;
  }
}
