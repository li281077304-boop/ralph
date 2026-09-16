# Result

## Ralph architecture

- branch: `feature/ralph-v3-supervisor-dashboard`
- base at implementation start: `e135faa61266bc1e95d01a3d01bacbb54096debb`
- final Ralph HEAD: `823dbe06fe4ae105660800c1d86223f06f181109`
- supervisor: `apps/cli/bin/ralph-v3-supervisor.js`
- real kill/restart scenarios: 3/3 PASS (Worker, Chief handoff/reply boundary, Machine Gate/checkpoint boundary; controlled child `SIGKILL`, restart from the same durable `RUN_STATE.json`)
- completed state was reached after one restart and was recorded in `SUPERVISOR_STATE.json`.
- Chief router: `apps/cli/bin/ralph-chief-v3-router.js`; focused routing tests PASS for External Warm, External Recovery, and Host fallback.

## Dashboard real product UAT

- source worktree: `/private/tmp/edu-ops-dashboard-real.ij9j7g`
- Ralph-owned worktree: `/private/tmp/edu-ops-dashboard-ralph-run`
- branch: `ralph/dashboard-real-uat`
- bootstrap commit: `ec1c99ecdaf1926fd3d4a1fa2475fa5e0ce7c1df`
- frozen input: `/Users/macos/Downloads/排课列表_08月31日到09月27日_202609131718.xls`
- SHA-256: `647075195f101c998474d0d57a4bef7206fb38bc8faab88713696bbd92698544`
- normalized/runtime result: 1092 rows, 44 teachers, period 2026-08-31..2026-09-27; cards 4043 production hours, 4188 planned hours, 1010.75 monthly average, 1047 monthly forecast, 0.07 weekly average lessons, 44 teachers.
- runtime: `http://localhost:8799/` and LAN `http://192.168.110.49:8799/`; `/healthz`, `/api/status`, desktop page, and mobile responsive CSS/AX snapshot PASS. Refresh retained the same source hash and card values.
- Android widget remains `TECHNICAL_OPEN`; no real device install was claimed.
- Dashboard business-rule exclusions remain `HUMAN_BLOCKED` from existing project evidence.

## Verification classification

- TESTED: Ralph focused tests (20), full suite (220), typecheck/build, Dashboard pytest (46), Dashboard ruff, real HTTP runtime and mobile viewport evidence.
- REAL-UAT-VERIFIED: Dashboard frozen-input → normalized payload → cards runtime on this machine.
- NOT-YET-VERIFIED: a long 3–5 hour Ralph Dashboard Worker/Chief/Gate loop (no runnable Dashboard code obligation remained after bootstrap), production PostgreSQL/Metabase deployment, Android widget on a physical device, and External Chief productization.
