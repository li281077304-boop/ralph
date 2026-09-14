import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const root = path.resolve(process.env.PROGRESS_BOARD_ROOT || process.cwd());
const boardDir = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(boardDir, "project-status.json");
const port = Number(process.env.PROGRESS_BOARD_PORT || 4173);

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function git(repo, args) {
  try {
    const { stdout } = await exec("git", ["-C", repo, ...args], {
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}
async function repoStatus(repo, remoteHint = null, branchHint = null) {
  const top = await git(repo, ["rev-parse", "--show-toplevel"]);
  if (!top || path.resolve(top) !== path.resolve(repo)) {
    let remoteHead = null;
    if (remoteHint && branchHint) {
      try {
        const { stdout } = await exec(
          "git",
          ["ls-remote", remoteHint, `refs/heads/${branchHint}`],
          { maxBuffer: 1024 * 1024 }
        );
        remoteHead = stdout.trim().split(/\s+/)[0] || null;
      } catch {}
    }
    return {
      repo,
      branch: branchHint,
      head: null,
      remoteUrl: remoteHint,
      remoteHead,
      dirtyFiles: [],
      ahead: null,
      behind: null,
      divergence: remoteHead
        ? "REMOTE EVIDENCE AVAILABLE / LOCAL CHECKOUT NOT FOUND"
        : "NO EVIDENCE",
    };
  }
  const branch = await git(repo, ["branch", "--show-current"]);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const porcelain = await git(repo, ["status", "--porcelain"]);
  const remoteUrl = await git(repo, ["remote", "get-url", "origin"]);
  const remoteHead =
    branch &&
    (await git(repo, ["ls-remote", "origin", `refs/heads/${branch}`]));
  const remoteSha = remoteHead ? remoteHead.split(/\s+/)[0] : null;
  let ahead = null,
    behind = null;
  if (branch && remoteSha) {
    const counts = await git(repo, [
      "rev-list",
      "--left-right",
      "--count",
      `origin/${branch}...HEAD`,
    ]);
    if (counts) {
      const [b, a] = counts.split(/\s+/).map(Number);
      behind = b;
      ahead = a;
    }
  }
  return {
    repo,
    branch,
    head,
    remoteUrl,
    remoteHead: remoteSha,
    dirtyFiles: porcelain ? porcelain.split("\n").filter(Boolean) : [],
    ahead,
    behind,
    divergence: !head
      ? "NO EVIDENCE"
      : !remoteSha
        ? "LOCAL ONLY / REMOTE NOT FOUND"
        : remoteSha === head
          ? "IN SYNC"
          : "LOCAL / REMOTE DIFFER",
  };
}
function latestRun(stateDir) {
  return fs
    .readdir(stateDir, { withFileTypes: true })
    .then(async (entries) => {
      const runs = [];
      for (const e of entries)
        if (e.isDirectory()) {
          const file = path.join(stateDir, e.name, "RUN_STATE.json");
          try {
            const state = await readJson(file);
            runs.push({ ...state, runPath: file });
          } catch {}
        }
      return (
        runs.sort((a, b) =>
          String(b.updated_at || b.started_at).localeCompare(
            String(a.updated_at || a.started_at)
          )
        )[0] || null
      );
    })
    .catch(() => null);
}
async function buildState() {
  const manifest = await readJson(manifestPath);
  const payroll = {
    ...manifest.payroll,
    repo: await repoStatus(
      path.resolve(root, manifest.payroll.path),
      manifest.payroll.remote,
      manifest.payroll.branch
    ),
  };
  const ralph = {
    ...manifest.ralph,
    repo: await repoStatus(root, manifest.ralph.remote, manifest.ralph.branch),
  };
  const ralphState = await latestRun(path.join(root, ".ralph", "chief-runs"));
  if (ralphState) ralph.currentRun = ralphState;
  const payrollRoot = path.resolve(root, manifest.payroll.path);
  payroll.currentRun = await latestRun(
    path.join(payrollRoot, ".ralph", "chief-runs")
  );
  const dashboard = {
    ...manifest.dashboard,
    repo: await repoStatus(
      path.resolve(root, manifest.dashboard.path),
      manifest.dashboard.remote,
      manifest.dashboard.branch
    ),
  };
  const all = [
    ...payroll.milestones,
    ...ralph.milestones,
    ...dashboard.milestones,
  ];
  const counts = Object.fromEntries(
    [
      "DONE",
      "IN_PROGRESS",
      "BLOCKED",
      "DEFERRED",
      "NOT_TESTED",
      "NOT_PROVEN",
      "FAILED",
    ].map((s) => [s, all.filter((m) => m.status === s).length])
  );
  return {
    generatedAt: new Date().toISOString(),
    root,
    counts,
    payroll,
    ralph,
    dashboard,
    timeline: [
      "Payroll August core UAT PASS",
      "真实模板公式导出 PASS",
      "Ralph Final Review recovery PASS",
      "Dashboard integration contract frozen",
      "July rule reconstructed",
      "July historical reproduction blocked by period mismatch",
    ],
  };
}
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/state") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(await buildState()));
      return;
    }
    const requested =
      req.url === "/" ? "index.html" : req.url.replace(/^\//, "");
    const file = path.resolve(boardDir, requested);
    if (!file.startsWith(boardDir)) throw new Error("not found");
    const body = await fs.readFile(file);
    res.writeHead(200, {
      "content-type": mime[path.extname(file)] || "text/plain; charset=utf-8",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Progress Board: http://127.0.0.1:${port}`)
);
