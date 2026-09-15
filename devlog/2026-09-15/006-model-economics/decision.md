CONFIRMED

- Ordinary development and finite Worker invocations explicitly use gpt-5.6-luna with medium reasoning by default.
- Chief decisions remain External-first; Host gpt-5.6-sol high is used for Chief fallback or explicit chief role.
- Usage ledger entries retain unavailable token fields as null with tokens_available=false.

DECISION

- Keep model selection separate from Devlog persistence and execution permissions.
- Preserve finite Worker, V3 state machine, GUI bridge compatibility, and Payroll/Dashboard scope.

KNOWN OPEN RISKS

- External GUI availability remains an operational dependency when chief_mode=external; Host Sol fallback is the recovery path.
- Provider token schemas may evolve; ledger parsing is intentionally tolerant.
- Real Payroll UAT was not rerun in this economics-only change.
