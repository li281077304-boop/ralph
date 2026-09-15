# Payroll bootstrap and real UAT result

Run: `payroll-cua-big-loop-20260915`

## Source and isolation

Payroll was bootstrapped from the existing canonical project state, `CURRENT_STATE.md`, `docs/PAYROLL_CORE_V1.md`, `ASSET_INDEX.md`, `docs/UAT_MATRIX.md`, and prior `.ralph` artifacts. The Ralph-owned isolated worktree was `/private/tmp/education-payroll-host-chief.h2CabN`, starting at `c9eb09cb1a4cca31b61497c46d7a0612ed77d2cb`. The original shared Payroll workspace was not touched, reset, stashed, or merged.

## Revalidated evidence

The existing 17-item UAT matrix was used without inventing acceptance criteria. The isolated checkout ran `uv run --with '.[test]' pytest -q`: **374 passed**. Compileall and diff-check passed. The ledger records 12 PASS, 0 TECHNICAL_OPEN, 5 HUMAN_BLOCKED, and 0 FAILED.

The five remaining blocks are explicit business/source gaps: actual-base-salary G–L inputs, active part-time policy, approved renewal result with stable identity, approved refund source, and unresolved AV component sources/rules. They are not technical failures and were not replaced with zeroes or guessed policies.

Core payroll readiness remains `CORE_PAYROLL_READY=YES` for the evidenced AA/AC/AD/AE/AF chain. `FULL_PAYROLL_READY=NO` because M, renewals, refunds, and other AV inputs are not authoritative in the current source set.

## Scheduler result

The deterministic run is `WAITING_FOR_HUMAN` because no runnable or technical-open obligation remains. Human Interrupt Count is 0. The external Chief adapter had already completed three real handoffs (SELECT, REVIEW, RECOVERY) with 3/3 success and zero Host Sol fallback; those exact request/reply artifacts are in this devlog entry.
