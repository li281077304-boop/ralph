import assert from "node:assert/strict";
import test from "node:test";

import { findFirstEditableInput } from "../apps/cli/bin/ralph-gui-chief-bridge.js";

class FakeCandidate {
  constructor({ visible, enabled = true, editable = true, label }) {
    this.visible = visible;
    this.enabled = enabled;
    this.editable = editable;
    this.label = label;
  }

  async isVisible() {
    return this.visible;
  }

  async isEnabled() {
    return this.enabled;
  }

  async isEditable() {
    return this.editable;
  }
}

class FakeLocator {
  constructor(candidates) {
    this.candidates = candidates;
  }

  async count() {
    return this.candidates.length;
  }

  nth(index) {
    return this.candidates[index];
  }
}

class FakePage {
  constructor(bySelector) {
    this.bySelector = bySelector;
  }

  locator(selector) {
    return new FakeLocator(this.bySelector[selector] ?? []);
  }
}

test("composer selection skips hidden editors and picks the visible editable candidate", async () => {
  const selectors = [
    '[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
  ];
  const hidden = new FakeCandidate({
    visible: false,
    label: "hidden-template",
  });
  const visible = new FakeCandidate({
    visible: true,
    label: "chatgpt-composer",
  });
  const page = new FakePage({
    '[contenteditable="true"]': [hidden, visible],
    '[contenteditable="true"][role="textbox"]': [],
  });

  const result = await findFirstEditableInput(page, selectors);

  assert.equal(result.input, visible);
  assert.deepEqual(result.diagnostics.slice(0, 2), [
    {
      selector: '[contenteditable="true"]',
      index: 0,
      visible: false,
      enabled: true,
      editable: true,
    },
    {
      selector: '[contenteditable="true"]',
      index: 1,
      visible: true,
      enabled: true,
      editable: true,
    },
  ]);
});

test("composer selection ignores visible but disabled or read-only candidates", async () => {
  const selector = '[contenteditable="true"][role="textbox"]';
  const page = new FakePage({
    [selector]: [
      new FakeCandidate({ visible: true, enabled: false, label: "disabled" }),
      new FakeCandidate({ visible: true, editable: false, label: "readonly" }),
      new FakeCandidate({ visible: true, label: "usable" }),
    ],
  });

  const result = await findFirstEditableInput(page, [selector]);

  assert.equal(result.input.label, "usable");
});
