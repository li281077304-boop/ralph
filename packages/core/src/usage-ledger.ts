import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type UsageLedgerEntry = {
  timestamp: string;
  role: "worker" | "chief" | "external_chief" | "codex_task";
  provider: string;
  model: string | null;
  reasoning_effort: string | null;
  phase: string;
  run_id: string | null;
  round: number | null;
  duration: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  tokens_available: boolean;
  fallback_from: string | null;
  failure_signature: string | null;
};

export function usageLedgerPath(root: string, runId?: string): string {
  return runId
    ? join(root, ".ralph", "chief-runs", runId, "usage-ledger.ndjson")
    : join(root, ".ralph", "usage-ledger.ndjson");
}

/** Append one durable, machine-readable model invocation record. Missing
 * provider token fields remain null and are explicitly marked unavailable. */
export async function recordUsageLedger(
  root: string,
  entry: UsageLedgerEntry
): Promise<string> {
  const path = usageLedgerPath(root, entry.run_id ?? undefined);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
  return path;
}

export type UsageLedgerSummary = {
  invocation_count: number;
  luna_invocation_count: number;
  external_chief_count: number;
  host_sol_count: number;
  host_sol_fallback_count: number;
  by_role: Record<string, number>;
  by_provider: Record<string, number>;
  duration_by_role: Record<string, number>;
  total_tokens: number | null;
};

/** Read the durable ledger and return deterministic role/provider totals. */
export async function summarizeUsageLedger(
  root: string,
  runId?: string
): Promise<UsageLedgerSummary> {
  const summary: UsageLedgerSummary = {
    invocation_count: 0,
    luna_invocation_count: 0,
    external_chief_count: 0,
    host_sol_count: 0,
    host_sol_fallback_count: 0,
    by_role: {},
    by_provider: {},
    duration_by_role: {},
    total_tokens: 0,
  };
  let text: string;
  try {
    text = await readFile(usageLedgerPath(root, runId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return summary;
    throw error;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: UsageLedgerEntry;
    try {
      entry = JSON.parse(line) as UsageLedgerEntry;
    } catch {
      continue;
    }
    summary.invocation_count += 1;
    if (entry.model === "gpt-5.6-luna") summary.luna_invocation_count += 1;
    if (entry.role === "external_chief") summary.external_chief_count += 1;
    if (entry.model === "gpt-5.6-sol") {
      summary.host_sol_count += 1;
      if (entry.fallback_from) summary.host_sol_fallback_count += 1;
    }
    summary.by_role[entry.role] = (summary.by_role[entry.role] ?? 0) + 1;
    summary.by_provider[entry.provider] =
      (summary.by_provider[entry.provider] ?? 0) + 1;
    if (typeof entry.duration === "number")
      summary.duration_by_role[entry.role] =
        (summary.duration_by_role[entry.role] ?? 0) + entry.duration;
    if (typeof entry.total_tokens === "number")
      summary.total_tokens = (summary.total_tokens ?? 0) + entry.total_tokens;
  }
  return summary;
}
