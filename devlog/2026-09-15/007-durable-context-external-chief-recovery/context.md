USER OBSERVATION

- In formal Ralph tasks, the user and ChatGPT often discuss the implementation over many turns before the final task is published. Important decisions, rebuttals, historical failures, and scope boundaries form gradually. The user requires all reliable knowledge to be on disk because models can forget while the company must not.
- On 2026-09-13 the user observed External Chief running smoothly for roughly three rounds, followed by another roughly three rounds, using Playwright → ChatGPT → assistant reply. The observation is not precisely bound to a SHA by durable artifacts.

CONFIRMED FACT

- The current Devlog has context.md, agent-task.md, task-hash.txt, and metadata.json, but scripts/codex-task.mjs can synthesize a thin context when callers omit one. devlog normalizeContext() can also append missing sections as N/A. validateDevlogHandoff() checks presence and hashes, not discussion semantics.
- The current system therefore permits an apparently valid handoff whose context is an empty shell. Formal development must fail closed without substantive discussion context.
- Historical External Chief implementations are identified at ebdaa9c08b9d98aacf8b5a09d11952b7fc580567 (composer transport hardening) and 139985ee557866dee20bbbc8fb956554d2a23bb2 (autonomous conversation acquisition). The branches diverged after dbd9d535a9f86d7730e77adc1968cce82be921f2; the earlier comparison was current ahead 32 and behind 4 relative to 139985.
- The current repository still contains ralph-gui-chief-bridge.js, but file presence alone does not prove all historically smoke-tested capabilities remain. The last Payroll run reporting 1 external attempt, 0 successes, 1 failure and one Host Sol fallback lacked gui_bridge configuration; it was an external preflight/configuration failure, not a valid real External Chief attempt.
- Current model economics must remain: Luna is the ordinary development/Worker model, External Chief is primary, and Host Sol High is only fallback or explicit Chief escalation.

TECHNICAL ASSESSMENT

- The first hard boundary is a semantic discussion-context validator shared by every formal Worker, direct Codex, and Chief handoff. Required sections are USER OBSERVATION, CONFIRMED FACT, TECHNICAL ASSESSMENT, REJECTED ASSUMPTIONS, DECISION, and UNKNOWN / OPEN RISKS. Real substantive text is required; N/A/template-only context is invalid. Minimal/test mode must be explicit and recorded.
- Capability loss is a branch-integration/regression-gate problem, not proof that Playwright is inherently uncontrollable. The historical transport needs a three-way capability diff before any targeted adaptation.
- External transport must be preflighted and classified separately from real attempts. It should retain autonomous conversation acquisition, writable composer selection/recovery, reply correlation, duplicate submission protection, and durable submission state while preserving current improved candidate filtering and existing-reply probing.

REJECTED ASSUMPTIONS

- The 2026-09-13 “3+3” observation is not an exact commit/run proof.
- The recent 1/0/1 External Chief statistics are not valid real transport failure statistics because gui_bridge was not configured.
- A present bridge source file is not evidence that every historical capability is preserved.
- “GUI is inherently unstable” is not an acceptable root-cause explanation without attach, tab, readiness, composer, submission, correlation, and recovery evidence.

DECISION

- Implement semantic context persistence and validation before invoking any formal Agent; then use the new gate to validate this entry itself.
- Compare ebdaa9c, 139985, and current HEAD, restore only demonstrably lost External Chief capabilities, and preserve current improvements and model-economics routing.
- Record a tracked Verified Capability Registry and run deterministic regression tests plus real Playwright/External Chief UAT. Do not modify Payroll/Dashboard, do not change Ralph state-machine semantics, and do not use long Payroll UAT in this task.

UNKNOWN / OPEN RISKS

- The exact historical SHA/run for the observed “3+3” External Chief session is unknown.
- Real Chrome/Playwright login, extension/session, and ChatGPT availability must be verified in the current environment; NOT_LOGGED_IN or HUMAN_VERIFICATION_REQUIRED may remain a legitimate operational boundary.
- The exact set of capability differences will be determined by the three-way diff and tests, not assumed in advance.

ADDITIONAL USER OBSERVATION (2026-09-15)

USER OBSERVATION

- The currently visible Chrome window shows ChatGPT logged in and behaving normally.
- The ChatGPT composer is visibly present and can be typed into directly.
- Chrome explicitly shows “Playwright Extension 已开始调试此浏览器”.
- The user does not see a Cloudflare or human-verification page.
- The Agent has repeatedly remained in tab-attachment / attach-daemon investigation and has not written any content into the visible composer.

CONFIRMED FACT

- These are user-visible observations supplied for the next probe; they do not by themselves prove which Playwright context is attached or that the production CLI can control this tab.

DECISION

- Stop broad environment investigation. Use Ralph’s production Playwright CLI/session for one decisive tab-list → tab-select → composer probe → harmless message → correlated reply roundtrip. Classify any failure from the actual controlled tab and control path.
