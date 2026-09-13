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
  if (typeof value !== "string" || !value || value === "auto") return undefined;
  if (/REPLACE_WITH|placeholder|fixed_conversation/i.test(value))
    return undefined;
  try {
    const url = new URL(value);
    if (!CHATGPT_ORIGINS.has(url.origin)) return undefined;
    return url.toString();
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
export async function runExternalChiefGuiRoundtrip(config, request) {
  const env = loadExtensionEnv(config.extension_env_file);
  const session = config.session ?? "chrome";
  const timeoutMs = config.timeout_ms ?? 180_000;
  const artifact = await loadTransportArtifact(
    request.projectRoot,
    request.runId
  );
  const alreadySubmitted =
    artifact?.submission_started_handoff_hash === request.identity ||
    artifact?.submitted_handoff_hash === request.identity;
  const selection = await ensureConversationTab(
    session,
    [artifact?.resolved_conversation_url, config.conversation_url],
    env,
    timeoutMs
  );
  if (request.projectRoot && request.runId) {
    await saveTransportArtifact(request.projectRoot, request.runId, {
      version: 1,
      run_id: request.runId,
      resolved_conversation_url: selection.url,
      resolved_at: artifact?.resolved_at ?? new Date().toISOString(),
      last_successful_handoff_hash:
        artifact?.last_successful_handoff_hash ?? "",
      ...(artifact?.submission_started_handoff_hash
        ? {
            submission_started_handoff_hash:
              artifact.submission_started_handoff_hash,
          }
        : {}),
      ...(artifact?.submitted_handoff_hash
        ? { submitted_handoff_hash: artifact.submitted_handoff_hash }
        : {}),
      ...(artifact?.submitted_at
        ? { submitted_at: artifact.submitted_at }
        : {}),
    });
    if (!alreadySubmitted) {
      await saveTransportArtifact(request.projectRoot, request.runId, {
        version: 1,
        run_id: request.runId,
        resolved_conversation_url: selection.url,
        resolved_at: artifact?.resolved_at ?? new Date().toISOString(),
        last_successful_handoff_hash:
          artifact?.last_successful_handoff_hash ?? "",
        submission_started_handoff_hash: request.identity,
        submitted_at: new Date().toISOString(),
      });
    }
  }
  const code = extensionRoundtripCode(
    selection.url,
    request.message,
    request.identity,
    request.closingMarker,
    timeoutMs,
    !alreadySubmitted
  );
  const result = await runPlaywrightCli(session, code, env, timeoutMs + 30_000);
  if (!result.reply)
    throw new GuiBridgeError(
      result.errorCode ?? "VERDICT_INVALID",
      result.error ?? "Playwright Extension did not return an assistant reply"
    );
  if (request.projectRoot && request.runId) {
    const latest = (await loadTransportArtifact(
      request.projectRoot,
      request.runId
    )) ?? {
      version: 1,
      run_id: request.runId,
      resolved_conversation_url: selection.url,
      resolved_at: new Date().toISOString(),
      last_successful_handoff_hash: "",
    };
    await saveTransportArtifact(request.projectRoot, request.runId, {
      ...latest,
      resolved_conversation_url: chatgptUrl(result.url) ?? selection.url,
      last_successful_handoff_hash: request.identity,
      submitted_handoff_hash: request.identity,
      submitted_at: latest.submitted_at ?? new Date().toISOString(),
    });
  }
  return { reply: result.reply };
}

async function ensureConversationTab(session, preferredUrls, env, timeoutMs) {
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
  const candidates = [];
  for (const preferred of preferredUrls ?? []) {
    const url = realConversationUrl(preferred);
    if (url) candidates.push(url);
  }
  const tried = new Set();
  let lastDiagnostics;
  for (const url of candidates) {
    let currentEntries = entries;
    let entry = currentEntries.find((item) => sameConversation(item.url, url));
    if (!entry) {
      const opened = await runCliCommand(
        session,
        ["open", url, "--json"],
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
        if (refreshed.ok) {
          currentEntries = tabEntries(refreshed.result);
          entry = currentEntries.find((item) =>
            sameConversation(item.url, url)
          );
        }
      }
    }
    if (entry && !tried.has(entry.index)) {
      tried.add(entry.index);
      const result = await selectAndProbe(session, entry, env, timeoutMs);
      lastDiagnostics = result.diagnostics ?? lastDiagnostics;
      if (result.writable) return result;
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
    lastDiagnostics = result.diagnostics ?? lastDiagnostics;
    if (result.writable) return result;
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
  const freshEntries = tabEntries(listed.result);
  for (const entry of freshEntries) {
    if (!chatgptUrl(entry.url) || tried.has(entry.index)) continue;
    const result = await selectAndProbe(session, entry, env, timeoutMs);
    lastDiagnostics = result.diagnostics ?? lastDiagnostics;
    if (result.writable) return result;
  }
  throw new GuiBridgeError(
    "INPUT_NOT_FOUND",
    `No writable ChatGPT composer was found after one bounded acquisition attempt: ${JSON.stringify(lastDiagnostics ?? {})}`
  );
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
  if (!probe.ok) {
    const errorCode = classifyBridgeError(probe.error, probe.signal);
    return { writable: false, errorCode, error: probe.error };
  }
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

function loadExtensionEnv(envFile) {
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
        try { counts.push({ selector, count: await page.locator(selector).count() }); }
        catch { counts.push({ selector, count: 0 }); }
      }
      return {
        url: page.url(),
        title,
        composer_candidate_counts: counts,
        login_required: /\\/(?:auth\\/login|login)(?:[/?#]|$)/i.test(page.url()) || /log[ -]?in|sign[ -]?in|登录/i.test(text),
        human_verification: /captcha|verify you are human|human verification|人机验证|验证你是人|安全验证/i.test(text),
        conversation_unavailable: /conversation (?:not found|does not exist|unavailable)|对话(?:不存在|不可用|无法加载)|找不到对话/i.test(text),
        conversation_read_only: /read[- ]?only|view[- ]?only|只读|仅查看/i.test(text),
        app_error: /something went wrong|application error|出错了|发生错误|应用错误/i.test(text)
      };
    };
    const visibleEditable = async locator => {
      try {
        if (!(await locator.isVisible())) return false;
        if (typeof locator.isEditable === "function" && !(await locator.isEditable())) return false;
        return true;
      } catch { return false; }
    };
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const locator = page.locator(selector).last();
        if (await visibleEditable(locator)) return { writable: true, url: page.url(), diagnostics: await diagnostics() };
      }
      if (typeof page.getByRole === "function") {
        const locator = page.getByRole("textbox").last();
        if (await visibleEditable(locator)) return { writable: true, url: page.url(), diagnostics: await diagnostics() };
      }
      const state = await diagnostics();
      if (state.login_required || state.human_verification || state.conversation_unavailable || state.conversation_read_only || state.app_error)
        return { writable: false, url: state.url, diagnostics: state };
      await page.waitForTimeout(250);
    }
    return { writable: false, url: page.url(), diagnostics: await diagnostics() };
  })`;
}

function extensionRoundtripCode(
  conversationUrl,
  message,
  identity,
  closingMarker,
  timeoutMs,
  submit = true
) {
  return `(async page => {
    const expectedUrl = ${JSON.stringify(conversationUrl)};
    const message = ${JSON.stringify(message)};
    const identity = ${JSON.stringify(identity)};
    const deadline = Date.now() + ${timeoutMs};
    if (!page.url().startsWith(expectedUrl))
      throw new Error("CONVERSATION_NOT_FOUND: " + page.url());
    const selectors = ${JSON.stringify(INPUT_SELECTORS)};
    const diagnostics = async () => {
      const body = await page.locator("body").innerText().catch(() => "");
      const title = await page.title().catch(() => "");
      const text = (title + "\\n" + body).slice(0, 2500);
      const counts = [];
      for (const selector of selectors) {
        try { counts.push({ selector, count: await page.locator(selector).count() }); }
        catch { counts.push({ selector, count: 0 }); }
      }
      const loginRequired = /\\/(?:auth\\/login|login)(?:[/?#]|$)/i.test(page.url()) || /log[ -]?in|sign[ -]?in|登录/i.test(text);
      const humanVerification = /captcha|verify you are human|human verification|人机验证|验证你是人|安全验证/i.test(text);
      const conversationUnavailable = /conversation (?:not found|does not exist|unavailable)|对话(?:不存在|不可用|无法加载)|找不到对话/i.test(text);
      const conversationReadOnly = /read[- ]?only|view[- ]?only|只读|仅查看/i.test(text);
      const appError = /something went wrong|application error|出错了|发生错误|应用错误/i.test(text);
      return { url: page.url(), title, composer_candidate_counts: counts, login_required: loginRequired, human_verification: humanVerification, conversation_unavailable: conversationUnavailable, conversation_read_only: conversationReadOnly, app_error: appError };
    };
    const visibleEditable = async (locator) => {
      try {
        if (!(await locator.isVisible())) return false;
        if (typeof locator.isEditable === "function" && !(await locator.isEditable())) return false;
        return true;
      } catch { return false; }
    };
    const findComposer = async () => {
      for (const selector of selectors) {
        const locator = page.locator(selector).last();
        if (await visibleEditable(locator)) return locator;
      }
      if (typeof page.getByRole === "function") {
        const locator = page.getByRole("textbox").last();
        if (await visibleEditable(locator)) return locator;
      }
      return undefined;
    };
    let input;
    if (${JSON.stringify(submit)}) {
      let recovered = false;
      const discoveryStarted = Date.now();
      while (!input && Date.now() < deadline) {
        input = await findComposer();
        if (input) break;
        const pageState = await diagnostics();
        if (pageState.login_required) throw new Error("NOT_LOGGED_IN: " + JSON.stringify(pageState));
        if (pageState.human_verification) throw new Error("HUMAN_VERIFICATION_REQUIRED: " + JSON.stringify(pageState));
        if (pageState.conversation_unavailable || pageState.conversation_read_only) throw new Error("CONVERSATION_NOT_FOUND: " + JSON.stringify(pageState));
        if (pageState.app_error) throw new Error("CHATGPT_APP_ERROR: " + JSON.stringify(pageState));
        if (!recovered && Date.now() - discoveryStarted >= 1500) {
          recovered = true;
          await page.reload({ waitUntil: "domcontentloaded", timeout: Math.max(1000, Math.min(30000, deadline - Date.now())) }).catch(() => {});
          await page.waitForTimeout(500);
        } else {
          await page.waitForTimeout(250);
        }
      }
      if (!input) {
        const pageState = await diagnostics();
        throw new Error("INPUT_NOT_FOUND: " + JSON.stringify(pageState));
      }
    }
    if (${JSON.stringify(submit)}) {
      await input.fill(message);
      await input.press("Enter");
      await page.waitForTimeout(250);
      try {
        const remaining = typeof input.inputValue === "function"
          ? await input.inputValue()
          : await input.innerText();
        if (typeof remaining === "string" && remaining.includes(message))
          throw new Error("SEND_FAILED: " + JSON.stringify(await diagnostics()));
      } catch (error) {
        if (String(error?.message ?? error).startsWith("SEND_FAILED:")) throw error;
        throw new Error("SEND_FAILED: submission state was ambiguous; " + JSON.stringify(await diagnostics()));
      }
    }
    let reply = "";
    while (Date.now() < deadline) {
      for (const selector of ${JSON.stringify(ASSISTANT_SELECTORS)}) {
        const assistant = page.locator(selector);
        let count = 0;
        try { count = await assistant.count(); } catch { continue; }
        for (let index = count - 1; index >= 0; index -= 1) {
          let text = "";
          try { text = await assistant.nth(index).innerText(); } catch { continue; }
          if (text.includes(identity)) {
            reply = text;
            if (text.includes(${JSON.stringify(closingMarker)})) return { reply, url: page.url() };
          }
        }
      }
      await page.waitForTimeout(250);
    }
    throw new Error(reply ? "ASSISTANT_REPLY_INCOMPLETE" : "ASSISTANT_REPLY_TIMEOUT");
  })`;
}

function runPlaywrightCli(session, code, env, timeoutMs) {
  return runPlaywrightCode(session, code, env, timeoutMs).then((result) => {
    if (!result.ok || !result.result?.reply)
      return {
        errorCode:
          result.errorCode ?? classifyBridgeError(result.error, result.signal),
        error:
          result.error ??
          "Playwright Extension did not return an assistant reply",
      };
    return { reply: result.result.reply, url: result.result.url };
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
        if (outer.isError) {
          resolveResult({
            ok: false,
            error: outer.error,
            signal,
          });
          return;
        }
        parsed =
          typeof outer.result === "string"
            ? JSON.parse(outer.result)
            : outer.result;
      } catch {
        resolveResult({
          ok: false,
          error: stderr.trim() || "Invalid Playwright CLI output",
          signal,
        });
        return;
      }
      if (exitCode !== 0) {
        resolveResult({
          ok: false,
          error: stderr.trim() || `Playwright CLI exited ${exitCode ?? signal}`,
          signal,
        });
        return;
      }
      resolveResult({ ok: true, result: parsed });
    });
  });
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
  ]) {
    if (text.includes(code)) return code;
  }
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
  extensionRoundtripCode,
  realConversationUrl,
  tabEntries,
};
