USER OBSERVATION
The prior architecture work proved a standalone supervisor can restart a killed Controller and that Dashboard cards consume a real frozen Excel export. The remaining product gaps are that the normal Ralph launch path can still bypass supervision, and the real Dashboard Android Widget obligation has not yet gone through a Ralph Worker/Gate/Review loop.

CONFIRMED FACT
The stable Ralph branch is feature/ralph-v3-supervisor-dashboard at 40f73f54e9e9d20c9e98da1638bb48e957f22027. The Dashboard Ralph-owned worktree is /private/tmp/edu-ops-dashboard-ralph-run on ralph/dashboard-real-uat at ec1c99ecdaf1926fd3d4a1fa2475fa5e0ce7c1df. Its real input is the recorded 1092-row, 44-teacher Excel export and its existing cards/runtime have evidence. The Dashboard ledger has one real Android Widget technical obligation and one existing business-rule human boundary; Payroll and WorkBuddy are out of scope.

TECHNICAL ASSESSMENT
The public V3 launcher should invoke the thin supervisor, leaving the Controller as an internal entrypoint. The Widget loop must use the existing Dashboard evidence and an isolated Ralph-owned worktree, preserving the adapter boundary (Excel/CSV → normalized snapshot → widget-facing data). A real device may remain a genuine boundary, but it must be tested through available emulator/ADB/build routes before escalating.

REJECTED ASSUMPTIONS
Starting the supervisor script directly is not sufficient proof of the user-facing launch contract. Existing Dashboard card PASS evidence does not prove a Widget install/runtime PASS. A historical Widget implementation does not prove current physical-device validation. No Payroll business rule should be inferred or changed in this phase.

DECISION
First make the existing public V3 command supervised by default and preserve an explicit controller/debug command. Then run the current Dashboard Widget obligation through the real External Chief → finite Luna Worker → Machine Gate → checkpoint → Review path in an isolated worktree, including one Controller kill/restart while the run is active. Persist every route, phase, restart, and widget evidence artifact.

UNKNOWN / OPEN RISKS
The repository's current public V3 command name may be distributed across package scripts and documentation. The Dashboard Android SDK/device availability is not yet confirmed. Repo-native External Chief GUI productization remains a separate technical-open capability; this run may use the already proven route only when genuinely available.
