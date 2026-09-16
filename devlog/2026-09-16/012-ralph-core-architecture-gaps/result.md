# Result

## Branch / HEAD

- branch: `feature/ralph-v3-supervisor-dashboard`
- HEAD (unchanged by this task): `40f73f54e9e9d20c9e98da1638bb48e957f22027`
- working tree: 16 modified files (+802/−211) and 15 new files, uncommitted.
- The finished Dashboard run was used as evidence only: no phase of `dashboard-widget-real-20260916-r2` was resumed, replayed, or rewritten, and no Dashboard Widget code was touched.

## P0 — MACHINE GATE FAIL CLOSED

- root cause: the gate judged itself by `policy_passed` and never required the commands it had just executed to have passed, so a required command exiting 1 could still reach CHECKPOINT.
- new authority: `packages/core/src/v3/gate-evidence.ts` — `evaluateRequiredGateEvidence` fails closed on `GATE_EVIDENCE_MISSING`, `GATE_EVIDENCE_MALFORMED`, `REQUIRED_COMMAND_NOT_EXECUTED`, `REQUIRED_COMMAND_TIMEOUT`, `REQUIRED_COMMAND_FAILED`, `REQUIRED_COMMAND_LIST_MISMATCH`; required set = configured ∪ recorded, so extra passing commands never fail the gate while a hidden failing one can never be ignored.
- doubled enforcement: `machine-gate.ts` routes to `CHIEF_RECOVERY` (technical block, not policy failure) before CHECKPOINT, and `checkpoint.ts` independently refuses with `MissingRequiredGateEvidenceError`; `review.ts` requires the same attestation before a Chief `PASS` is accepted.
- repair path: a failed gate artifact is never reusable — only a `required_gate_passed === true` artifact is re-proven, so "repair and re-gate" is always a genuine re-execution.
- tests: `scripts/chief-v3-gate-fail-closed.test.mjs`, 10/10 PASS, against real Git repositories with real bare remotes.
- REAL SAFE UAT (PASS): required command `exit 1` with `policy_passed: true` → phase `CHIEF_RECOVERY`, no `checkpoint.json`, HEAD unchanged, remote ref unchanged, obligation `TECHNICAL_OPEN`; re-attempting while still broken re-executed the command (recorded `exitCode: 1`) and stayed blocked; after the repair the gate re-ran, reported `required_gate_passed: true` / `gate_outcome: PASS`, and only then did HEAD and the remote advance to the checkpoint SHA.

## P1 — SUPERVISOR MUST NOT RESTART WAIT STATES

- root cause of the 231 restarts: the supervisor asked "is the child gone" instead of "is the run still unsettled"; every one of the 231 events was `WAITING_FOR_CHIEF`/waiting.
- new authority: `packages/core/src/v3/supervisor-policy.ts` (`evaluateSupervisorDisposition`, `supervisorRestartBackoffMs`, `supervisorFailureFingerprint`).
- never restart: `DONE`; `FAILED`; any `paused` status (`CONTROLLED_PAUSE` / `USER_STOP` / `INTENTIONAL_EXIT`); `WAITING_FOR_HUMAN`; `HUMAN_REQUIRED`; `WAITING_FOR_CHIEF` unless `telemetry.chief_recovery_pending === true`. Restart only when the durable ledger still holds runnable or `TECHNICAL_OPEN` work and the process disappeared unexpectedly.
- `apps/cli/bin/ralph-v3-supervisor.js` now re-evaluates disposition after every child exit and does not count a restart when the child had already settled the run; it persists `last_disposition`, `last_fingerprint`, `consecutive_identical_failures` and `technical_open` into `SUPERVISOR_STATE.json`, applies bounded exponential backoff, and escalates an identical crash loop to `SUPERVISOR_BACKED_OFF` (`TECHNICAL_OPEN`) instead of spinning.
- tests: `scripts/supervisor-restart-matrix.test.mjs`, 11/11 PASS, driving real supervisor processes against real durable state with controlled `SIGKILL`.
- UAT coverage: crash → restart → resume to completion; legal wait never restarted (parked, no spin); pending Chief recovery does restart; controlled stop / user stop / intentional exit / `DONE` / `FAILED` never restart; backoff growth and cap; identical-failure fingerprint detection; full matrix; restart-budget exhaustion.

## P2 — PERMANENT EXECUTION BACKEND FAILOVER

- contract: `packages/core/src/v3/execution-backend.ts` — `ExecutionBackend` (`kind`, `available`, `run`) receives an opaque request and returns a raw result; it gets no state writer, so it structurally cannot mutate authoritative state. The Controller records every route through an injected durable sink (`BackendRouteRecord` with `same_run_id`, `same_phase`, `same_task_id`, `attempts`, `failure_class`).
- routing: `HOST_CODEX` → `EXTERNAL_AGENT`, tried in declaration order. `QUOTA_EXHAUSTED`, `BACKEND_UNAVAILABLE` and `TRANSPORT_FAILURE` fail over and keep the same run identity; `AUTH_FAILURE`, `PROCESS_CRASH` and `EXECUTION_FAILURE` stop the route so the real problem surfaces. Classification is total; an unrecognized failure is never treated as failover-eligible. WorkBuddy is not a backend.
- no duplicate execution: `inspectRoundArtifacts` + `evaluateBackendDispatch` suppress a phase that durable artifacts already satisfy (`worker_evidence.json`, `machine_gate.json` `required_gate_passed`, `checkpoint.json` `pushed`, select/review/final-review/recovery decisions, `integration_uat.json`).
- tests: `scripts/execution-backend-failover.test.mjs`, 14/14 PASS.
- real evidence: `scripts/fixtures/execution-backend-failover-dashboard-20260916.json`, regenerated by `scripts/derive-failover-evidence-fixture.mjs` from the finished run (`rounds=5 historical_unchanged=true final=DONE/done head=a115f1b`). It records the real transition `HOST_CODEX → EXTERNAL_AGENT` with `same_run_id: true` over takeover rounds 3–5, the real failure signals (`EXTERNAL_NOT_CONFIGURED` for External Warm, recovery not attempted, measurable host attempt), the supervisor spin (`restart_count: 231`, `event_count: 232`, parked at `WAITING_FOR_CHIEF`/waiting), and proof that rounds 1–4 hashed identically before and after the failover. Paths are run-relative; no machine path is embedded.

## Verification classification

- DETERMINISTIC_TESTED: all three modules and every regression test above.
- REAL_UAT_VERIFIED: the P0 repair-and-re-gate cycle on a real repository with a real remote; the P1 legal-wait-no-spin and crash-loop boundaries with real supervisor processes and real `SIGKILL`.
- USER_OBSERVED: the finished Dashboard run's real Chief failover and its 231-restart spin, recorded as durable run telemetry.
- Checks: focused suites 10 + 11 + 14 PASS; full suite 258/258 PASS; `tsc --noEmit` clean; build clean; Prettier clean on every touched file; `git diff --check` clean. `scripts/gui-bridge.test.mjs` was already unformatted at HEAD and was not touched.

## Remaining TECHNICAL_OPEN

- No multi-hour unattended production run has yet exercised the new restart matrix live.
- The permanent router has not itself performed a live production failover; the finished run proves failover behaviour is real and history-preserving, not that this router executed it.
- WorkBuddy backends, and rounds whose gate artifacts predate the required-command contract, remain out of scope.
