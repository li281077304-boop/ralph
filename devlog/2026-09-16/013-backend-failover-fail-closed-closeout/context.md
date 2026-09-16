# Context — backend failover fail-closed close-out

## USER OBSERVATION

The user stopped the P2 expansion mid-flight: "现在停止继续扩展 P2 自动 backend
failover，执行本轮收口。" The concern is not that the failover contract is wrong,
but that an automatic provider switch is a much larger decision than a router
refactor. The instruction is to keep the contract and its tests, and to make the
capability explicitly incapable of switching backend by itself. A specific rule
was requested: quota / unavailable / transport failure with no user-approved
fallback must stop the run and leave durable `TECHNICAL_OPEN` evidence, never
self-select a new model or provider. The user also stated that `hy3` seen in a
screenshot is unconfirmed and must not be counted as a Ralph capability.

## CONFIRMED FACT

The P0 and P1 fixes are already verified and were re-confirmed this round:
`scripts/chief-v3-gate-fail-closed.test.mjs` 10/10 and
`scripts/supervisor-restart-matrix.test.mjs` 11/11, both re-run on this HEAD.
The real Dashboard run `dashboard-widget-real-20260916-r2` is DONE/done/round 5
at `a115f1b` and is used only as accident evidence — it was not continued, and
the Dashboard Widget was not touched. The `hy3` string appears nowhere in this
repository's code: a case-insensitive scan of the tree finds it only in this
round's own documentation, which records it as unconfirmed. No provider other
than `HOST_CODEX` / `EXTERNAL_AGENT` exists in the backend kinds, and no backend
was added this round.

## TECHNICAL ASSESSMENT

The previous round's router treated the _next configured backend_ as an
implicitly authorised failover target. That is the defect this round closes: a
configured-but-unapproved backend would have been selected automatically, which
is exactly the "Ralph picked a provider on its own" behaviour the user forbids.
The fix is to make approval an explicit, per-backend, opt-in property
(`approvedForFailover`), to derive the executable order as
`[primary, ...approvedFallbacks]`, and to make every stop path emit durable
`TECHNICAL_OPEN` evidence through a Controller-owned sink. Because the module
already receives no state writer, the stop path structurally cannot mutate
authoritative run state.

## REJECTED ASSUMPTIONS

- "The failover is correct because it keeps the same run id." Keeping the run
  identity is necessary but not sufficient; without explicit approval the correct
  behaviour is to stop, not to continue on a different provider.
- "Configured implies approved." Rejected. A backend may be present on the
  machine and still be one the operator never authorised as a replacement.
- "Approval should also cover auth/execution failures." Rejected. Approving a
  fallback cannot repair an `AUTH_FAILURE` or a genuine `EXECUTION_FAILURE`, so
  those keep stopping the route even when a fallback is approved.
- "Marking P2 experimental in prose is enough." Rejected. The claim is enforced:
  a hard `false` constant plus a repository scan in the test suite that fails if
  `apps/` or `packages/core/src/` can reach the router.

## DECISION

Keep P0 and P1 frozen and untouched. Keep the P2 module and its tests, but
re-classify it as `EXPERIMENTAL` / `NOT WIRED`, with production backend failover
`NOT ENABLED`; add `FAILOVER_REQUIRES_USER_APPROVAL`, `BACKEND_STOP_REASONS`,
`BackendStopEvidence` and `BACKEND_STOP_EVIDENCE_FILENAME`; require
`approvedForFailover` for any fallback; stop fail-closed with durable
`TECHNICAL_OPEN` evidence and `selected_backend: null` when no approval exists;
add no new backend of any kind. Record the outcome in `VERIFIED_CAPABILITIES.md`
with P0/P1 as VERIFIED / CLOSED.

## UNKNOWN / OPEN RISKS

Wiring the router into the Controller main loop remains `TECHNICAL_OPEN` and is
intentionally out of scope; until that happens the module is a contract with
tests, not a live behaviour. `PROCESS_CRASH` is classified but not treated as
failover-eligible, so a crashing backend still relies on the supervisor restart
path rather than a provider switch. Whether automatic failover should ever be
enabled is a human decision the user has not made; the capability is built so
that enabling it requires a deliberate code change rather than a configuration
drift.
