import assert from "node:assert/strict";
import test from "node:test";

import {
  GUI_BRIDGE_MESSAGE,
  GuiBridgeError,
  extractMarkedJson,
  runGuiBridgeRoundtrip,
  validateVerdict,
} from "../apps/cli/bin/ralph-gui-bridge.js";

class FakeLocator {
  constructor(page, selector, index = undefined) {
    this.page = page;
    this.selector = selector;
    this.index = index;
  }

  first() {
    return this;
  }

  nth(index) {
    return new FakeLocator(this.page, this.selector, index);
  }

  async isVisible() {
    if (this.selector.includes("stop-button") || this.selector.includes("Stop"))
      return false;
    if (this.selector === "body") return true;
    if (
      this.selector.includes("assistant") ||
      this.selector.includes("conversation-turn")
    )
      return this.page.assistants.length > 0;
    return (
      this.selector.includes("textbox") ||
      this.selector.includes("textarea") ||
      this.selector.includes("send-button")
    );
  }

  async count() {
    if (
      this.selector.includes("assistant") ||
      this.selector.includes("conversation-turn")
    )
      return this.page.assistants.length;
    return 1;
  }

  async innerText() {
    if (this.selector === "body") return "ChatGPT";
    if (
      this.selector.includes("assistant") ||
      this.selector.includes("conversation-turn")
    )
      return this.page.assistants[
        this.index ?? this.page.assistants.length - 1
      ];
    return "";
  }

  async fill(value) {
    this.page.sent = value;
  }

  async click() {
    this.page.respond();
  }

  async press() {
    this.page.respond();
  }
}

class FakePage {
  constructor(url) {
    this.currentUrl = url;
    this.assistants = ["previous assistant message"];
  }

  url() {
    return this.currentUrl;
  }

  locator(selector) {
    return new FakeLocator(this, selector);
  }

  respond() {
    const nonce = this.sent.match(/nonce = ([^\n]+)/)?.[1];
    this.assistants.push(
      `<<<CHIEF_VERDICT_JSON>>>\n${JSON.stringify({
        type: "GUI_BRIDGE_TEST",
        nonce,
        status: "OK",
      })}\n<<<END_CHIEF_VERDICT_JSON>>>`
    );
  }
}

class FakeContext {
  constructor(page) {
    this.page = page;
  }

  pages() {
    return [this.page];
  }
}

test("GUI Bridge performs one DOM roundtrip and validates the nonce", async () => {
  const conversationUrl = "https://chatgpt.com/c/fixed-conversation";
  const page = new FakePage(conversationUrl);
  const browser = { contexts: () => [new FakeContext(page)] };
  const result = await runGuiBridgeRoundtrip(
    { cdpUrl: "http://127.0.0.1:9222", conversationUrl, timeoutMs: 2_000 },
    { connectOverCDP: async () => browser, random: () => 0.25 }
  );
  assert.equal(result.ok, true);
  assert.equal(result.verdict.type, "GUI_BRIDGE_TEST");
  assert.equal(result.verdict.status, "OK");
  assert.match(page.sent, /这是 GUI Bridge 通信测试/);
});

test("GUI Bridge parser fails closed for marker, JSON, and nonce errors", () => {
  assert.throws(
    () => extractMarkedJson("no machine marker"),
    (error) => error.code === "MARKER_MISSING"
  );
  assert.throws(
    () =>
      extractMarkedJson(
        "<<<CHIEF_VERDICT_JSON>>>oops<<<END_CHIEF_VERDICT_JSON>>>"
      ),
    (error) => error.code === "JSON_INVALID"
  );
  assert.throws(
    () =>
      validateVerdict(
        { type: "GUI_BRIDGE_TEST", nonce: "wrong", status: "OK" },
        "right"
      ),
    (error) => error.code === "NONCE_MISMATCH"
  );
  assert.match(GUI_BRIDGE_MESSAGE("n-1"), /nonce = n-1/);
  assert.equal(new GuiBridgeError("X", "x").code, "X");
});
