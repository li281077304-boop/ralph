# Agent task — backend fail-closed close-out

Close out the Ralph V3 architecture-gap round without expanding scope.

1. Keep the verified P0 (Machine Gate fail-closed) and P1 (supervisor legal-wait)
   implementations exactly as they are. Do not widen either.
2. Keep the P2 execution-backend / failover code and tests, but mark it clearly
   as an experimental capability: not wired into the Controller main loop, and no
   production path may automatically switch backend.
3. Add explicit fail-closed semantics: when the current backend hits quota
   exhaustion / unavailability / transport failure and there is no
   operator-approved fallback backend, Ralph must stop and leave durable
   `TECHNICAL_OPEN` evidence. It must never select a new model or provider on
   its own.
4. Do not add HY3, Hermes, or any other backend. The `hy3` string seen in an
   unrelated screenshot is unconfirmed and is not counted as a Ralph capability.
5. Re-run the full validation: tests, typecheck, build, prettier,
   `git diff --check`.
6. Confirm the P0/P1 regressions still pass in full.
7. Update the devlog and `VERIFIED_CAPABILITIES.md` with the final statuses:
   P0 = VERIFIED / CLOSED, P1 = VERIFIED / CLOSED, P2 = EXPERIMENTAL / NOT WIRED,
   production backend failover = NOT ENABLED.
8. Report repo path, branch, HEAD, `git status`, the round's diff summary and the
   full validation result; only then commit and push to the Ralph GitHub remote.
   Do not discard existing uncommitted work, do not rebuild the repo, do not
   switch back to an older branch.
