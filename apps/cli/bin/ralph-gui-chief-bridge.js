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
export async function runExternalChiefGuiRoundtrip(config, request) {
  const env = loadExtensionEnv(config.extension_env_file);
  const session = config.session ?? "chrome";
  const timeoutMs = config.timeout_ms ?? 180_000;
  const code = extensionRoundtripCode(
    config.conversation_url,
    request.message,
    request.identity,
    request.closingMarker,
    timeoutMs
  );
  await ensureConversationTab(session, config.conversation_url, env);
  const result = await runPlaywrightCli(session, code, env, timeoutMs + 30_000);
  if (!result.reply)
    throw new GuiBridgeError(
      result.errorCode ?? "VERDICT_INVALID",
      result.error ?? "Playwright Extension did not return an assistant reply"
    );
  return { reply: result.reply };
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

function extensionRoundtripCode(
  conversationUrl,
  message,
  identity,
  closingMarker,
  timeoutMs
) {
  return `(async page => {
    const expectedUrl = ${JSON.stringify(conversationUrl)};
    const message = ${JSON.stringify(message)};
    const identity = ${JSON.stringify(identity)};
    const deadline = Date.now() + ${timeoutMs};
    if (!page.url().startsWith(expectedUrl))
      throw new Error("CONVERSATION_NOT_FOUND: " + page.url());
    let input;
    while (!input && Date.now() < deadline) {
      for (const selector of ${JSON.stringify(INPUT_SELECTORS)}) {
        const locator = page.locator(selector).last();
        try { if (await locator.isVisible()) { input = locator; break; } } catch {}
      }
      if (!input) await page.waitForTimeout(250);
    }
    if (!input) throw new Error("INPUT_NOT_FOUND");
    await input.fill(message);
    await input.press("Enter");
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
            if (text.includes(${JSON.stringify(closingMarker)})) return { reply };
          }
        }
      }
      await page.waitForTimeout(250);
    }
    throw new Error(reply ? "ASSISTANT_REPLY_INCOMPLETE" : "ASSISTANT_REPLY_TIMEOUT");
  })`;
}

function runPlaywrightCli(session, code, env, timeoutMs) {
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
      if (exitCode !== 0 || parsed?.isError || !parsed?.reply) {
        resolveResult({
          errorCode: classifyBridgeError(parsed?.error, signal),
          error:
            parsed?.error ||
            stderr.trim() ||
            `Playwright CLI exited ${exitCode ?? signal}`,
        });
        return;
      }
      resolveResult({ reply: parsed.reply });
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
  if (text.includes("CONVERSATION_NOT_FOUND")) return "CONVERSATION_NOT_FOUND";
  if (text.includes("INPUT_NOT_FOUND")) return "INPUT_NOT_FOUND";
  if (text.includes("ASSISTANT_REPLY"))
    return text.includes("INCOMPLETE")
      ? "ASSISTANT_REPLY_INCOMPLETE"
      : "ASSISTANT_REPLY_TIMEOUT";
  if (signal) return "CHROME_ATTACH_FAILED";
  return "CHROME_ATTACH_FAILED";
}
