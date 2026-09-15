# External Chief browser operating contract

This contract is an external prerequisite, not a Ralph-owned lifecycle.

Before starting an External Chief run, the operator prepares one Chrome
window with the target ChatGPT conversation already open and logged in. The
green `Playwright · playwright-cli` tab group may also contain the Playwright
Welcome tab. The operator keeps this tab/group frontmost and does not move,
close, or otherwise interfere with it while Ralph is running.

The simple GUI path is one-shot and stateless:

1. focus the visible ChatGPT composer;
2. paste the exact Chief message with Command+V;
3. press Enter;
4. read the latest assistant message directly from the page accessibility
   text after it changes, remains stable, and the Stop/停止生成 control is no
   longer visible;
5. correlate the reply with the handoff identity and closing marker.

Ralph must not create another Playwright connection, attach again, create a
session, detach, open a new ChatGPT page, rebuild the tab group, or inspect
Playwright daemon/socket internals on this path. `playwright-cli tab-list` is
not a prerequisite for the simple GUI path.

The prior real probe established that the prepared page is writable and that
the direct accessibility path can complete a correlated reply. Further Ralph
integration remains a separate implementation/UAT step; this document does
not claim the CLI transport is repaired.
