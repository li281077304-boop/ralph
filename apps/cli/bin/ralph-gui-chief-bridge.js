#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { extractMarkedJson, GuiBridgeError } from "./ralph-gui-bridge.js";
import { getChiefRunDir, writeJsonAtomic } from "@daonhan/ralph-core";

const ASSISTANT_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn"]',
];

export const INPUT_SELECTORS = [
  "#prompt-textarea",
  '[data-testid="textbox"]',
  '[data-testid="composer-text-input"]',
  'textarea[placeholder*="Message" i]',
  'textarea[placeholder*="消息"]',
  '[contenteditable="true"][role="textbox"]',
  'div.ProseMirror[contenteditable="true"]',
  "textarea",
];

const END_MARKER = "<<<END_CHIEF_VERDICT_JSON>>>";
const CHATGPT_ORIGINS = new Set([
  "https://chatgpt.com",
  "https://www.chatgpt.com",
]);
const TRANSPORT_ARTIFACT = "external_chief_transport.json";

function transportArtifactPath(projectRoot, runId) {
  return join(getChiefRunDir(projectRoot, runId), TRANSPORT_ARTIFACT);
}

async function loadTransportArtifact(projectRoot, runId) {
  if (!projectRoot || !runId) return undefined;
  try {
    const value = JSON.parse(
      await readFile(transportArtifactPath(projectRoot, runId), "utf8")
    );
    if (
      value?.version !== 1 ||
      value.run_id !== runId ||
      typeof value.resolved_conversation_url !== "string" ||
      typeof value.resolved_at !== "string" ||
      typeof value.last_successful_handoff_hash !== "string"
    )
      throw new Error("external_chief_transport.json is malformed");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveTransportArtifact(projectRoot, runId, value) {
  if (!projectRoot || !runId) return;
  await writeJsonAtomic(transportArtifactPath(projectRoot, runId), value);
}

function realConversationUrl(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value === "auto" ||
    /REPLACE_WITH|placeholder|fixed_conversation/i.test(value)
  )
    return undefined;
  try {
    const url = new URL(value);
    return CHATGPT_ORIGINS.has(url.origin) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function chatgptUrl(value) {
  try {
    const url = new URL(value);
    return CHATGPT_ORIGINS.has(url.origin) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

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
    projectRoot: context.projectRoot,
    runId: context.runId,
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
  const artifact = await loadTransportArtifact(
    request.projectRoot,
    request.runId
  );
  let alreadySubmitted =
    artifact?.submission_started_handoff_hash === request.identity ||
    artifact?.submitted_handoff_hash === request.identity;
  const meta = {
    chief_request_attempts: 0,
    chief_existing_reply_recoveries: 0,
    chief_timeouts: 0,
    chief_last_attempt_at: null,
  };
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const selection = await ensureTab(
      session,
      [artifact?.resolved_conversation_url, config.conversation_url],
      env,
      timeoutMs
    );
    const conversationUrl =
      selection?.url ?? realConversationUrl(config.conversation_url);
    if (!conversationUrl)
      throw new GuiBridgeError(
        "CONVERSATION_NOT_FOUND",
        "No ChatGPT conversation could be resolved"
      );

    // A timeout can race with a delayed assistant response. Always probe the
    // existing conversation before submitting anything, including retries.
    const probeCode = extensionRoundtripCode(
      conversationUrl,
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
      conversationUrl,
      request.message,
      request.identity,
      request.closingMarker,
      timeoutMs,
      { submit: !alreadySubmitted, graceMs: 0 }
    );
    if (request.projectRoot && request.runId && !alreadySubmitted) {
      await saveTransportArtifact(request.projectRoot, request.runId, {
        version: 1,
        run_id: request.runId,
        resolved_conversation_url: conversationUrl,
        resolved_at: artifact?.resolved_at ?? new Date().toISOString(),
        last_successful_handoff_hash:
          artifact?.last_successful_handoff_hash ?? "",
        submission_started_handoff_hash: request.identity,
        submitted_at: new Date().toISOString(),
      });
      alreadySubmitted = true;
    }
    meta.chief_request_attempts += 1;
    meta.chief_last_attempt_at = new Date().toISOString();
    const result = await runCli(session, code, env, timeoutMs + 30_000);
    if (result.reply) {
      if (request.projectRoot && request.runId) {
        const latest = (await loadTransportArtifact(
          request.projectRoot,
          request.runId
        )) ?? {
          version: 1,
          run_id: request.runId,
          resolved_conversation_url: conversationUrl,
          resolved_at: new Date().toISOString(),
          last_successful_handoff_hash: "",
        };
        await saveTransportArtifact(request.projectRoot, request.runId, {
          ...latest,
          resolved_conversation_url: chatgptUrl(result.url) ?? conversationUrl,
          last_successful_handoff_hash: request.identity,
          submitted_handoff_hash: request.identity,
          submitted_at: latest.submitted_at ?? new Date().toISOString(),
        });
      }
      return { reply: result.reply, ...meta };
    }
    lastError = result;
    const resultErrorCode =
      result.errorCode ??
      (result.noExistingReply ? "ASSISTANT_REPLY_TIMEOUT" : undefined);
    if (!result.errorCode && result.noExistingReply)
      lastError = {
        ...result,
        errorCode: "ASSISTANT_REPLY_TIMEOUT",
        error: "No reply for previously submitted handoff",
      };
    if (
      resultErrorCode !== "ASSISTANT_REPLY_TIMEOUT" &&
      resultErrorCode !== "ASSISTANT_REPLY_INCOMPLETE"
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

/** Cheap deterministic preflight used so configuration failures do not count as real requests. */
export function externalChiefPreflight(config) {
  if (!config?.enabled) return { ok: false, code: "EXTERNAL_NOT_CONFIGURED" };
  const env = loadExtensionEnv(config.extension_env_file);
  if (!env.PLAYWRIGHT_MCP_EXTENSION_TOKEN)
    return {
      ok: false,
      code: "EXTERNAL_PREFLIGHT_FAILURE",
      reason: "extension token unavailable",
    };
  return { ok: true };
}

async function ensureConversationTab(
  session,
  preferredUrls,
  env,
  timeoutMs = 30_000
) {
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
  const entries = tabEntries(listed.result);
  const candidates = (preferredUrls ?? [])
    .map(realConversationUrl)
    .filter(Boolean);
  const tried = new Set();
  let lastError;
  for (const preferred of candidates) {
    let entry = entries.find((item) => sameConversation(item.url, preferred));
    if (!entry) {
      const opened = await runCliCommand(
        session,
        ["open", preferred, "--json"],
        env,
        30_000
      );
      if (opened.ok) {
        const refreshed = await runCliCommand(
          session,
          ["tab-list", "--json"],
          env,
          30_000
        );
        if (refreshed.ok)
          entry = tabEntries(refreshed.result).find((item) =>
            sameConversation(item.url, preferred)
          );
      } else lastError = opened.error;
    }
    if (entry && !tried.has(entry.index)) {
      tried.add(entry.index);
      const result = await selectAndProbe(session, entry, env, timeoutMs);
      if (result.writable) return result;
      lastError = result.error;
      if (
        result.errorCode &&
        !["INPUT_NOT_FOUND", "CONVERSATION_NOT_FOUND"].includes(
          result.errorCode
        )
      )
        throw new GuiBridgeError(result.errorCode, result.error);
    }
  }
  for (const entry of entries) {
    if (!chatgptUrl(entry.url) || tried.has(entry.index)) continue;
    tried.add(entry.index);
    const result = await selectAndProbe(session, entry, env, timeoutMs);
    if (result.writable) return result;
    lastError = result.error;
    if (
      result.errorCode &&
      !["INPUT_NOT_FOUND", "CONVERSATION_NOT_FOUND"].includes(result.errorCode)
    )
      throw new GuiBridgeError(result.errorCode, result.error);
  }
  const opened = await runCliCommand(
    session,
    ["open", "https://chatgpt.com/", "--json"],
    env,
    30_000
  );
  if (!opened.ok)
    throw new GuiBridgeError("CONVERSATION_NOT_FOUND", opened.error);
  listed = await runCliCommand(session, ["tab-list", "--json"], env, 30_000);
  if (!listed.ok)
    throw new GuiBridgeError("CHROME_ATTACH_FAILED", listed.error);
  for (const entry of tabEntries(listed.result)) {
    if (!chatgptUrl(entry.url) || tried.has(entry.index)) continue;
    const result = await selectAndProbe(session, entry, env, timeoutMs);
    if (result.writable) return result;
    lastError = result.error;
  }
  throw new GuiBridgeError(
    "INPUT_NOT_FOUND",
    `No writable ChatGPT composer was found after bounded acquisition: ${lastError ?? "unknown"}`
  );
}

function tabEntries(result) {
  const text =
    typeof result === "string" ? result : JSON.stringify(result ?? "");
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^- (\d+):.*?\((https?:\/\/[^)]+)\)\s*$/);
      return match ? { index: Number(match[1]), url: match[2] } : undefined;
    })
    .filter(Boolean);
}

function sameConversation(actual, expected) {
  try {
    const left = new URL(actual);
    const right = new URL(expected);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return actual === expected;
  }
}

async function selectAndProbe(session, entry, env, timeoutMs) {
  const selected = await runCliCommand(
    session,
    ["tab-select", String(entry.index), "--json"],
    env,
    30_000
  );
  if (!selected.ok)
    return {
      writable: false,
      errorCode: "CONVERSATION_NOT_FOUND",
      error: selected.error,
    };
  const probe = await runPlaywrightCode(
    session,
    composerProbeCode(timeoutMs),
    env,
    Math.min(timeoutMs, 30_000)
  );
  if (!probe.ok)
    return {
      writable: false,
      errorCode: classifyBridgeError(probe.error, probe.signal),
      error: probe.error,
    };
  const value = probe.result ?? {};
  return {
    writable: value.writable === true,
    url: value.url ?? entry.url,
    diagnostics: value.diagnostics,
    errorCode: value.diagnostics?.login_required
      ? "NOT_LOGGED_IN"
      : value.diagnostics?.human_verification
        ? "HUMAN_VERIFICATION_REQUIRED"
        : value.diagnostics?.conversation_unavailable ||
            value.diagnostics?.conversation_read_only
          ? "CONVERSATION_NOT_FOUND"
          : value.writable
            ? undefined
            : "INPUT_NOT_FOUND",
    error: JSON.stringify(value.diagnostics ?? {}),
    index: entry.index,
  };
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

function composerProbeCode(timeoutMs) {
  return `(async page => {
    const selectors = ${JSON.stringify(INPUT_SELECTORS)};
    const deadline = Date.now() + ${Math.min(timeoutMs, 15000)};
    const diagnostics = async () => {
      const body = await page.locator("body").innerText().catch(() => "");
      const title = await page.title().catch(() => "");
      const text = (title + "\\n" + body).slice(0, 2500);
      const counts = [];
      for (const selector of selectors) {
        try { counts.push({ selector, count: await page.locator(selector).count() }); } catch { counts.push({ selector, count: 0 }); }
      }
      let challengeCount = 0;
      try { challengeCount = await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[title*="verification" i], input[type="checkbox"]').count(); } catch {}
      return { url: page.url(), title, composer_candidate_counts: counts,
        login_required: /\\/(?:auth\\/login|login)(?:[/?#]|$)/i.test(page.url()) || /log[ -]?in|sign[ -]?in|登录/i.test(text),
        human_verification: challengeCount > 0 || /captcha|verify you are human|human verification|人机验证|验证你是人|安全验证/i.test(text) || (title.includes("请稍候") && !body.trim()),
        conversation_unavailable: /conversation (?:not found|does not exist|unavailable)|对话(?:不存在|不可用|无法加载)|找不到对话/i.test(text),
        conversation_read_only: /read[- ]?only|view[- ]?only|只读|仅查看/i.test(text),
        app_error: /something went wrong|application error|出错了|发生错误|应用错误/i.test(text) };
    };
    const findFirstEditableInput = ${findFirstEditableInput.toString()};
    let state;
    let reloaded = false;
    const started = Date.now();
    while (Date.now() < deadline) {
      const selection = await findFirstEditableInput(page, selectors);
      state = await diagnostics();
      if (selection.input) return { writable: true, url: page.url(), diagnostics: state };
      if (state.login_required || state.human_verification || state.conversation_unavailable || state.conversation_read_only || state.app_error)
        return { writable: false, url: page.url(), diagnostics: state };
      if (!reloaded && Date.now() - started >= 1500) {
        reloaded = true;
        await page.reload({ waitUntil: "domcontentloaded", timeout: Math.max(1000, Math.min(30000, deadline - Date.now())) }).catch(() => {});
        await page.waitForTimeout(500);
      } else await page.waitForTimeout(250);
    }
    return { writable: false, url: page.url(), diagnostics: state ?? await diagnostics() };
  })`;
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
    const diagnostics = async () => {
      const body = await page.locator("body").innerText().catch(() => "");
      const title = await page.title().catch(() => "");
      const text = (title + "\\n" + body).slice(0, 2500);
      let challengeCount = 0;
      try { challengeCount = await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[title*="verification" i], input[type="checkbox"]').count(); } catch {}
      return { url: page.url(), title,
        login_required: /\\/(?:auth\\/login|login)(?:[/?#]|$)/i.test(page.url()) || /log[ -]?in|sign[ -]?in|登录/i.test(text),
        human_verification: challengeCount > 0 || /captcha|verify you are human|human verification|人机验证|验证你是人|安全验证/i.test(text) || (title.includes("请稍候") && !body.trim()),
        conversation_unavailable: /conversation (?:not found|does not exist|unavailable)|对话(?:不存在|不可用|无法加载)|找不到对话/i.test(text),
        app_error: /something went wrong|application error|出错了|发生错误|应用错误/i.test(text) };
    };
    let input;
    let inputDiagnostics = [];
    let reloaded = false;
    const discoveryStarted = Date.now();
    while (!input && Date.now() < deadline) {
      const selection = await findFirstEditableInput(
        page,
        ${JSON.stringify(INPUT_SELECTORS)}
      );
      input = selection.input;
      inputDiagnostics = selection.diagnostics;
      if (!input) {
        const state = await diagnostics();
        if (state.login_required) throw new Error("NOT_LOGGED_IN: " + JSON.stringify(state));
        if (state.human_verification) throw new Error("HUMAN_VERIFICATION_REQUIRED: " + JSON.stringify(state));
        if (state.conversation_unavailable) throw new Error("CONVERSATION_NOT_FOUND: " + JSON.stringify(state));
        if (state.app_error) throw new Error("CHATGPT_APP_ERROR: " + JSON.stringify(state));
        if (!reloaded && Date.now() - discoveryStarted >= 1500) {
          reloaded = true;
          await page.reload({ waitUntil: "domcontentloaded", timeout: Math.max(1000, Math.min(30000, deadline - Date.now())) }).catch(() => {});
          await page.waitForTimeout(500);
        } else await page.waitForTimeout(250);
      }
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
    await page.waitForTimeout(250);
    try {
      const remaining = typeof input.inputValue === "function" ? await input.inputValue() : await input.innerText();
      if (typeof remaining === "string" && remaining.includes(message)) throw new Error("SEND_FAILED: " + JSON.stringify(await diagnostics()));
    } catch (error) {
      if (String(error?.message ?? error).startsWith("SEND_FAILED:")) throw error;
      throw new Error("SEND_FAILED: submission state was ambiguous; " + JSON.stringify(await diagnostics()));
    }
    const response = await scanReply(timeoutMs);
    if (response.complete) return { reply: response.reply };
    throw new Error(response.partial ? "ASSISTANT_REPLY_INCOMPLETE" : "ASSISTANT_REPLY_TIMEOUT");
  })`;
}

function runPlaywrightCli(session, code, env, timeoutMs) {
  return runPlaywrightCode(session, code, env, timeoutMs).then((result) => {
    if (
      !result.ok ||
      (!result.result?.reply && !result.result?.noExistingReply)
    )
      return {
        errorCode:
          result.errorCode ?? classifyBridgeError(result.error, result.signal),
        error:
          result.error ??
          "Playwright Extension did not return an assistant reply",
      };
    return {
      reply: result.result.reply,
      noExistingReply: Boolean(result.result.noExistingReply),
      recoveryMode: result.result.recoveryMode,
      url: result.result.url,
    };
  });
}

function runPlaywrightCode(session, code, env, timeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(
      "pnpm",
      [
        "dlx",
        "--yes",
        "--package=@playwright/cli",
        "playwright-cli",
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
      if (outerError(parsed) || exitCode !== 0) {
        resolveResult({
          ok: false,
          errorCode: classifyBridgeError(parsed?.error, signal),
          error:
            parsed?.error ||
            stderr.trim() ||
            `Playwright CLI exited ${exitCode ?? signal}`,
        });
        return;
      }
      resolveResult({ ok: true, result: parsed });
    });
  });
}

function outerError(parsed) {
  return !parsed || parsed.isError;
}

function runCliCommand(session, args, env, timeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(
      "pnpm",
      [
        "dlx",
        "--yes",
        "--package=@playwright/cli",
        "playwright-cli",
        `-s=${session}`,
        ...args,
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
  for (const code of [
    "NOT_LOGGED_IN",
    "HUMAN_VERIFICATION_REQUIRED",
    "CONVERSATION_NOT_FOUND",
    "CHATGPT_APP_ERROR",
    "INPUT_NOT_FOUND",
    "SEND_FAILED",
  ])
    if (text.includes(code)) return code;
  if (text.includes("CONVERSATION_NOT_FOUND")) return "CONVERSATION_NOT_FOUND";
  if (text.includes("INPUT_NOT_FOUND")) return "INPUT_NOT_FOUND";
  if (text.includes("ASSISTANT_REPLY"))
    return text.includes("INCOMPLETE")
      ? "ASSISTANT_REPLY_INCOMPLETE"
      : "ASSISTANT_REPLY_TIMEOUT";
  if (signal) return "CHROME_ATTACH_FAILED";
  return "CHROME_ATTACH_FAILED";
}

export {
  classifyBridgeError,
  composerProbeCode,
  ensureConversationTab,
  realConversationUrl,
  sameConversation,
  tabEntries,
};
