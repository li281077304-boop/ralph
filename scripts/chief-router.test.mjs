import test from "node:test";
import assert from "node:assert/strict";
import { routeChiefCall } from "../apps/cli/bin/ralph-chief-v3-router.js";

test("warm External Chief is selected without recovery or Host", async () => {
  let recovery = 0;
  let host = 0;
  const records = [];
  const result = await routeChiefCall({
    warmPreflight: async () => ({ ok: true }),
    recover: async () => {
      recovery += 1;
      return { ok: true };
    },
    external: async () => ({ reply: "EXTERNAL" }),
    host: async () => {
      host += 1;
      return { reply: "HOST" };
    },
    record: async (record) => records.push(record),
  });
  assert.equal(result.reply, "EXTERNAL");
  assert.equal(recovery, 0);
  assert.equal(host, 0);
  assert.equal(records[0].selected_route, "EXTERNAL_WARM");
  assert.equal(records[0].final_chief_identity, "external");
});

test("warm failure uses bounded External recovery before Host", async () => {
  let host = 0;
  const records = [];
  const result = await routeChiefCall({
    warmPreflight: async () => ({ ok: false, code: "TAB_NOT_READY" }),
    recover: async () => ({ ok: true }),
    external: async () => ({ reply: "RECOVERED" }),
    host: async () => {
      host += 1;
      return { reply: "HOST" };
    },
    record: async (record) => records.push(record),
  });
  assert.equal(result.reply, "RECOVERED");
  assert.equal(host, 0);
  assert.equal(records[0].selected_route, "EXTERNAL_RECOVERY");
  assert.equal(records[0].external_recovery.attempted, true);
});

test("recovery failure falls back to Host and records reason", async () => {
  const records = [];
  const result = await routeChiefCall({
    warmPreflight: async () => ({ ok: false, code: "EXTERNAL_NOT_CONFIGURED" }),
    recover: async () => ({ ok: false, code: "RECOVERY_EXHAUSTED" }),
    external: async () => ({ reply: "UNEXPECTED" }),
    host: async () => ({ reply: "HOST" }),
    record: async (record) => records.push(record),
  });
  assert.equal(result.reply, "HOST");
  assert.equal(records[0].selected_route, "HOST_CHIEF");
  assert.equal(records[0].host_fallback_reason, "RECOVERY_EXHAUSTED");
});

test("preflight exception is classified as Warm failure and can recover", async () => {
  const records = [];
  const result = await routeChiefCall({
    warmPreflight: async () => {
      throw Object.assign(new Error("attach unavailable"), {
        code: "ATTACH_FAILED",
      });
    },
    recover: async () => ({ ok: true }),
    external: async () => ({ reply: "RECOVERED" }),
    host: async () => ({ reply: "HOST" }),
    record: async (record) => records.push(record),
  });
  assert.equal(result.reply, "RECOVERED");
  assert.equal(records[0].external_warm.code, "ATTACH_FAILED");
  assert.equal(records[0].external_recovery.success, true);
});
