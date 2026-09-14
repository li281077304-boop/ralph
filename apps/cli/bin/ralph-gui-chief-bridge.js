#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { extractMarkedJson, GuiBridgeError } from "./ralph-gui-bridge.js";

const ASSISTANT_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn"]',
];

const INPUT_SELECTORS = [
  '[data-testid="textbox"]',
  'textarea[placeholder*="Message" i]',
  'textarea[placeholder*="消息"]',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
  "textarea",
];

const END_MARKER = "<<<END_CHIEF_VERDICT_JSON>>>";

/**
 * Pick the first genuinely writable composer candidate.  A page can contain
 * hidden editors (for example a template textarea plus the visible ChatGPT
 * contenteditable), so selector-level `last()` is not a safe choice.
 */
export async function findFirstEditableInput(page, selectors) {
  const diagnostics = [];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    let count = 0;
    try {
      count = await locator.count();
    } catch (error) {
      diagnostics.push({ selector, count: 0, error: String(error) });
      continue;
    }
    let visibleCount = 0;
    let editableCandidate;
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      let visible = false;
      let enabled = false;
      let editable = false;
      try {
        visible = await candidate.isVisible();
        enabled = await candidate.isEnabled();
        editable = await candidate.isEditable();
      } catch (error) {
        diagnostics.push({
          selector,
          index,
          visible,
          enabled,
          editable,
          error: String(error),
        });
        continue;
      }
      if (visible) visibleCount += 1;
      const candidateDiagnostic = {
        selector,
        index,
        visible,
        enabled,
        editable,
      };
      diagnostics.push(candidateDiagnostic);
      if (!editableCandidate && visible && enabled && editable)
        editableCandidate = candidate;
    }
    if (editableCandidate) return { input: editableCandidate, diagnostics };
    if (count === 0)
      diagnostics.push({
        selector,
        count: 0,
        visibleCount: 0,
        editableCandidate: false,
      });
    else
      diagnostics.push({
        selector,
        count,
        visibleCount,
        editableCandidate: false,
      });
  }
  return { input: undefined, diagnostics };
}

/**
 * Use the already attached Playwright Extension session to transport one
 * external-Chief handoff. This helper never writes a verdict; the caller
 * performs Ralph's existing schema and binding checks before writing it.
 */
export async function runExternalChiefGuiBridge(config, context) {
  const handoff = readFileSync(context.handoffPath, "utf8");
  const identity = context.state.handoff?.handoffHash;
  if (!identity)
    throw new GuiBridgeError(
      "VERDICT_INVALID",
      "Waiting state has no handoff hash for GUI Bridge correlation"
    );
  const message = chiefPrompt(context, handoff);
  return runExternalChiefGuiRoundtrip(config, {
    identity,
    message,
    closingMarker: END_MARKER,
  });
}

/**
 * Shared transport seam for protocol-specific Chief requests. The browser
 * mechanics stay in this module; callers own prompt/schema parsing and durable
 * state transitions.
 */
