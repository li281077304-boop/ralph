# Tonight: temporary Agent-mediated CUA transport

## CONFIRMED FACT

- REAL GUI DIRECT = 3/3 PASS using the prepared frontmost ChatGPT page.
- `GUI_DIRECT_OK_3`, `GUI_DIRECT_OK_4`, and `GUI_DIRECT_OK_5` were each sent
  by paste + Enter and read directly from the accessibility page text.
- Completion was accepted only after text stability across two reads and the
  Stop/停止回答 control disappeared. No Copy button was needed. No human
  verification page was present.
- The local Swift helper branch `feature/ralph-v3-local-gui-helper` compiled;
  its send path worked, but native macOS AX exposed `AXWebArea` with
  `AXNumberOfCharacters=0` and visible range zero. It returned
  `AX_PAGE_TEXT_UNAVAILABLE` and is frozen for tonight (`LOCAL_GUI_HELPER=0/2`).
- Playwright CLI tab-list/session/daemon/IPC investigation is frozen and must
  not be reopened.
- The current Agent/CUA can control and read the prepared page, while a
  repo-local Node/Swift process cannot call that CUA tree.

## TECHNICAL ASSESSMENT

- For tonight only, the engineering Agent is a dumb transport adapter: it may
  read an exact durable Chief handoff, paste it into the already-prepared
  ChatGPT composer, read the correlated assistant reply, and persist that
  exact reply. It must not interpret, repair, or manufacture a verdict.
- The adapter must preserve existing identity, closing-marker, verdict-parser,
  durable submission/reply, and duplicate-send checks.
- No new browser connection, session, tab, daemon, CLI control plane, OCR, or
  generic GUI framework is allowed.

## DECISION

- First prove three real Ralph handoffs (SELECT, REVIEW, and a naturally
  occurring SELECT/REVIEW/RECOVERY path) through the Agent-mediated CUA route.
- Only after 3/3 does the Payroll Big Loop run begin. Payroll must use a
  Ralph-owned isolated worktree and recover its workload from existing disk
  evidence rather than memory.
- External Chief remains primary; Host Sol is fallback only. Worker remains
  finite Luna.

## UNKNOWN / OPEN RISKS

- There is no supported programmatic bridge from a repo-local process to the
  CUA accessibility tree, so Ralph process-level invocation cannot yet be
  automated without violating tonight's frozen boundary.
- A real handoff can be relayed by the Agent only while this task remains
  active; process crash recovery of this temporary adapter is not guaranteed.
