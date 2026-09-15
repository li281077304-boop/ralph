USER OBSERVATION
Transition Ralph V3 from long-lived Native Goal workers to finite worker turns,
with External-first Chief transport, Host Codex Sol fallback, strict Chief
machine footer, next_worker_task support, Ralph-owned isolated worktrees,
deterministic tests, and real Payroll UAT.

CONFIRMED FACT
repo: /private/tmp/ralph-v3-unattended-recovery.90oOVP
Existing V3 state, Machine Gate, checkpoint, External GUI, Host Codex, and
Native Goal liveness code are present. The current worker configuration still
supports and documents mode=native_goal. The repository contains no Payroll
checkout under the current workspace; available Payroll paths are temporary
artifacts and must not be treated as a verified target without identity checks.
Baseline typecheck passes. Core tests contain a stale phase-count assertion
(11 vs the current 13 registered phases), and the root devlog contract expects
historical context that the new entry must preserve.

TECHNICAL ASSESSMENT
The migration must keep state identity, Gate/Checkpoint evidence binding,
technical-vs-human failure classification, GUI fallback, and liveness
compatibility. New work should be split into disjoint write sets: finite
Worker turn protocol, Chief/footer protocol, owned-worktree lifecycle, and
transport/CLI wiring. All agent-facing handoffs must be written and hash
validated before invocation.

DECISION
Use Sol's four-way split, integrate only after focused tests pass, then run
full typecheck/tests/build and a real Payroll UAT only if a clean, identity-
checked Payroll repository is available. Do not claim UAT from fixtures.

UNKNOWN
Exact hidden-test expectations for footer fields, fallback ordering, and the
worktree lifecycle will be resolved by the existing code contracts and new
deterministic tests; no external product behavior is assumed.
