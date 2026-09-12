import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export type AcceptanceControls = {
  protectedPaths?: string[];
  forbiddenPaths?: string[];
  /** Optional per-stage growth limit for an unexpected patch. */
  maxDiffBytes?: number;
  /** Optional per-stage changed-path limit for an unexpected patch. */
  maxChangedPaths?: number;
};

export type RepoSnapshot = {
  branch: string;
  head: string;
  status: string;
  diffStat: string;
  diff: string;
  files: Map<string, string>;
};

export type GuardViolation = {
  kind: "protected" | "forbidden" | "branch" | "large-diff";
  path: string;
};

/** Host-side guard covering committed, staged, unstaged, and untracked edits. */
export class GitGuard {
  private readonly baseline: RepoSnapshot;

  constructor(
    private readonly workspaceDir: string,
    private readonly controls: AcceptanceControls = {}
  ) {
    this.baseline = this.snapshot();
  }

  snapshot(): RepoSnapshot {
    return {
      branch:
        git(this.workspaceDir, ["symbolic-ref", "--short", "-q", "HEAD"]) ||
        "-",
      head: git(this.workspaceDir, ["rev-parse", "HEAD"]) || "-",
      status: git(this.workspaceDir, ["status", "--porcelain=v1"]),
      diffStat: git(this.workspaceDir, ["diff", "--stat", "HEAD"]),
      diff: git(this.workspaceDir, ["diff", "--binary", "HEAD"]),
      files: snapshotFiles(this.workspaceDir),
    };
  }

  changedPaths(before: RepoSnapshot, after = this.snapshot()): string[] {
    const paths = new Set<string>([
      ...before.files.keys(),
      ...after.files.keys(),
    ]);
    return [...paths]
      .filter((path) => before.files.get(path) !== after.files.get(path))
      .sort();
  }

  violations(before: RepoSnapshot, after = this.snapshot()): GuardViolation[] {
    const changed = this.changedPaths(before, after);
    const protectedSet = new Set(
      (this.controls.protectedPaths ?? []).map(normalizePattern)
    );
    const forbidden = this.controls.forbiddenPaths ?? [];
    const violations: GuardViolation[] = [];
    if (before.branch !== after.branch) {
      violations.push({ kind: "branch", path: after.branch });
    }
    if (
      this.controls.maxChangedPaths !== undefined &&
      changed.length > this.controls.maxChangedPaths
    ) {
      violations.push({
        kind: "large-diff",
        path: `${changed.length} changed paths`,
      });
    }
    const diffGrowth = Math.max(
      0,
      Buffer.byteLength(after.diff) - Buffer.byteLength(before.diff)
    );
    if (
      this.controls.maxDiffBytes !== undefined &&
      diffGrowth > this.controls.maxDiffBytes
    ) {
      violations.push({ kind: "large-diff", path: `${diffGrowth} diff bytes` });
    }
    for (const path of changed) {
      if (protectedSet.has(path)) violations.push({ kind: "protected", path });
      else if (matchesAny(path, forbidden))
        violations.push({ kind: "forbidden", path });
    }
    return violations;
  }

  initialSnapshot(): RepoSnapshot {
    return this.baseline;
  }
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function snapshotFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === ".ralph" ||
        entry.name === ".ralph-tmp"
      )
        continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        files.set(relative(root, path).replaceAll("\\", "/"), hash(path));
      }
    }
  };
  visit(root);
  return files;
}

function hash(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "<unreadable>";
  }
}

function normalizePattern(pattern: string): string {
  const value = pattern.replaceAll("\\", "/");
  return isAbsolute(value)
    ? value
    : value.replace(/^\.\//, "").replace(/\/$/, "");
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((raw) => {
    const pattern = normalizePattern(raw);
    if (!pattern) return false;
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
      .join(".*");
    return (
      new RegExp(`^(?:${escaped})(?:/|$)`).test(path) ||
      new RegExp(`(?:^|/)${escaped}$`).test(path)
    );
  });
}
