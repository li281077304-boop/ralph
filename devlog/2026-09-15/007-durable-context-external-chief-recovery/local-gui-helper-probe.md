# Local macOS GUI helper probe

## Contract

The helper uses the frontmost Chrome window only. It does not attach to a
browser, create a session, use Playwright CLI, open a tab, or inspect a daemon.
Input is JSON on stdin (`message`, `identity`, `closing_marker`, `timeout_ms`).

## Result

- The Swift helper compiled successfully.
- It successfully focused the prepared ChatGPT composer and submitted the
  helper probe through paste + Enter.
- The visible ChatGPT page produced the expected `LOCAL_HELPER_OK_2` reply.
- Clipboard restoration was delayed until paste/Enter delivery; the earlier
  race that pasted stale clipboard text was fixed.

## Blocking evidence

Native macOS AX queries can see the Chrome window and one `AXWebArea`, but the
web area reports `AXNumberOfCharacters=0` (and a visible character range of
length zero) and exposes no assistant message or composer text nodes. The
helper therefore returns `AX_PAGE_TEXT_UNAVAILABLE` with bounded diagnostics
(`ax_text_nodes=4`, `web_area_count=1`, `web_character_count=0`) even though the
user-visible page has the assistant reply. System Events enumeration of the
same Chrome web content also blocks or exposes only toolbar elements.

The CUA accessibility tree can read the page, but no callable CUA API is
available to a repo-local Node/Swift process. Consequently `LOCAL_GUI_HELPER`
cannot be claimed 3/3 and Ralph External Chief integration is intentionally
not attempted. No CLI/session/daemon workaround was introduced.
