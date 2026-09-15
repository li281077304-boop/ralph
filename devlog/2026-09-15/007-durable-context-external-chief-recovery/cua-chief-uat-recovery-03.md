# CUA External Chief Recovery UAT 03

This is a real recovery handoff based on a durable Payroll worker/gate failure.

run_id: cua-chief-uat-20260915
round: 3
phase: CHIEF_RECOVERY
identity: cua-chief-uat-recovery-03
handoff_hash: recovery-gate-python-127-03
closing_marker: <<<END_CUA_CHIEF_RECOVERY>>>

## OBLIGATION

repo: li281077304-boop/education-payroll
task_id: payroll-2026-07-rule-reconstruction
goal: 利用真实 2026-07 已发工资资料重建可追溯的月份规则版本，并完成新月份的核算、预览、导出与 August 隔离回归验证。

## DURABLE FAILURE EVIDENCE

The Worker produced a real July evidence trail: 3383 in-period schedule rows, 311 cross-period exclusions, 68 grade confirmations pending, 377 substantive tests passing with 7 sandbox port failures, and no UNEXPLAINED reconciliation differences. Workspace policy and invariants were clean. Machine Gate then failed before execution because it invoked `.venv/bin/python3` in a clean isolated checkout where that path did not exist.

machine_gate_exit_code: 127
machine_gate_error: /bin/sh: .venv/bin/python3: No such file or directory
worker_reported_complete: true
policy_passed: true
changed_paths: docs/RULE_CATALOG.md, ocs/RULE_CATALOG.md
base_sha: 8defd5ab0989ec38f2cf6a88076ad0b4ebf5b22a
head_sha: f3c127669874d1cd379956ae2af0707ee8e9aace
gate_artifact_hash: a8433b307d19d6325f930e3279095dcc36f7ffafb85b2d5117419c9f512a4f1e

## RECOVERY REQUEST

Act as an independent technical Chief. Inspect the local repository and durable evidence. Do not modify files. This is a technical verification failure, not a business question. Choose a safe next action and explain why the failed interpreter route must not be repeated. Return natural-language engineering reasoning followed by exactly one strict footer:

<<<CHIEF_RECOVERY_JSON>>>
{
"action": "RETRY_WORKER | RUN_MACHINE_GATE | HUMAN_BLOCK",
"summary": "...",
"technical_diagnosis": "...",
"worker_task": "...",
"verification_strategy": ["..."],
"why_previous_approach_failed": "...",
"why_next_approach_should_work": "...",
"human_question": "",
"human_required_reason": "",
"run_id": "cua-chief-uat-20260915",
"round": 3,
"task_id": "payroll-2026-07-rule-reconstruction",
"worker_block_hash": "recovery-gate-python-127-03",
"closing_marker": "<<<END_CUA_CHIEF_RECOVERY>>>"
}
<<<END_CHIEF_RECOVERY_JSON>>>
