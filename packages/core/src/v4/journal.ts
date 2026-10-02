/**
 * Ralph V4 — durable run journal.
 *
 * The per-round journal contract has to reach durable storage, not just stdout:
 * a run that restarts, or a human opening the workspace later, must be able to
 * read what the previous rounds claimed about the product. Entries are appended
 * to `V4_JOURNAL.md` under the run's chief directory — one block per round,
 * beside the obligation ledger and the anchor record.
 *
 * Append-only on purpose: a journal that can be rewritten is not evidence.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { getChiefRunDir } from "../v3/rounds.js";
import type { RunJournalEntry } from "./domain.js";
import {
  buildRunJournalEntry,
  renderRunJournal,
  type BuildJournalInput,
} from "./policy.js";

export const V4_JOURNAL_FILENAME = "V4_JOURNAL.md";

export function journalPath(projectRoot: string, runId: string): string {
  return resolve(getChiefRunDir(projectRoot, runId), V4_JOURNAL_FILENAME);
}

/** Append one rendered journal block. Never rewrites earlier rounds. */
export async function appendJournalEntry(
  projectRoot: string,
  runId: string,
  entry: RunJournalEntry
): Promise<void> {
  const path = journalPath(projectRoot, runId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `\n---\n\n${renderRunJournal(entry)}\n`, "utf8");
}

/** Build and persist a journal entry in one step. */
export async function recordJournalEntry(
  projectRoot: string,
  runId: string,
  input: BuildJournalInput
): Promise<RunJournalEntry> {
  const entry = buildRunJournalEntry(input);
  await appendJournalEntry(projectRoot, runId, entry);
  return entry;
}

/** Read the journal back; empty string when the run has not journalled yet. */
export async function readJournal(
  projectRoot: string,
  runId: string
): Promise<string> {
  try {
    return await readFile(journalPath(projectRoot, runId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}
