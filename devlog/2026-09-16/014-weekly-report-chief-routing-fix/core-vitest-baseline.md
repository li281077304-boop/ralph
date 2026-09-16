# Weekly Report Chief routing fix — baseline comparison

## Scope

This entry records the Core Vitest comparison required before changing the V3
production Chief configuration path. Weekly Report product code was not
modified.

## Baseline

- Commit: `1dfb0afaf63c151feb75352e7907b6483e4cbfb7`
- Command: `pnpm --filter @daonhan/ralph-core test`
- Result: `311 passed, 10 failed` (321 tests)

## Current

- Commit: `0fb2670e3b3c756cce38be8d6aa182fa75a142be`
- Command: `pnpm --filter @daonhan/ralph-core test`
- Result: `311 passed, 10 failed` (321 tests)

## Comparison

The failing test names and failure semantics are identical in both runs:

- nine `src/__tests__/chief-loop.test.ts` state-machine expectations return
  `WAITING_FOR_CHIEF` instead of the legacy terminal status;
- one `src/__tests__/chief-v3-foundation.test.ts` expectation sees the current
  phase registry size (`13`) instead of the legacy expectation (`11`).

No new Core Vitest failure was introduced by the Chief strategy/checkpoint
changes. The root Node test suite remains green (`267/267`).

## Runtime route evidence

Run `weekly-report-ralph-20260916-r8` was originally configured with
`chief_mode: codex`, which selected direct Host Codex. After the configuration
fix, the same run resolved `EXTERNAL_FIRST`; External was attempted once and
returned `INPUT_NOT_FOUND`, then the existing bounded Host fallback returned a
malformed SELECT decision. The run remains durably resumable at
`WAITING_FOR_CHIEF/select`.
