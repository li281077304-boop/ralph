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

## CHIEF_ROUTER_EXTERNAL_WARM_RECOVERY_HOST

- status: `DETERMINISTIC_TESTED`; live 3–5 hour Dashboard loop remains `NOT_YET_VERIFIED`.
- required behaviors: External Warm first, optional bounded External Recovery, Host fallback only after recovery failure, and durable route telemetry distinguishing preflight from real attempts.
- regression evidence: `scripts/chief-router.test.mjs`.
- known limitation: repo-native External Chief GUI transport is still `TECHNICAL_OPEN`; current proven Agent-mediated CUA route is not silently promoted.

## DASHBOARD_PROJECT_ADAPTER_REAL_PRODUCT_LOOP

- status: `REAL_UAT_VERIFIED` for frozen local Excel → normalized payload → responsive card runtime; long Ralph loop and Android widget remain `NOT_YET_VERIFIED`.
- evidence: `/private/tmp/edu-ops-dashboard-ralph-run/DASHBOARD_CURRENT_STATE.md`, `/private/tmp/edu-ops-dashboard-ralph-run/DASHBOARD_OBLIGATIONS.json`, `/private/tmp/edu-ops-dashboard-ralph-run/artifacts/ralph-real-uat.json`.
- source: `/Users/macos/Downloads/排课列表_08月31日到09月27日_202609131718.xls` (hash recorded in the evidence artifact).
