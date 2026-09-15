# Temporary CUA External Chief UAT — SELECT

run_id: cua-chief-uat-20260915
phase: SELECT
identity: cua-chief-uat-select-01
closing_marker: <<<END_CUA_CHIEF_SELECT>>>

You are the External Chief for Ralph. Inspect the following real durable
handoff and choose exactly one legal action. Return the required machine block
with the same run_id and identity.

<<<CHIEF_SELECT_HANDOFF>>>
run_id: cua-chief-uat-20260915
round: 1
handoff_hash: cua-chief-uat-select-01
project_goal: complete the real payroll delivery loop
current_task_id: payroll-2026-07-rule-reconstruction
task_goal: use the existing July payroll evidence to validate the real monthly
workflow without inventing business rules
legal_actions: CONTINUE_DEVELOPMENT, RUN_INTEGRATION_UAT, HUMAN_REQUIRED,
REQUEST_FINAL_REVIEW
evidence: real July payroll workbook, reconciliation workbook, schedule source,
existing repository docs and current durable UAT artifacts
<<<END_CHIEF_SELECT_HANDOFF>>>

Return exactly:
<<<CHIEF_SELECT_JSON>>>
{
"action": "CONTINUE_DEVELOPMENT | RUN_INTEGRATION_UAT | HUMAN_REQUIRED | REQUEST_FINAL_REVIEW",
"selected_task_id": "payroll-2026-07-rule-reconstruction",
"why_now": "...",
"evidence": ["..."],
"why_not_other_ready_tasks": "...",
"reference_check": {"decision": "REUSE | ADAPT", "evidence": "...", "why_build_if_needed": ""},
"human_question": "",
"human_options": [],
"uat_scope": "",
"run_id": "cua-chief-uat-20260915",
"round": 1,
"handoff_hash": "cua-chief-uat-select-01"
}
<<<END_CUA_CHIEF_SELECT>>>
