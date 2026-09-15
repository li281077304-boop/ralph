# External Chief capability diff

Compared revisions:

- `139985ee557866dee20bbbc8fb956554d2a23bb2` — autonomous conversation acquisition
- `ebdaa9c08b9d98aacf8b5a09d11952b7fc580567` — composer transport hardening
- current HEAD `756eeb423187b545a640a787ce34fbe1dcad56b6` plus this recovery work

The historical revisions were fetched from `origin/feature/ralph-unattended-task-loop` for inspection. The comparison is limited to `apps/cli/bin/ralph-gui-chief-bridge.js` and its tests; no historical commit was cherry-picked wholesale.

| capability                            | historical implementation                                                           | current implementation                                   | status    | source commit | planned action                            |
| ------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- | --------- | ------------- | ----------------------------------------- |
| Reuse resolved conversation           | `external_chief_transport.json` and `resolved_conversation_url`                     | restored durable artifact lookup                         | IMPROVED  | 139985        | retain and test restart reuse             |
| Configured conversation               | preferred configured URL                                                            | configured URL is one preferred candidate                | PRESERVED | 139985        | retain                                    |
| Scan existing ChatGPT tabs            | enumerate tab-list and probe every ChatGPT tab                                      | restored `tabEntries` scan with probe                    | RESTORED  | 139985        | regression-test tab acquisition           |
| Open ChatGPT when no candidate exists | bounded `open https://chatgpt.com/`                                                 | restored bounded open/acquire                            | RESTORED  | 139985        | retain bounded behavior                   |
| Writable composer probe               | `composerProbeCode` with page diagnostics                                           | restored probe and current `findFirstEditableInput`      | IMPROVED  | ebdaa9c       | retain visible/enabled/editable selection |
| Composer selector coverage            | prompt textarea, textbox test ids, Message/消息 textarea, role textbox, ProseMirror | all historical selectors plus current selectors          | RESTORED  | ebdaa9c       | regression-test candidates                |
| Page diagnostics                      | login, human verification, conversation unavailable/read-only, app error            | restored explicit diagnostics and classifications        | RESTORED  | ebdaa9c       | retain fail-closed mapping                |
| Bounded reload                        | one reload after composer discovery delay                                           | restored in roundtrip after 1.5s                         | RESTORED  | ebdaa9c       | retain bounded reload                     |
| Submission state                      | started/submitted/last successful handoff hashes                                    | restored artifact writes and same-handoff suppression    | RESTORED  | 139985        | retain duplicate protection               |
| Existing assistant reply probe        | identity-correlated reply before submission                                         | current probe retained and now uses resolved URL         | IMPROVED  | current line  | retain                                    |
| Incomplete vs timeout                 | bounded reply handling                                                              | current `ASSISTANT_REPLY_INCOMPLETE` vs timeout retained | PRESERVED | current line  | retain                                    |
| Multiple composer candidates          | historical last candidate                                                           | current per-candidate visible/enabled/editable scan      | IMPROVED  | current line  | retain                                    |
| External attempt telemetry            | transport receipt and request metadata                                              | current retry metadata plus durable artifact             | IMPROVED  | current line  | reconcile with preflight counters         |

Known limitation: the local checkout does not itself prove a real Playwright session is logged in. Real bridge UAT remains an operational check and must be recorded separately from deterministic tests.
