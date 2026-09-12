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
  trackedFiles: Map<string, string>;
  untrackedFiles: Map<string, string>;
  files: Map<string, string>;
};

export type WorkspaceFingerprint = {
  head: string;
  trackedDiffHash: string;
  untrackedFiles: Record<string, string>;
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
    const files = snapshotFiles(this.workspaceDir);
    return {
      branch:
        git(this.workspaceDir, ["symbolic-ref", "--short", "-q", "HEAD"]) ||
        "-",
      head: git(this.workspaceDir, ["rev-parse", "HEAD"]) || "-",
      status: git(this.workspaceDir, ["status", "--porcelain=v1"]),
      diffStat: git(this.workspaceDir, ["diff", "--stat", "HEAD"]),
      diff: git(this.workspaceDir, ["diff", "--binary", "HEAD"]),
      trackedFiles: files.trackedFiles,
      untrackedFiles: files.untrackedFiles,
      files: new Map([...files.trackedFiles, ...files.untrackedFiles]),
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

  trackedChangedPaths(before: RepoSnapshot, after = this.snapshot()): string[] {
    const paths = new Set<string>([
      ...before.trackedFiles.keys(),
      ...after.trackedFiles.keys(),
    ]);
    return [...paths]
      .filter(
        (path) => before.trackedFiles.get(path) !== after.trackedFiles.get(path)
      )
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

function snapshotFiles(root: string): {
  trackedFiles: Map<string, string>;
  untrackedFiles: Map<string, string>;
} {
  const trackedFiles = new Map<string, string>();
  const untrackedFiles = new Map<string, string>();
  const trackedPaths = gitPaths(root, ["ls-files", "-z"]);
  const untrackedPaths = gitPaths(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (isGitWorktree(root)) {
    addListedFiles(root, trackedPaths, trackedFiles);
    addListedFiles(root, untrackedPaths, untrackedFiles);
    return { trackedFiles, untrackedFiles };
  }

  // GitGuard is also useful in small non-Git fixtures. Keep a deliberately
  // narrow fallback there; real repositories always use Git's ignore-aware
  // file lists above.
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
        untrackedFiles.set(
          relative(root, path).replaceAll("\\", "/"),
          hash(path)
        );
      }
    }
  };
  visit(root);
  return { trackedFiles, untrackedFiles };
}

function addListedFiles(
  root: string,
  paths: string[],
  target: Map<string, string>
): void {
  for (const path of paths) {
    const normalized = path.replaceAll("\\", "/");
    target.set(normalized, hash(join(root, normalized)));
  }
}

function gitPaths(cwd: string, args: string[]): string[] {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function isGitWorktree(cwd: string): boolean {
  try {
    return (
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

function hash(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "<unreadable>";
  }
}

export function workspaceFingerprint(
  snapshot: RepoSnapshot,
  excludedUntrackedPaths = ["CHIEF_VERDICT.json", "CHIEF_VERDICT.json.consumed"]
): WorkspaceFingerprint {
  const untrackedFiles: Record<string, string> = {};
  for (const [path, value] of [...snapshot.untrackedFiles].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    if (!excludedUntrackedPaths.includes(path)) untrackedFiles[path] = value;
  }
  return {
    head: snapshot.head,
    trackedDiffHash: createHash("sha256").update(snapshot.diff).digest("hex"),
    untrackedFiles,
  };
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
