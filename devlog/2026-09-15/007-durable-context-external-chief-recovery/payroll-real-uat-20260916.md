# Payroll Phase 3 — real 2026-08 UAT evidence (2026-09-16)

This entry records the current evidence pass after the External Chief CUA
3/3 gate. It does not rerun or reinterpret the already successful External
Chief transport.

## Confirmed from the Payroll checkout and real Desktop inputs

- Isolated Payroll worktree: `/private/tmp/education-payroll-host-chief.h2CabN`
- Original shared Payroll workspace was not modified.
- Fresh Payroll service Run: `18a38d63ebcd`
- Period: `2026-08`, `2026-08-03` to `2026-08-30`, source `SOURCE_FILE_RANGE`
- Schedule: real `排课列表_08月03日到08月30日_202609011519.xls`, 2,385 rows, 51 teachers
- Core checks: AA/AC/AD/AE are 51/51 `DETERMINED`.
- AF is 6 `DETERMINED` and 45 `ESTIMATED` until this Run's fresh monthly
  policy confirmation is supplied; no old Run confirmation was reused.
- Real G-L baseline has 31 rows. The Run snapshot yields 19 determined M
  values and 32 `BLOCKED_BY_INPUT`; blank G-L cells remain missing and are
  never coerced to zero.
- Existing `read_business_result` imported 49 rows from the real renewal
  workbook's `8月` sheet. They remain `SUBMITTED` (no `APPROVED` status and no
  separately authoritative teacher IDs), so no renewal result was bound.
- Real refund source has 31 rows from `8月份 `, but its status field is blank;
  no refund result was bound.
- Normal export produced `/Users/macos/Desktop/Payroll-UAT-2026-08-18a38d63ebcd.xlsx`
  with explicit `NEEDS_CONFIRMATION` blockers; it was not presented as a
  final payroll.

## Durable artifacts

Payroll details are in:

- `/private/tmp/education-payroll-host-chief.h2CabN/.ralph/chief-runs/payroll-cua-big-loop-20260915/REAL_UAT_20260916.md`
- `/private/tmp/education-payroll-host-chief.h2CabN/.ralph/chief-runs/payroll-cua-big-loop-20260915/CURRENT_RUN_LEDGER_20260916.json`
- `/private/tmp/education-payroll-host-chief.h2CabN/.ralph/chief-runs/payroll-cua-big-loop-20260915/RUN_STATE_20260916.json`

The fresh current ledger is `11 PASS / 0 TECHNICAL_OPEN / 6 HUMAN_BLOCKED /
0 FAILED`. The scheduler is waiting only because each remaining item is an
explicit policy, approval, identity, or source fact that cannot be invented by
the system.

## Deterministic checks

`uv run --with '.[test]' pytest -q` → 374 passed; compileall and diff-check
also pass. No Ralph core, Dashboard, or Payroll calculation code was changed
in this evidence pass.