export async function runExternalChiefGuiRoundtrip(
  config,
  request,
  dependencies = {}
) {
  const env = loadExtensionEnv(config.extension_env_file);
  const session = config.session ?? "chrome";
  const timeoutMs = config.timeout_ms ?? 180_000;
  const maxAttempts = Math.max(
    1,
    Number(config.max_retry_attempts ?? request.maxAttempts ?? 3)
  );
  const graceMs = Math.max(
    0,
    Number(config.reply_grace_ms ?? request.replyGraceMs ?? 5_000)
  );
  const runCli = dependencies.runPlaywrightCli ?? runPlaywrightCli;
  const ensureTab = dependencies.ensureConversationTab ?? ensureConversationTab;
  const meta = {
    chief_request_attempts: 0,
    chief_existing_reply_recoveries: 0,
    chief_timeouts: 0,
    chief_last_attempt_at: null,
  };
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await ensureTab(session, config.conversation_url, env);

    // A timeout can race with a delayed assistant response. Always probe the
    // existing conversation before submitting anything, including retries.
    const probeCode = extensionRoundtripCode(
      config.conversation_url,
      request.message,
      request.identity,
      request.closingMarker,
      Math.min(timeoutMs, graceMs || timeoutMs),
      { submit: false, graceMs }
    );
    const probe = await runCli(session, probeCode, env, timeoutMs + 30_000);
    if (probe.reply) {
      meta.chief_existing_reply_recoveries += 1;
      return {
        reply: probe.reply,
        recoveryMode: "EXISTING_REPLY",
        ...meta,
      };
    }
    if (
      probe.errorCode === "ASSISTANT_REPLY_INCOMPLETE" &&
      attempt + 1 >= maxAttempts
    ) {
      lastError = probe;
      break;
    }
    if (
      probe.errorCode &&
      probe.errorCode !== "ASSISTANT_REPLY_TIMEOUT" &&
      probe.errorCode !== "ASSISTANT_REPLY_INCOMPLETE" &&
      probe.errorCode !== "NO_EXISTING_REPLY"
    ) {
      throw new GuiBridgeError(
        probe.errorCode,
        probe.error ?? "Existing assistant reply probe failed"
      );
    }

    if (probe.errorCode === "ASSISTANT_REPLY_INCOMPLETE") {
      lastError = probe;
      continue;
    }

    // No matching reply exists: submit once for this bounded attempt.
    const code = extensionRoundtripCode(
      config.conversation_url,
      request.message,
      request.identity,
      request.closingMarker,
      timeoutMs,
      { submit: true, graceMs: 0 }
    );
    meta.chief_request_attempts += 1;
    meta.chief_last_attempt_at = new Date().toISOString();
    const result = await runCli(session, code, env, timeoutMs + 30_000);
    if (result.reply) return { reply: result.reply, ...meta };
    lastError = result;
    if (
      result.errorCode !== "ASSISTANT_REPLY_TIMEOUT" &&
      result.errorCode !== "ASSISTANT_REPLY_INCOMPLETE"
    )
      throw new GuiBridgeError(
        result.errorCode ?? "VERDICT_INVALID",
        result.error ?? "Playwright Extension did not return an assistant reply"
      );
    if (result.errorCode === "ASSISTANT_REPLY_TIMEOUT")
      meta.chief_timeouts += 1;
  }

  const error = new GuiBridgeError(
    lastError?.errorCode ?? "ASSISTANT_REPLY_TIMEOUT",
    lastError?.error ?? "Playwright Extension did not return an assistant reply"
  );
  Object.assign(error, meta);
  throw error;
}

async function ensureConversationTab(session, conversationUrl, env) {
  let listed = await runCliCommand(
    session,
    ["tab-list", "--json"],
    env,
    30_000
  );
  if (!listed.ok && /not open/i.test(listed.error ?? "")) {
    const attached = await runCliCommand(
      session,
      ["attach", "--extension=chrome", "--json"],
      env,
      30_000
    );
    if (!attached.ok)
      throw new GuiBridgeError("CHROME_ATTACH_FAILED", attached.error);
    listed = await runCliCommand(session, ["tab-list", "--json"], env, 30_000);
  }
  if (!listed.ok)
    throw new GuiBridgeError("CHROME_ATTACH_FAILED", listed.error);
  let index = tabIndex(listed.result, conversationUrl);
  if (index === undefined) {
    const opened = await runCliCommand(
      session,
      ["open", conversationUrl, "--json"],
      env,
      30_000
    );
    if (!opened.ok)
      throw new GuiBridgeError("CONVERSATION_NOT_FOUND", opened.error);
    listed = await runCliCommand(session, ["tab-list", "--json"], env, 30_000);
    index = tabIndex(listed.result, conversationUrl);
  }
  if (index === undefined)
    throw new GuiBridgeError(
      "CONVERSATION_NOT_FOUND",
      "Configured ChatGPT conversation is not accessible in the extension session"
    );
  const selected = await runCliCommand(
    session,
    ["tab-select", String(index), "--json"],
    env,
    30_000
  );
  if (!selected.ok)
    throw new GuiBridgeError("CONVERSATION_NOT_FOUND", selected.error);
}

