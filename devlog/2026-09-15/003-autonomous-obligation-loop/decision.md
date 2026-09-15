# Decision

CONFIRMED CONCLUSIONS

- The repo-local launcher persisted the task context, exact agent task, metadata, and SHA-256 before invoking Codex.
- The first development-agent invocation failed in the host Codex stream before a verified result; its partial edits are retained and were independently reviewed.
- The autonomous loop must keep technical failures in durable recovery states and scope human input to individual obligations.

REJECTED ASSUMPTIONS

- A failed development-agent invocation is not evidence that the Ralph design is blocked.
- A technical Worker block is not a human requirement.

ARCHITECTURE DECISIONS

- CHIEF_RECOVERY is a runnable V3 phase.
- OBLIGATIONS.json and HUMAN_BACKLOG.json are run-scoped durable records; WAITING_FOR_HUMAN is global only after runnable and technical work are exhausted.
- Recovery actions are strict and identity-bound; failure signatures are normalized and persisted.

KNOWN OPEN RISKS

- Real Payroll unattended validation still requires a runnable workload and has not been claimed by this entry.
- CLI signal wiring to a live Native Goal remains separately verified by the existing deterministic signal seam; no new long-running Payroll UAT was started here.

NEXT RECOMMENDED ACTION

Run focused and full Ralph gates, then execute the real Payroll obligations without changing Payroll code.
