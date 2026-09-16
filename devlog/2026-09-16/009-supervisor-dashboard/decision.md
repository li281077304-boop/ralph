# Decision

- The controller is a deterministic orchestration process. The thin supervisor now treats durable terminal state as authoritative and restarts only unexpected exits; it does not interpret business rules.
- Chief routing is observable and deterministic: External Warm first, an explicit bounded External Recovery hook second, then Host Chief. Preflight failure is distinct from a real Chief attempt.
- Dashboard is bootstrapped as an Education Operations SaaS module. Excel/CSV remains an adapter boundary; the UI consumes the normalized dashboard payload and can later consume a SaaS source without changing card presentation.
- No Payroll or WorkBuddy changes were made. Payroll Human Boundary remains frozen.
- Capability status is intentionally conservative: supervisor is deterministic-tested (not a real long-running production claim); Dashboard frozen-input runtime is real-UAT-verified on this machine; Android widget, PostgreSQL/Metabase deployment, and repo-native External Chief transport remain open.
