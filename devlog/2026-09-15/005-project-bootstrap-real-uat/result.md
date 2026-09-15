# Project bootstrap and real Payroll UAT

## TESTED

- Added deterministic `scripts/bootstrap-project.mjs` to import evidence-derived tasks into the target repository's canonical `.ralph/chief/PROJECT_STATE.json`, `OBLIGATIONS.json`, and run state.
- Bootstrap was executed for `payroll-bootstrap-real-uat-20260915` using an isolated Ralph-owned Payroll worktree based on `e374ee0f0924cb31461e60b4c24b3d63f85e1391`.
- Added a finite host Codex Worker path. Codex is invoked with `exec --json --ephemeral`, `workspace-write`, and no Docker dependency; raw JSONL is persisted to the round's `worker.ndjson`.
- Real run evidence: Host Sol SELECT fallback, one finite Luna Worker turn, Machine Gate PASS, checkpoint pushed to the isolated Payroll branch, and Chief Review invocation.
- Focused host-worker, bootstrap, select, review, and recovery tests passed. Core typecheck/build passed.

## REAL-UAT-VERIFIED

- The real Payroll run reached `HUMAN_REQUIRED` after Chief Review independently confirmed that this checkout intentionally lacks the real sensitive Payroll inputs and the documented UI/runtime dependencies. No real Payroll calculation PASS was claimed.
- `TECHNICAL_OPEN` remains 1 in the imported obligation ledger because the canonical project task is still in progress; this is not silently converted to PASS.
- Original Payroll checkout was not modified or cleaned. All worker changes and Git checkpoint activity occurred in the Ralph-owned isolated worktree.

## NOT-YET-VERIFIED

- Full real-data Payroll UAT cannot be completed from this checkout without an authorized real source package and an executable dependency/UI path. The Chief classified that as a genuine source/environment prerequisite, not as a code result.
