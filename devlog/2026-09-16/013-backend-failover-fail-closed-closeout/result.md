# Result — backend failover fail-closed close-out

TESTED

## What changed

- `packages/core/src/v3/execution-backend.ts` — fail-closed failover policy.
  Added `EXECUTION_BACKEND_WIRING` (`EXPERIMENTAL` / `wired_into_controller: false`
  / `production_auto_failover: NOT_ENABLED`), `PRODUCTION_BACKEND_FAILOVER_ENABLED
= false`, `FAILOVER_REQUIRES_USER_APPROVAL = true`, `BACKEND_STOP_REASONS`,
  `BackendStopEvidence` + `buildBackendStopEvidence`, `approvedFailoverBackends`,
  and `BACKEND_STOP_EVIDENCE_FILENAME`. `ExecutionBackend` gained
  `approvedForFailover` (opt-in, absent/false by default). The executable order
  became `[primary, ...approvedFallbacks]`, and every stop path now emits durable
  `TECHNICAL_OPEN` evidence via a new Controller-owned `recordStop` sink.
- `packages/core/src/index.ts` — exports the new contract surface.
- `scripts/execution-backend-failover.test.mjs` — 14 → 19 cases; existing
  failover assertions now opt in via an explicit `approvedForFailover` fallback,
  plus new cases for the withheld-fallback stop, the single-backend stop, the
  approval-is-per-backend rule, the stop path leaving authoritative state
  untouched, and a repository scan proving nothing under `apps/` or
  `packages/core/src/` can reach the router.
- `devlog/VERIFIED_CAPABILITIES.md` — statuses updated; new
  `PRODUCTION_BACKEND_FAILOVER` section = `NOT ENABLED`.
- `devlog/INDEX.md` — this entry registered.

## Statuses

- `MACHINE_GATE_REQUIRED_COMMAND_FAIL_CLOSED` — **VERIFIED / CLOSED**.
- `SUPERVISOR_LEGAL_WAIT_NO_RESTART` — **VERIFIED / CLOSED**.
- `EXECUTION_BACKEND_FAILOVER` — **EXPERIMENTAL / NOT WIRED**.
- `PRODUCTION_BACKEND_FAILOVER` — **NOT ENABLED**.

## Validation

- `npm test`: **263 / 263 pass, 0 fail** (258 before this round).
- P0 regression `scripts/chief-v3-gate-fail-closed.test.mjs`: 10 / 10.
- P1 regression `scripts/supervisor-restart-matrix.test.mjs`: 11 / 11.
- P2 `scripts/execution-backend-failover.test.mjs`: 19 / 19.
- typecheck: clean. build (`tsc -p packages/core/tsconfig.json`, dist gitignored):
  exit 0. prettier: clean. `git diff --check`: clean.

## Scope kept

P0 and P1 were not modified this round. The Dashboard run
`dashboard-widget-real-20260916-r2` was used as read-only accident evidence; it
was not continued and the Dashboard Widget was not touched. No backend was added:
`EXECUTION_BACKEND_KINDS` remains `HOST_CODEX` / `EXTERNAL_AGENT`. `hy3` is
unconfirmed and is not counted as a Ralph capability.

## Real-UAT status

REAL-UAT-VERIFIED: the P0 and P1 halves remain real-UAT verified from the
previous round (real Git repo with a real bare remote; real supervisor processes
with real `SIGKILL`) and were re-run green on this HEAD.

NOT-YET-VERIFIED: the P2 failover router is deliberately not wired, so it has no
live production UAT by design. Its evidence is the deterministic suite plus the
anonymized replay of the real Dashboard incident, which now also proves that the
same real incident _without_ approval stops fail-closed on the same run.

## Open

Wiring the router into the Controller main loop remains `TECHNICAL_OPEN` and out
of scope. A multi-hour unattended production run remains `NOT_YET_VERIFIED` for
both P0 and P1.
