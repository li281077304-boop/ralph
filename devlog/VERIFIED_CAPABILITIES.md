# Verified Capabilities

This registry is a durable, reviewable record of behavior that must not disappear during branch evolution.

## EXTERNAL_CHIEF_PLAYWRIGHT_TRANSPORT

- status: `DETERMINISTIC_TESTED`; real UAT status remains `NOT_YET_VERIFIED` on this branch until the six requested live roundtrips complete.
- known-good commits: `139985ee557866dee20bbbc8fb956554d2a23bb2`, `ebdaa9c08b9d98aacf8b5a09d11952b7fc580567`
- historical smoke evidence: user observed smooth Playwright → ChatGPT → assistant replies on 2026-09-13; the exact 3+3 count is not durably bound to a SHA and remains `USER_OBSERVED`.
- required behaviors:
  - reuse a resolved conversation and configured conversation when available;
  - scan existing ChatGPT tabs and boundedly acquire/open ChatGPT when needed;
  - probe a genuinely visible, enabled, editable composer using the full selector set;
  - classify login, human verification, conversation, app-error, input, and send failures;
  - perform one bounded reload/re-probe while a page is still loading;
  - probe identity-correlated assistant replies before retrying;
  - distinguish incomplete replies from timeouts;
  - persist submission-started, submitted, and last-successful handoff hashes;
  - never submit the same handoff twice after restart or timeout recovery.
- regression tests: `scripts/gui-chief-bridge.test.mjs`, `scripts/gui-chief-timeout-recovery.test.mjs`, `scripts/gui-bridge.test.mjs`.
- last deterministic verified commit: `current branch after capability recovery changes` (recorded in the task result).
- last real-UAT verified commit: `NOT_YET_VERIFIED`.
- known limitations: requires a real Playwright Extension session and authenticated ChatGPT tab; preflight failures must not inflate real-attempt counters.

## DURABLE_SEMANTIC_DEVLOG_HANDOFF

- status: `DETERMINISTIC_TESTED`.
- required behaviors: formal context has substantive USER OBSERVATION, CONFIRMED FACT, TECHNICAL ASSESSMENT, REJECTED ASSUMPTIONS, DECISION, and UNKNOWN / OPEN RISKS; exact task hash and metadata are read-back validated before invocation.
- regression tests: `scripts/devlog-contract.test.mjs`.
- real-UAT status: `NOT_YET_VERIFIED`.

## HUMAN_BOUNDARY_MINIMAL_ESCALATION

- status: `DETERMINISTIC_TESTED`; real human-response-to-resume UAT remains `NOT_YET_VERIFIED`.
- permanent categories: `BUSINESS_DECISION`, `CREDENTIAL_OR_SECRET`, `EXTERNAL_AUTHORIZATION`, `USER_ONLY_INPUT`, `SOURCE_CONFIRMATION`, `IRREVERSIBLE_EXTERNAL_ACTION`.
- required behaviors: technical failures and system-owned metadata stay technical; questions are minimized from durable evidence; global `WAITING_FOR_HUMAN` is allowed only when no `RUNNABLE` or `TECHNICAL_OPEN` obligation remains; raw answers are persisted as `HUMAN_RESPONSE.json`; RUN/PERIOD/PERSISTENT scope is explicit.
- regression tests: `scripts/human-boundary.test.mjs`, `scripts/chief-v3-autonomous-obligation-loop.test.mjs`, `scripts/chief-v3-recovery.test.mjs`.
- integration fixture: `scripts/fixtures/payroll-human-boundary-20260916.json` (anonymized six-obligation shape; UAT-10 excludes AN).
- known limitation: Payroll adapter wiring and a real user-answer/resume cycle still require live validation.

## SUPERVISOR_RESTART_RESUME

- status: `DETERMINISTIC_TESTED`; real long-running production UAT remains `NOT_YET_VERIFIED`.
- required behaviors: start the existing controller, observe durable `RUN_STATE.json`, restart unexpected exits, stop on durable terminal state, and persist bounded restart telemetry in `SUPERVISOR_STATE.json`.
- regression evidence: `scripts/supervisor.test.mjs` (three controlled SIGKILL/restart boundaries).
- known limitation: the supervisor must itself be kept alive by the invoking shell/launch service; it is intentionally not a permanent OS daemon.
- the legal-wait half of this contract was defective and is now owned by `SUPERVISOR_LEGAL_WAIT_NO_RESTART` below; `evaluateSupervisorDisposition` is the sole restart authority.

