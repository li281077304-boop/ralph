import { spawn } from "node:child_process";

import { GitGuard } from "./git-guard.js";

export type GateCommandResult = {
  command: string;
  kind: "required" | "uat";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type MachineGateResult = {
  passed: boolean;
  commands: GateCommandResult[];
  /** Tracked product files changed by the gate process itself. */
  trackedChanges?: string[];
};

export type MachineGateOptions = {
  commands?: string[];
  uatCommands?: string[];
  /** Maximum duration for each command. */
  timeoutMs?: number;
  /** Explicitly permitted tracked artifacts produced by a gate. */
  allowedGeneratedPaths?: string[];
};

/** Execute trusted, user-configured shell gates without invoking a model. */
export async function runMachineGate(
  workspaceDir: string,
  options: MachineGateOptions = {}
): Promise<MachineGateResult> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const results: GateCommandResult[] = [];
  const guard = new GitGuard(workspaceDir);
  const before = guard.snapshot();
  let commandFailure = false;
  for (const command of options.commands ?? []) {
    const result = await runOne(command, "required", workspaceDir, timeoutMs);
    results.push(result);
    if (result.exitCode !== 0 || result.timedOut) {
      commandFailure = true;
      break;
    }
  }
  if (!commandFailure) {
    for (const command of options.uatCommands ?? []) {
      const result = await runOne(command, "uat", workspaceDir, timeoutMs);
      results.push(result);
      if (result.exitCode !== 0 || result.timedOut) {
        commandFailure = true;
        break;
      }
    }
  }
  const after = guard.snapshot();
  const trackedChanges = guard.trackedChangedPaths(before, after);
  const disallowedChanges = trackedChanges.filter(
    (path) => !matchesAny(path, options.allowedGeneratedPaths ?? [])
  );
  return {
    passed: !commandFailure && disallowedChanges.length === 0,
    commands: results,
    ...(trackedChanges.length ? { trackedChanges } : {}),
  };
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const pattern = raw.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!pattern) return false;
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^(?:${escaped})(?:/|$)`).test(path);
  });
}

function runOne(
  command: string,
  kind: "required" | "uat",
  cwd: string,
  timeoutMs: number
): Promise<GateCommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        command,
        kind,
        exitCode: timedOut ? 124 : exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}
