USER OBSERVATION
The Payroll Fresh Run produced a minimal six-item human decision list, but the boundary is currently documented as a project artifact rather than enforced generically by Ralph V3. The business owner should answer only genuine business/source/identity questions; system-owned metadata and deterministic matching must remain automated.

CONFIRMED FACT
The six current Payroll items are AF policy, G-L source selection, part-time policy, renewal final-state/source confirmation, refund final-state/source confirmation, and remaining AV fields excluding M/AF/AK/AN. HUMAN_REQUIRED_MINIMAL_20260916.md explicitly removes teacher IDs, source-result IDs, timestamps, ordinary matching, and audit bookkeeping from user responsibility.

TECHNICAL ASSESSMENT
Ralph needs one canonical human-category schema, a controller validation gate, durable human-required and human-response artifacts, deterministic global WAITING_FOR_HUMAN semantics, minimization before escalation, explicit RUN/PERIOD/PERSISTENT scope, and regression fixtures. Payroll-specific questions belong in an adapter, not Core. Prompt text alone is insufficient.

REJECTED ASSUMPTIONS
Technical failures, missing commands, test/build failures, UI automation issues, runtime crashes, ordinary identity matching, and metadata generation are not human requirements. UAT-10 must not duplicate AN. The temporary Agent-mediated CUA transport is not a permanent repo-native transport.

DECISION
Implement the Human Boundary as a reusable Ralph Core contract and deterministic controller behavior. Compile minimal questions from obligation evidence, persist raw answers as audit events, and resume only linked obligations. Keep Payroll descriptions in project metadata/adapter. Use current six-item Payroll evidence as an anonymized integration fixture.

UNKNOWN / OPEN RISKS
The exact existing obligation scheduler shape may require adaptation rather than replacement. Real human-response-to-resume UAT has not yet been run. External Chief GUI productization remains TECHNICAL_OPEN and must not block this core capability.
