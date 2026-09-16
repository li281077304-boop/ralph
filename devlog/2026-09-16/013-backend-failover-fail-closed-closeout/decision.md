# Decision — backend failover fail-closed close-out

CONFIRMED: P0 and P1 are frozen. No code in the Machine Gate fail-closed path or
the supervisor restart matrix was modified this round; both suites were re-run
unchanged and pass in full.

CONFIRMED: the execution-backend module is retained but re-classified. It is
`EXPERIMENTAL` / `NOT WIRED`; `EXECUTION_BACKEND_WIRING` records this in code and
`PRODUCTION_BACKEND_FAILOVER_ENABLED = false` is a hard constant. Production
backend failover is `NOT ENABLED`.

CONFIRMED: failover now requires explicit, per-backend operator approval
(`approvedForFailover`). The executable order is derived as
`[primary, ...approvedFallbacks]`, so a configured but unapproved backend is
never invoked as a replacement — the test suite asserts the fallback's `run` is
not called at all.

CONFIRMED: the fail-closed rule is enforced for quota exhaustion, backend
unavailability and transport failure. With no approval the route stops with
`stop_reason: NO_APPROVED_FALLBACK_BACKEND`, `selected_backend: null`,
`auto_selected_new_provider: false`, `obligation: TECHNICAL_OPEN` and
`requires_human_approval: true`. A stopped route emits `BackendStopEvidence`
through the Controller-owned `recordStop` sink, with the durable filename
reserved as `execution_backend_stop.json`. Ralph never chooses a model or
provider on its own.

CONFIRMED: approval does not authorise a pointless switch. `AUTH_FAILURE`,
`PROCESS_CRASH` and `EXECUTION_FAILURE` stop the route even when a fallback is
approved, because switching backend cannot repair them.

CONFIRMED: no backend was added. `EXECUTION_BACKEND_KINDS` remains
`HOST_CODEX` / `EXTERNAL_AGENT`. `hy3` is unconfirmed and is not a Ralph
capability; WorkBuddy remains unsupported.

NOT ENABLED: automatic backend switching in any production path. The guard is
executable, not just documented — `scripts/execution-backend-failover.test.mjs`
scans `apps/` and `packages/core/src/` and fails if anything outside the module
itself and the package barrel can reach the router.

OPEN RISK: wiring the router into the Controller main loop is deliberately out
of scope and remains `TECHNICAL_OPEN`. Enabling automatic failover in production
would require a deliberate, reviewed code change plus an operator decision.