function tabIndex(result, conversationUrl) {
  const text =
    typeof result === "string" ? result : JSON.stringify(result ?? "");
  const escaped = conversationUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`- (\\d+):[^\\n]*${escaped}`));
  return match ? Number(match[1]) : undefined;
}

export function chiefPrompt(context, handoff) {
  const state = context.state;
  const fingerprint = state.handoff?.workspaceFingerprint ?? {};
  return [
    "你是 Ralph 的外部 Chief Engineer（外部总工）。",
    "你负责审计 Worker 施工结果、Machine Gate 证据和 Git diff，并决定下一步。",
    "不要执行其他任务，不要输出解释性 prose。",
    "",
    "本次审计绑定：",
    `run_id: ${state.runId}`,
    `iteration: ${state.iteration}`,
    `handoff_hash: ${state.handoff?.handoffHash ?? ""}`,
    `workspace_fingerprint: ${JSON.stringify(fingerprint)}`,
    "",
    "请只返回严格的 Ralph external Chief JSON 机器区块：",
    "<<<CHIEF_VERDICT_JSON>>>",
    "{",
    '  "verdict": "PASS | PATCH | RETURN | HUMAN_REQUIRED",',
    '  "summary": "...",',
    '  "worker_task": "...",',
    '  "human_question": "...",',
    '  "human_options": [],',
    '  "next_step": "...",',
    `  "run_id": "${state.runId}",`,
    `  "iteration": ${state.iteration},`,
    `  "handoff_hash": "${state.handoff?.handoffHash ?? ""}",`,
    '  "previousGate": { "passed": true, "commands": [] }',
    "}",
    "<<<END_CHIEF_VERDICT_JSON>>>",
    "",
    "以下是本轮精简 CHIEF_HANDOFF；完整证据路径以 handoff 为准：",
    handoff,
  ].join("\n");
}

export function loadExtensionEnv(envFile) {
  const env = { ...process.env };
  const candidate = envFile
    ? expandHome(envFile)
    : join(homedir(), ".config", "playwright-mcp", "env");
  if (!env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) {
    try {
      for (const line of readFileSync(resolve(candidate), "utf8").split(
        /\r?\n/
      )) {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (match && !env[match[1]])
          env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      }
    } catch {
      // The child process will report the attach failure without exposing a token.
    }
  }
  return env;
}

function expandHome(path) {
  return path === "~" || path.startsWith("~/")
    ? join(homedir(), path.slice(2))
    : path;
}

