import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBridgeError,
  extensionRoundtripCode,
  realConversationUrl,
  tabEntries,
} from "../apps/cli/bin/ralph-gui-chief-bridge.js";

const URL = "https://chatgpt.com/c/fixed-chief";
const CLOSING = "<<<END_CHIEF_VERDICT_JSON>>>";

class FakeLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }
  last() {
    return this;
  }
  nth() {
    return this;
  }
  async count() {
    if (
      this.selector.includes("assistant") ||
      this.selector.includes("conversation-turn")
    )
      return 1;
    return this.page.composerSelector === this.selector ? 1 : 0;
  }
  async isVisible() {
    if (this.selector === "body") return true;
    if (
      this.selector.includes("assistant") ||
      this.selector.includes("conversation-turn")
    )
      return true;
    return (
      this.page.composerVisible && this.page.composerSelector === this.selector
    );
  }
  async isEditable() {
    return (
      this.page.composerVisible && this.page.composerSelector === this.selector
    );
  }
  async fill(value) {
    this.page.value = value;
  }
  async press() {
    this.page.sendCount += 1;
    this.page.value = "";
    const nonce =
      this.page.sentMessage().match(/handoff nonce = ([^\n]+)/)?.[1] ?? "reply";
    this.page.reply = `assistant ${nonce} ${CLOSING}`;
  }
  async inputValue() {
    return this.page.value;
  }
  async innerText() {
    if (this.selector === "body") return this.page.bodyText;
    return this.page.reply;
  }
}

class FakePage {
  constructor({
    composerSelector = "#prompt-textarea",
    bodyText = "ChatGPT",
    recovery = false,
  } = {}) {
    this.composerSelector = composerSelector;
    this.composerVisible = composerSelector !== null;
    this.bodyText = bodyText;
    this.recovery = recovery;
    this.reloadCount = 0;
    this.sendCount = 0;
    this.value = "";
    this.reply = "";
  }
  url() {
    return URL;
  }
  async title() {
    return "ChatGPT";
  }
  locator(selector) {
    return new FakeLocator(this, selector);
  }
  getByRole(role) {
    return new FakeLocator(
      this,
      role === "textbox" ? (this.composerSelector ?? "role-textbox") : role
    );
  }
  async reload() {
    this.reloadCount += 1;
    if (this.recovery) {
      this.composerSelector = '[data-testid="composer-text-input"]';
      this.composerVisible = true;
    }
  }
  async waitForTimeout() {}
  sentMessage() {
    return this.value || this.lastMessage || "";
  }
}

async function execute(page, timeoutMs = 500) {
  const code = extensionRoundtripCode(
    URL,
    "handoff nonce = unique-1",
    "unique-1",
    CLOSING,
    timeoutMs
  );
  const fn = eval(code);
  page.lastMessage = "handoff nonce = unique-1";
  return fn(page);
}

test("current composer selector submits exactly once", async () => {
  const page = new FakePage();
  const result = await execute(page);
  assert.equal(page.sendCount, 1);
  assert.match(result.reply, /unique-1/);
  assert.equal(result.url, URL);
});

test("legacy textarea selector remains supported", async () => {
  const page = new FakePage({ composerSelector: "textarea" });
  await execute(page);
  assert.equal(page.sendCount, 1);
});

test("login and human-verification pages fail closed with explicit codes", () => {
  assert.equal(
    classifyBridgeError("NOT_LOGGED_IN: diagnostics", undefined),
    "NOT_LOGGED_IN"
  );
  assert.equal(
    classifyBridgeError("HUMAN_VERIFICATION_REQUIRED: diagnostics", undefined),
    "HUMAN_VERIFICATION_REQUIRED"
  );
});

test("missing composer gets one bounded reload and can recover", async () => {
  const page = new FakePage({ composerSelector: null, recovery: true });
  await execute(page, 3_000);
  assert.equal(page.reloadCount, 1);
  assert.equal(page.sendCount, 1);
});

test("missing composer after recovery reports INPUT_NOT_FOUND", async () => {
  const page = new FakePage({ composerSelector: null });
  await assert.rejects(execute(page, 2_000), /INPUT_NOT_FOUND/);
  assert.equal(page.reloadCount, 1);
  assert.equal(page.sendCount, 0);
});

test("diagnostic error classes remain explicit", () => {
  assert.equal(
    classifyBridgeError("CONVERSATION_NOT_FOUND: diagnostics", undefined),
    "CONVERSATION_NOT_FOUND"
  );
  assert.equal(
    classifyBridgeError("CHATGPT_APP_ERROR: diagnostics", undefined),
    "CHATGPT_APP_ERROR"
  );
  assert.equal(
    classifyBridgeError("SEND_FAILED: diagnostics", undefined),
    "SEND_FAILED"
  );
});

test("placeholder conversation URLs are rejected while real ChatGPT URLs are accepted", () => {
  assert.equal(
    realConversationUrl(
      "https://chatgpt.com/c/REPLACE_WITH_FIXED_CHIEF_CONVERSATION"
    ),
    undefined
  );
  assert.equal(
    realConversationUrl("https://chatgpt.com/c/real-chief"),
    "https://chatgpt.com/c/real-chief"
  );
  assert.equal(
    realConversationUrl("https://example.com/c/real-chief"),
    undefined
  );
});

test("tab discovery parses changing tab indices without relying on title", () => {
  assert.deepEqual(
    tabEntries(
      "- 7: (current) [请稍候…](https://chatgpt.com/c/real-chief)\n" +
        "- 12: [Other](https://chatgpt.com/)"
    ),
    [
      { index: 7, url: "https://chatgpt.com/c/real-chief" },
      { index: 12, url: "https://chatgpt.com/" },
    ]
  );
});
