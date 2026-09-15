# Production-path Playwright probe

## Result

- User-visible ChatGPT page: `https://chatgpt.com/`, logged-in, writable composer.
- Direct current-page probe: **PASS**.
- Probe message: unique harmless message sent from the visible composer.
- Assistant reply: `PROBE_OK`.

## Direct accessibility probe

- Probe message: `Ralph GUI direct-read probe 20260915-unique-03. Reply exactly GUI_DIRECT_OK_3.`
- Send path: visible composer focused, text pasted, Return pressed.
- Completion evidence: the Stop/停止回答 control disappeared and the assistant
  message became `GUI_DIRECT_OK_3`.
- Reply acquisition: read from the current page accessibility tree (no Copy
  button and no Playwright CLI tab-list/session operation).
- Correlation: **PASS** (unique identity and expected marker).

## Consecutive direct-read probes

- `unique-03` → `GUI_DIRECT_OK_3`: **SUCCESS**
- `unique-04` → `GUI_DIRECT_OK_4`: **SUCCESS**
- `unique-05` → `GUI_DIRECT_OK_5`: **SUCCESS**

All three used the same already-visible ChatGPT page and the same
accessibility-driven composer/reply path. No new attach, session, tab-list,
Copy-button, or daemon operation was used.

## Production CLI attempt

- Session: run-scoped session (token omitted from this record).
- Attach: **PASS**.
- Tab list: did not expose the user-visible ChatGPT tab to this session.
- Resulting controlled page reported `https://chatgpt.com/`, title `请稍候…`, and zero composer candidates.
- This is recorded as a production-path composer/tab visibility failure, not as user human verification: the same user-visible ChatGPT page was independently confirmed normal.

## Boundary

No user Chrome window was closed and no unrelated Playwright session was detached.
