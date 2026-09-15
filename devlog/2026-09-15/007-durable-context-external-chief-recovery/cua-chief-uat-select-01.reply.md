# CUA External Chief reply — SELECT

- run_id: `cua-chief-uat-20260915`
- phase: `SELECT`
- identity: `cua-chief-uat-select-01`
- sent_via: current frontmost ChatGPT page, CUA paste + Enter
- reply_completed: yes (text stable; Stop/停止回答 hidden)
- correlation: PASS

```text
<<<CHIEF_SELECT_JSON>>>
{ "action": "CONTINUE_DEVELOPMENT", "selected_task_id": "payroll-2026-07-rule-reconstruction", "why_now": "The real July payroll evidence is available, but the monthly workflow cannot be validated safely until the implemented calculation rules are reconstructed and traced to that evidence.", "evidence": ["real July payroll workbook", "reconciliation workbook", "schedule source", "existing repository docs", "current durable UAT artifacts"], "why_not_other_ready_tasks": "Integration UAT and final review would be premature before the July rules and evidence lineage are established; HUMAN_REQUIRED is not yet justified because the supplied artifacts should be exhausted before asking for business-rule clarification.", "reference_check": {"decision": "REUSE", "evidence": "Use the existing July workbooks, schedule source, repository documentation, and durable UAT artifacts as the authoritative reconstruction inputs.", "why_build_if_needed": ""}, "human_question": "", "human_options": [], "uat_scope": "", "run_id": "cua-chief-uat-20260915", "round": 1, "handoff_hash": "cua-chief-uat-select-01" }
<<<END_CUA_CHIEF_SELECT>>>
```