## CHIEF_ROUTER_EXTERNAL_WARM_RECOVERY_HOST

- status: `DETERMINISTIC_TESTED`; live 3–5 hour Dashboard loop remains `NOT_YET_VERIFIED`.
- required behaviors: External Warm first, optional bounded External Recovery, Host fallback only after recovery failure, and durable route telemetry distinguishing preflight from real attempts.
- regression evidence: `scripts/chief-router.test.mjs`.
- known limitation: repo-native External Chief GUI transport is still `TECHNICAL_OPEN`; current proven Agent-mediated CUA route is not silently promoted.

## DASHBOARD_PROJECT_ADAPTER_REAL_PRODUCT_LOOP

- status: `REAL_UAT_VERIFIED` for frozen local Excel → normalized payload → responsive card runtime; long Ralph loop and Android widget remain `NOT_YET_VERIFIED`.
- evidence: `/private/tmp/edu-ops-dashboard-ralph-run/DASHBOARD_CURRENT_STATE.md`, `/private/tmp/edu-ops-dashboard-ralph-run/DASHBOARD_OBLIGATIONS.json`, `/private/tmp/edu-ops-dashboard-ralph-run/artifacts/ralph-real-uat.json`.
- source: `/Users/macos/Downloads/排课列表_08月31日到09月27日_202609131718.xls` (hash recorded in the evidence artifact).

## MACHINE_GATE_REQUIRED_COMMAND_FAIL_CLOSED

- status: **`VERIFIED` / `CLOSED`** (repair-and-re-gate cycle on a real Git repository with a real bare remote); a long unattended production run remains `NOT_YET_VERIFIED`.
- authority: `evaluateRequiredGateEvidence` in `packages/core/src/v3/gate-evidence.ts`; required set = configured ∪ recorded, so extra passing commands never fail a gate while a hidden failing one can never be ignored.
- required behaviors: a required command that exits non-zero, times out, never executed, or produced missing/malformed evidence fails the gate; no checkpoint, no commit, no push, no `CHIEF_PASS` and no phase advance; the run routes to `CHIEF_RECOVERY` with the obligation `TECHNICAL_OPEN`; `policy_passed = true` never overrides a required-command failure; enforcement is doubled (gate + checkpoint) and bound into Chief review; a failed gate artifact is never reusable evidence, so the next attempt genuinely re-executes the commands.
- regression tests: `scripts/chief-v3-gate-fail-closed.test.mjs` (10 cases: exit 1, timeout, never executed, all-pass, checkpoint refusal with recorded failures, checkpoint refusal without attestation, legacy artifact regeneration, evaluator unit cases, signature stability, full real UAT).
- real UAT evidence: with `policy_passed: true` and required command `exit 1`, HEAD and the remote ref did not move, no checkpoint was written, the obligation stayed `TECHNICAL_OPEN`; a second attempt re-executed the command and stayed blocked; after the repair the gate reported `required_gate_passed: true` / `gate_outcome: PASS` and only then did HEAD and the remote advance to the checkpoint SHA.
- known limitation: gate artifacts written before this contract carry no attestation and are regenerated by re-execution rather than trusted.

## SUPERVISOR_LEGAL_WAIT_NO_RESTART

- status: **`VERIFIED` / `CLOSED`** for the matrix boundaries with real supervisor processes and real `SIGKILL`; a multi-hour unattended production run remains `NOT_YET_VERIFIED`.
- authority: `evaluateSupervisorDisposition` in `packages/core/src/v3/supervisor-policy.ts`, derived from durable `RUN_STATE.json` and never from process liveness.
- required behaviors: never auto-restart `DONE`, `FAILED`, `WAITING_FOR_HUMAN`, `HUMAN_REQUIRED`, a `paused`/controlled stop (`CONTROLLED_PAUSE`, `USER_STOP`, `INTENTIONAL_EXIT`), or a legal `WAITING_FOR_CHIEF` with no `telemetry.chief_recovery_pending`; restart an unexpected exit only while the ledger still holds runnable or `TECHNICAL_OPEN` work; bounded exponential backoff; durable `last_disposition`, `last_fingerprint`, `consecutive_identical_failures`, `technical_open`; an identical crash loop escalates to `TECHNICAL_OPEN` rather than a human business question.
- regression tests: `scripts/supervisor-restart-matrix.test.mjs` (11 cases) with `scripts/supervisor-crash-fixture-controller.mjs`.
- real incident evidence (`USER_OBSERVED`): the finished Dashboard run recorded `restart_count: 231` / `event_count: 232`, every event parked at `WAITING_FOR_CHIEF`/waiting — exactly the shape the matrix now refuses to restart.
- known limitation: the supervisor is still not a permanent OS daemon; it must be kept alive by the invoking shell or launch service.

