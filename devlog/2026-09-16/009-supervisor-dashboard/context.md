USER OBSERVATION
The Big Loop controller process ran for roughly twenty minutes and then disappeared without completing the run. The current Payroll run is genuinely HUMAN_BLOCKED and is frozen for this phase. Dashboard is the next real product UAT target; WorkBuddy is explicitly out of scope.

CONFIRMED FACT
The Controller is a deterministic Ralph orchestration program, not an Agent. It persists run/phase/obligation evidence and can be restarted from disk, but there is no independent restart/resume life-line above it. External Chief CUA transport has user-observed and deterministic evidence for SELECT, REVIEW, and RECOVERY, but is not yet repo-native. The desired Chief route is External Warm, then bounded External Recovery/Cold, then Host Chief.

TECHNICAL ASSESSMENT
Implement a thin supervisor that starts the Controller, observes exit and durable terminal state, and restarts unexpected exits without interpreting business rules. Add a small observable Chief router contract with durable route telemetry. Bootstrap Dashboard from its own repo evidence as a module of an Education Operations SaaS; keep Excel/CSV behind an adapter and do not touch Payroll or WorkBuddy.

REJECTED ASSUMPTIONS
The overnight disappearance is not evidence of a Worker/Chief single-point bug. A Controller exit must not be treated as completion. Payroll HUMAN_BLOCKED items are not autonomous work for this phase. Dashboard must not be treated as an isolated demo or a reason to redesign Ralph Core.

DECISION
First build and test supervisor restart/resume and Chief route selection. Then read Dashboard repo state, create canonical current-state and obligations artifacts, and run the real product path through normalized data, responsive UI, and the existing Ralph Worker/Gate/Chief chain where technically runnable.

UNKNOWN / OPEN RISKS
The exact Controller invocation and durable run-state location vary by existing CLI entry point. A long real Dashboard loop may expose a new system-level breakpoint. External Chief productization remains TECHNICAL_OPEN; the temporary Agent-mediated CUA adapter may be used only as an explicitly labeled route.