export function extensionRoundtripCode(
  conversationUrl,
  message,
  identity,
  closingMarker,
  timeoutMs,
  options = {}
) {
  const submit = options.submit !== false;
  const graceMs = options.graceMs ?? 0;
  return `(async page => {
    const expectedUrl = ${JSON.stringify(conversationUrl)};
    const message = ${JSON.stringify(message)};
    const identity = ${JSON.stringify(identity)};
    const deadline = Date.now() + ${timeoutMs};
    const submit = ${JSON.stringify(submit)};
    const graceMs = ${JSON.stringify(graceMs)};
    if (!page.url().startsWith(expectedUrl))
      throw new Error("CONVERSATION_NOT_FOUND: " + page.url());
    async function scanReply(waitMs) {
      const scanDeadline = Date.now() + waitMs;
      let reply = "";
      while (Date.now() < scanDeadline || waitMs === 0) {
        let foundIdentity = false;
        for (const selector of ${JSON.stringify(ASSISTANT_SELECTORS)}) {
          const assistant = page.locator(selector);
          let count = 0;
          try { count = await assistant.count(); } catch { continue; }
          for (let index = count - 1; index >= 0; index -= 1) {
            let text = "";
            try { text = await assistant.nth(index).innerText(); } catch { continue; }
            if (text.includes(identity)) {
              foundIdentity = true;
              reply = text;
              if (text.includes(${JSON.stringify(closingMarker)}))
                return { reply, complete: true };
            }
          }
        }
        if (waitMs === 0) break;
        await page.waitForTimeout(250);
      }
      return { reply, complete: false, partial: Boolean(reply) };
    }
    const existing = await scanReply(graceMs);
    if (existing.complete) return { reply: existing.reply, recoveryMode: "EXISTING_REPLY" };
    if (!submit) {
      if (existing.partial) throw new Error("ASSISTANT_REPLY_INCOMPLETE");
      return { noExistingReply: true };
    }
    const findFirstEditableInput = ${findFirstEditableInput.toString()};
    let input;
    let inputDiagnostics = [];
    while (!input && Date.now() < deadline) {
      const selection = await findFirstEditableInput(
        page,
        ${JSON.stringify(INPUT_SELECTORS)}
      );
      input = selection.input;
      inputDiagnostics = selection.diagnostics;
      if (!input) await page.waitForTimeout(250);
    }
    if (!input) {
      const diagnostics = {
        url: page.url(),
        title: await page.title(),
        candidates: inputDiagnostics,
      };
      throw new Error("INPUT_NOT_FOUND: " + JSON.stringify(diagnostics));
    }
    await input.fill(message);
    await input.press("Enter");
    const response = await scanReply(timeoutMs);
    if (response.complete) return { reply: response.reply };
    throw new Error(response.partial ? "ASSISTANT_REPLY_INCOMPLETE" : "ASSISTANT_REPLY_TIMEOUT");
  })`;
}

function runPlaywrightCli(session, code, env, timeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(
      "npx",
      [
        "--yes",
        "@playwright/cli@latest",
        `-s=${session}`,
        "run-code",
        code,
        "--json",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      let parsed;
      try {
        const outer = JSON.parse(stdout);
        if (outer.isError) parsed = { error: outer.error };
        else
          parsed =
            typeof outer.result === "string"
              ? JSON.parse(outer.result)
              : outer.result;
      } catch {
        parsed = { error: stderr.trim() || "Invalid Playwright CLI output" };
      }
      if (
        exitCode !== 0 ||
        parsed?.isError ||
        (!parsed?.reply && !parsed?.noExistingReply)
      ) {
        resolveResult({
          errorCode: classifyBridgeError(parsed?.error, signal),
          error:
            parsed?.error ||
            stderr.trim() ||
            `Playwright CLI exited ${exitCode ?? signal}`,
        });
        return;
      }
      resolveResult({
        reply: parsed.reply,
        noExistingReply: Boolean(parsed.noExistingReply),
        recoveryMode: parsed.recoveryMode,
      });
    });
  });
}

function runCliCommand(session, args, env, timeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(
      "npx",
      ["--yes", "@playwright/cli@latest", `-s=${session}`, ...args],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      try {
        const outer = JSON.parse(stdout);
        if (outer.isError) resolveResult({ ok: false, error: outer.error });
        else
          resolveResult({
            ok: exitCode === 0,
            result: outer.result,
            error: stderr.trim(),
          });
      } catch {
        resolveResult({
          ok: false,
          error: stderr.trim() || `Playwright CLI exited ${exitCode ?? signal}`,
        });
      }
    });
  });
}

function classifyBridgeError(error, signal) {
  const text = String(error ?? "");
  if (text.includes("CONVERSATION_NOT_FOUND")) return "CONVERSATION_NOT_FOUND";
  if (text.includes("INPUT_NOT_FOUND")) return "INPUT_NOT_FOUND";
  if (text.includes("ASSISTANT_REPLY"))
    return text.includes("INCOMPLETE")
      ? "ASSISTANT_REPLY_INCOMPLETE"
      : "ASSISTANT_REPLY_TIMEOUT";
  if (signal) return "CHROME_ATTACH_FAILED";
  return "CHROME_ATTACH_FAILED";
}