## EXECUTION_BACKEND_FAILOVER

- status: **`EXPERIMENTAL` / `NOT WIRED`**. The contract and its deterministic tests exist; the capability is **not reachable from any production entry** and is deliberately not connected to the Controller main loop.
- contract: `packages/core/src/v3/execution-backend.ts`. The Controller owns run state, the obligation ledger, handoffs, hashes, validation, the writer lock, the gate, checkpoints and transitions. A backend gets no state writer and only returns a raw result (`HOST_CODEX`, `EXTERNAL_AGENT`; WorkBuddy is deliberately not supported, and no other backend — HY3, Hermes or anything else — has been added or is claimed).
- fail-closed semantics (the rule that governs this module): `QUOTA_EXHAUSTED`, `BACKEND_UNAVAILABLE` and `TRANSPORT_FAILURE` **stop the run fail-closed** unless the operator has _explicitly approved_ a specific fallback backend. With no approval, the route stops, `selected_backend` stays `null`, `auto_selected_new_provider` is `false`, the withheld candidate is recorded, and the durable stop record carries `obligation: TECHNICAL_OPEN` + `requires_human_approval: true`. Ralph never chooses a new model or provider on its own. Approval is per backend (`approvedForFailover`), never inferred, and never applies to the primary entry.
- required behaviors: an approved fallback may serve the same run/round/phase/task identity; `AUTH_FAILURE`, `PROCESS_CRASH` and `EXECUTION_FAILURE` stop the route even when a fallback _is_ approved, because switching backend cannot repair them; classification is total and an unrecognized failure is never failover-eligible; every route is recorded durably by the Controller (`same_run_id`, `same_phase`, `same_task_id`, `attempts`, `disposition`, `stop_reason`, `withheld_backends`, triggering `failure_class`); a stopped route also emits `BackendStopEvidence` (durable filename reserved as `execution_backend_stop.json`); no duplicate execution via `evaluateBackendDispatch` against durable round artifacts.
- regression tests: `scripts/execution-backend-failover.test.mjs` (19 cases) with the anonymized real fixture, including a repository scan asserting no file under `apps/` or `packages/core/src/` (other than the module itself and the package barrel) can reach the router.
- real evidence: `scripts/fixtures/execution-backend-failover-dashboard-20260916.json`, regenerable via `scripts/derive-failover-evidence-fixture.mjs`; it records `HOST_CODEX → EXTERNAL_AGENT` with `same_run_id: true` over takeover rounds 3–5, the real failure signals, the 231-restart spin, and rounds 1–4 hashing identically before and after the failover. No machine path is embedded. The suite also replays that same real incident _without_ approval and asserts it stops fail-closed on the same run instead of switching provider.
- known limitation: the fixture proves the failover is real and history-preserving, not that the permanent router executed it. Wiring the router into the Controller main loop is a separate, deliberate piece of work and remains `TECHNICAL_OPEN`.

## PRODUCTION_BACKEND_FAILOVER

- status: **`NOT ENABLED`**.
- What this means: on the current HEAD, a Ralph run whose execution backend hits quota exhaustion, unavailability or a transport failure **does not automatically switch backend**. No production code path imports the execution-backend router, and `PRODUCTION_BACKEND_FAILOVER_ENABLED` is a hard `false` constant.
- Consequence: such a failure surfaces as a durable technical condition on the existing run (obligation `TECHNICAL_OPEN`) rather than a silent provider change. Enabling automatic failover requires an explicit operator decision plus the wiring work above.
- guard: `scripts/execution-backend-failover.test.mjs` fails the build if the router becomes reachable from `apps/` or from `packages/core/src/` outside the module and the barrel.
