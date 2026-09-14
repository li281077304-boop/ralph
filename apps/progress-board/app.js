const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]
  );
const statusLabel = (s) => s;
function milestoneHtml(m) {
  return `<details class="milestone"><summary><i class="status-dot ${esc(m.status)}"></i><span class="m-title">${esc(m.title)}</span><span class="m-status">${esc(statusLabel(m.status))}</span></summary><div class="evidence">${esc(m.evidence || "NO EVIDENCE")}</div></details>`;
}
function projectHtml(p) {
  const run = p.currentRun;
  const runLine = run
    ? `${run.phase || "—"} · round ${run.round ?? "—"}`
    : p.repo?.remoteHead
      ? `远端证据 · ${p.repo.branch || "—"}`
      : "NO EVIDENCE";
  return `<article class="project"><div class="project-head"><div><h3>${esc(p.name)}</h3><small>${esc(runLine)}</small></div>${p.status ? `<span class="badge ${esc(p.status)}">${esc(p.status)}</span>` : ""}</div><div class="milestones">${p.milestones.map(milestoneHtml).join("")}</div></article>`;
}
function render(d) {
  document.querySelector("#updated").textContent =
    `更新于 ${new Date(d.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  document.querySelector("#doing").textContent =
    d.payroll.currentRun?.phase === "WAITING_FOR_CHIEF"
      ? "July 规则重建等待外部总工选择"
      : "三个项目证据汇总";
  document.querySelector("#why").textContent =
    "只读聚合真实仓库、Run、测试与交付物证据。";
  document.querySelector("#next").textContent = d.payroll.nextStep;
  document.querySelector("#nextReason").textContent = d.payroll.nextReason;
  document.querySelector("#score").innerHTML = Object.entries(d.counts)
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`)
    .join("");
  document.querySelector("#projects").innerHTML = [
    d.payroll,
    d.ralph,
    d.dashboard,
  ]
    .map(projectHtml)
    .join("");
  document.querySelector("#timeline").innerHTML = d.timeline
    .map((x) => `<li>${esc(x)}</li>`)
    .join("");
  document.querySelector("#git").innerHTML = [d.payroll, d.ralph, d.dashboard]
    .map(
      (p) =>
        `<div class="git-card"><b>${esc(p.name)}</b><code>${esc(p.repo.head ? `LOCAL ${p.repo.head}` : p.repo.remoteHead ? `REMOTE ${p.repo.remoteHead}` : "NO EVIDENCE")}</code><div>${esc(p.repo.branch || "—")}</div><div class="${p.repo.divergence !== "IN SYNC" ? "warn" : ""}">${esc(p.repo.divergence)}</div><div>${p.repo.dirtyFiles.length ? `DIRTY: ${p.repo.dirtyFiles.length}` : "CLEAN"}</div></div>`
    )
    .join("");
  document.querySelector("#deliverables").innerHTML = [
    [
      "Payroll",
      "工资核算 UI · 真实模板导出",
      "/Users/macos/Desktop/工资导出/2026年7月规则重建验证-命名版本-隔离.xlsx",
    ],
    [
      "Ralph",
      "Big Loop / V3 CLI",
      "node apps/cli/bin/ralph-chief-v3-loop.js …",
    ],
    ["Dashboard", "当前 fixture / prototype", "尚未正式部署"],
  ]
    .map(
      ([a, b, c]) =>
        `<div class="deliverable"><b>${a}</b><span>${b}<br>${esc(c)}</span></div>`
    )
    .join("");
  document.querySelector("#footerPath").textContent = d.root;
}
fetch("/api/state")
  .then((r) => r.json())
  .then(render)
  .catch((e) => {
    document.querySelector("#doing").textContent = "无法读取本地证据";
    document.querySelector("#why").textContent = e.message;
  });
