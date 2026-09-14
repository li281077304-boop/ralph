import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  extensionRoundtripCode,
  runExternalChiefGuiRoundtrip,
} from "../apps/cli/bin/ralph-gui-chief-bridge.js";

const config = {
  session: "playwright-cli",
  conversation_url: "https://chatgpt.com/c/test",
  timeout_ms: 20,
  reply_grace_ms: 1,
  max_retry_attempts: 3,
};

function dependencies(sequence, calls) {
  return {
    ensureConversationTab: async () => undefined,
    runPlaywrightCli: async (_session, code) => {
      const isSubmit = code.includes("const submit = true;");
      calls.push(isSubmit ? "send" : "probe");
      return sequence.shift() ?? { noExistingReply: true };
    },
  };
}

const request = {
  identity: "handoff-identity",
  message: "review",
  closingMarker: "<<<END>>> ",
};

test("late complete reply is recovered without a duplicate send", async () => {
  const calls = [];
  const result = await runExternalChiefGuiRoundtrip(
    config,
    request,
    dependencies(
      [
        { noExistingReply: true },
        { errorCode: "ASSISTANT_REPLY_TIMEOUT", error: "timed out" },
        {
          reply: "handoff-identity\n<<<END>>> ",
          recoveryMode: "EXISTING_REPLY",
        },
      ],
      calls
    )
  );
  assert.equal(result.recoveryMode, "EXISTING_REPLY");
  assert.equal(result.chief_request_attempts, 1);
  assert.equal(result.chief_existing_reply_recoveries, 1);
  assert.deepEqual(calls, ["probe", "send", "probe"]);
});

test("an incomplete existing reply gets a bounded grace wait and is not resent", async () => {
  const calls = [];
  const result = await runExternalChiefGuiRoundtrip(
    config,
    request,
    dependencies(
      [
        { errorCode: "ASSISTANT_REPLY_INCOMPLETE", error: "partial" },
        { reply: "handoff-identity\n<<<END>>> " },
      ],
      calls
    )
  );
  assert.equal(result.recoveryMode, "EXISTING_REPLY");
  assert.equal(result.chief_request_attempts, 0);
  assert.deepEqual(calls, ["probe", "probe"]);
});

test("a true timeout permits only bounded transient retries", async () => {
  const calls = [];
  await assert.rejects(
    runExternalChiefGuiRoundtrip(
      config,
      request,
      dependencies(
        [
          { noExistingReply: true },
          { errorCode: "ASSISTANT_REPLY_TIMEOUT", error: "timed out" },
          { noExistingReply: true },
          { errorCode: "ASSISTANT_REPLY_TIMEOUT", error: "timed out" },
          { noExistingReply: true },
          { errorCode: "ASSISTANT_REPLY_TIMEOUT", error: "timed out" },
        ],
        calls
      )
    ),
    (error) => {
      assert.equal(error.code, "ASSISTANT_REPLY_TIMEOUT");
      assert.equal(error.chief_request_attempts, 3);
      assert.equal(error.chief_timeouts, 3);
      return true;
    }
  );
  assert.deepEqual(calls, ["probe", "send", "probe", "send", "probe", "send"]);
});

test("wrong identity or marker is not accepted as an existing reply", async () => {
  const calls = [];
  const result = await runExternalChiefGuiRoundtrip(
    config,
    request,
    dependencies(
      [{ noExistingReply: true }, { reply: "different-identity\n<<<END>>> " }],
      calls
    )
  );
  assert.equal(result.chief_request_attempts, 1);
  assert.deepEqual(calls, ["probe", "send"]);
});

function evaluateProbe(text) {
  const fn = vm.runInNewContext(
    extensionRoundtripCode(
      config.conversation_url,
      "review",
      request.identity,
      request.closingMarker,
      10,
      { submit: false, graceMs: 0 }
    )
  );
  const assistant = {
    async count() {
      return 1;
    },
    nth() {
      return { innerText: async () => text };
    },
  };
  return fn({
    url: () => config.conversation_url,
    locator: () => assistant,
    waitForTimeout: async () => undefined,
    title: async () => "Chief",
  });
}

test("page-level probe ignores an old reply with the wrong identity or marker", async () => {
  assert.equal(
    (await evaluateProbe("other-handoff\n<<<END>>> ")).noExistingReply,
    true
  );
  await assert.rejects(
    evaluateProbe("handoff-identity\nwrong-closing-marker"),
    /ASSISTANT_REPLY_INCOMPLETE/
  );
});
