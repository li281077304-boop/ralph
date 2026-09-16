# Decision

## Layer separation (now explicit)

- Supervisor — process lifecycle only: start the Controller, observe exit, apply the restart matrix, persist `SUPERVISOR_STATE.json`. It never interprets business or phase rules.
- Controller — the Big Loop: phases, obligations ledger, handoff construction, hashes, schema validation, the writer lock, the Machine Gate, checkpoints and transitions. Sole writer of authoritative state.
- Chief Router — which Chief answers (`ralph-chief-v3-router.js`): External Warm → bounded External Recovery → Host.
- Execution Backend Router — which process actually executes a request (`execution-backend.ts`): `HOST_CODEX` → `EXTERNAL_AGENT`. New, and deliberately separate from the Chief Router.
- Durable State — `<repo>/.ralph/chief-runs/<run_id>/`, the only authority.

## P0 — fail closed on required-command evidence

`gate-evidence.ts` becomes the single authority for "did the required commands actually pass": missing/malformed evidence, `REQUIRED_COMMAND_NOT_EXECUTED`, `REQUIRED_COMMAND_TIMEOUT`, `REQUIRED_COMMAND_FAILED` and `REQUIRED_COMMAND_LIST_MISMATCH` all fail closed. Enforcement is doubled — `machine-gate.ts` refuses to advance, and `checkpoint.ts` independently refuses to commit or push — and the review binding in `review.ts` requires the same attestation. `policy_passed` is never consulted for a command failure. A failed gate artifact is never reusable evidence; only a `required_gate_passed === true` artifact may be re-proven, so repairing and re-gating is always a genuine re-execution.

## P1 — a legal wait is not a restart

`supervisor-policy.ts` is the sole restart authority, derived from durable `RUN_STATE.json`, never from process liveness. Never restart: `DONE`, `FAILED` (terminal), any `paused` status (`CONTROLLED_PAUSE`, `USER_STOP`, `INTENTIONAL_EXIT`), `WAITING_FOR_HUMAN`, `HUMAN_REQUIRED`, and `WAITING_FOR_CHIEF` unless `telemetry.chief_recovery_pending`. Restart only when the ledger still holds runnable/technical work and the process vanished unexpectedly, with exponential backoff, a durable fingerprint, and rapid-restart detection that escalates a crash loop to `TECHNICAL_OPEN` instead of a human business question.

## P2 — failover is a router, not an operator edit

Backends receive no state writer, so they structurally cannot mutate authoritative state; the Controller records every route through an injected durable sink. Failover-eligible classes are `QUOTA_EXHAUSTED`, `BACKEND_UNAVAILABLE`, `TRANSPORT_FAILURE`; `AUTH_FAILURE`, `PROCESS_CRASH` and `EXECUTION_FAILURE` stop the route so a genuine problem is surfaced. `evaluateBackendDispatch` consults durable artifacts before dispatching, which is the no-duplicate-execution guard for the same run and phase. WorkBuddy remains out of scope.

## Accepted open risks

- No multi-hour unattended production run has exercised the new matrix live.
- The permanent router has not performed a live production failover yet.
