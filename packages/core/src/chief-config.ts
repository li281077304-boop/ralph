import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentName } from "./agents/index.js";

export type ChiefMode = "codex" | "external";

export type ChiefAgentConfig = {
  agent: AgentName;
  model?: string;
  reasoning_effort?: string;
};

export type ChiefConfig = {
  chief_mode: ChiefMode;
  max_iterations: number;
  max_total_tokens?: number;
  timeout_seconds: number;
  commands: string[];
  uat_commands: string[];
  forbidden_paths: string[];
  required_clean_patterns: string[];
  gate_allowed_paths: string[];
  protected_paths: string[];
  max_diff_bytes?: number;
  max_changed_paths?: number;
  chief: ChiefAgentConfig;
  worker: ChiefAgentConfig;
};

const DEFAULT_CONFIG: ChiefConfig = {
  chief_mode: "codex",
  max_iterations: 6,
  timeout_seconds: 1800,
  commands: [],
  uat_commands: [],
  // Conservative defaults: real-data folders and spreadsheet payloads should
  // never enter an automated coding diff unless a future policy explicitly
  // changes this boundary.
  forbidden_paths: ["real_data/", "*.xlsx", "*.xls"],
  required_clean_patterns: [],
  gate_allowed_paths: [],
  protected_paths: [
    "CHIEF.md",
    "DECISIONS.md",
    "ACCEPTANCE.yaml",
    "ACCEPTANCE.yml",
    "TASK.md",
    "CHIEF_VERDICT.json",
  ],
  max_diff_bytes: 1_000_000,
  max_changed_paths: 1_000,
  chief: { agent: "codex", model: "gpt-5.6-sol", reasoning_effort: "high" },
  worker: { agent: "codex" },
};

function scalar(raw: string): string | number | boolean {
  const value = raw.trim().replace(/^['"]|['"]$/g, "");
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * A deliberately small YAML reader for the documented acceptance shape. It
 * supports top-level scalars, top-level string lists, and one-level agent
 * mappings. This keeps the core dependency-free while rejecting unsupported
 * structures instead of silently ignoring them.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let section: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      if (!section || indent === 0 || !Array.isArray(result[section])) {
        throw new Error(`Unsupported YAML list placement: ${rawLine}`);
      }
      (result[section] as unknown[]).push(scalar(trimmed.slice(2)));
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon < 1) throw new Error(`Invalid YAML line: ${rawLine}`);
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();
    if (indent > 0) {
      if (
        !section ||
        typeof result[section] !== "object" ||
        Array.isArray(result[section])
      ) {
        throw new Error(`Unsupported YAML nesting: ${rawLine}`);
      }
      (result[section] as Record<string, unknown>)[key] = scalar(rawValue);
      continue;
    }
    section = undefined;
    if (rawValue === "") {
      result[key] = [];
      section = key;
    } else {
      result[key] = scalar(rawValue);
    }
    if (["chief", "worker"].includes(key) && rawValue === "") result[key] = {};
  }
  return result;
}

function strings(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${key} must be a list of strings`);
  }
  return value as string[];
}

function positiveInt(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function agentConfig(
  value: unknown,
  fallback: ChiefAgentConfig,
  key: string
): ChiefAgentConfig {
  if (value === undefined) return { ...fallback };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${key} must be a mapping`);
  const record = value as Record<string, unknown>;
  const agent = record.agent ?? fallback.agent;
  if (agent !== "codex" && agent !== "claude")
    throw new Error(`${key}.agent must be codex or claude`);
  const model = record.model ?? fallback.model;
  const reasoning = record.reasoning_effort ?? fallback.reasoning_effort;
  if (model !== undefined && typeof model !== "string")
    throw new Error(`${key}.model must be a string`);
  if (reasoning !== undefined && typeof reasoning !== "string")
    throw new Error(`${key}.reasoning_effort must be a string`);
  return {
    agent,
    model: model as string | undefined,
    reasoning_effort: reasoning as string | undefined,
  };
}

export function defaultChiefConfig(): ChiefConfig {
  return structuredClone(DEFAULT_CONFIG);
}

export function loadChiefConfig(path?: string): ChiefConfig {
  if (!path) return defaultChiefConfig();
  const absolute = resolve(path);
  if (!existsSync(absolute))
    throw new Error(`Acceptance config not found: ${absolute}`);
  const raw = readFileSync(absolute, "utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = parseSimpleYaml(raw);
  }
  const config = defaultChiefConfig();
  if (parsed.chief_mode !== undefined) {
    if (parsed.chief_mode !== "codex" && parsed.chief_mode !== "external")
      throw new Error("chief_mode must be codex or external");
    config.chief_mode = parsed.chief_mode;
  }
  config.max_iterations = positiveInt(
    parsed.max_iterations,
    "max_iterations",
    config.max_iterations
  );
  if (parsed.max_total_tokens !== undefined)
    config.max_total_tokens = positiveInt(
      parsed.max_total_tokens,
      "max_total_tokens",
      1
    );
  config.timeout_seconds = positiveInt(
    parsed.timeout_seconds,
    "timeout_seconds",
    config.timeout_seconds
  );
  config.commands = strings(parsed.commands, "commands");
  config.uat_commands = strings(parsed.uat_commands, "uat_commands");
  config.forbidden_paths = [
    ...new Set([
      ...config.forbidden_paths,
      ...strings(parsed.forbidden_paths, "forbidden_paths"),
    ]),
  ];
  config.required_clean_patterns = strings(
    parsed.required_clean_patterns,
    "required_clean_patterns"
  );
  config.gate_allowed_paths = strings(
    parsed.gate_allowed_paths,
    "gate_allowed_paths"
  );
  config.protected_paths = [
    ...new Set([
      ...config.protected_paths,
      ...strings(parsed.protected_paths, "protected_paths"),
    ]),
  ];
  if (parsed.max_diff_bytes !== undefined)
    config.max_diff_bytes = positiveInt(
      parsed.max_diff_bytes,
      "max_diff_bytes",
      config.max_diff_bytes ?? 1_000_000
    );
  if (parsed.max_changed_paths !== undefined)
    config.max_changed_paths = positiveInt(
      parsed.max_changed_paths,
      "max_changed_paths",
      config.max_changed_paths ?? 1_000
    );
  config.chief = agentConfig(parsed.chief, config.chief, "chief");
  config.worker = agentConfig(parsed.worker, config.worker, "worker");
  return config;
}
