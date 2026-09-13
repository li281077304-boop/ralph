#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

export const GUI_BRIDGE_MESSAGE = (nonce) => `这是 GUI Bridge 通信测试。

nonce = ${nonce}

请只回复以下机器区块，不执行其他任务：

<<<CHIEF_VERDICT_JSON>>>
{
  "type": "GUI_BRIDGE_TEST",
  "nonce": "${nonce}",
  "status": "OK"
}
<<<END_CHIEF_VERDICT_JSON>>>`;

export class GuiBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GuiBridgeError";
    this.code = code;
  }
}

const ERROR_CODES = {
  ATTACH: "CHROME_ATTACH_FAILED",
  LOGIN: "NOT_LOGGED_IN",
  CONVERSATION: "CONVERSATION_NOT_FOUND",
  INPUT: "INPUT_NOT_FOUND",
  SEND: "SEND_FAILED",
  TIMEOUT: "ASSISTANT_REPLY_TIMEOUT",
  INCOMPLETE: "ASSISTANT_REPLY_INCOMPLETE",
  MARKER: "MARKER_MISSING",
  JSON: "JSON_INVALID",
  NONCE: "NONCE_MISMATCH",
  VERDICT: "VERDICT_INVALID",
};

const INPUT_SELECTORS = [
  '[data-testid="textbox"]',
  'textarea[placeholder*="Message" i]',
  'textarea[placeholder*="消息"]',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
  "textarea",
];

const ASSISTANT_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
  'article[data-testid^="conversation-turn"]',
];

const SEND_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label*="Send" i]',
  'button[aria-label*="发送"]',
];

const STOP_SELECTORS = [
  '[data-testid="stop-button"]',
  'button[aria-label*="Stop" i]',
  'button[aria-label*="停止"]',
];

export function createNonce(random = Math.random) {
  const value = `${Date.now().toString(36)}-${Math.floor(random() * 0x100000000).toString(16)}`;
  return value;
}

export function extractMarkedJson(text, marker = "CHIEF_VERDICT_JSON") {
  const match = text.match(
    new RegExp(`<<<${marker}>>>\\s*([\\s\\S]*?)\\s*<<<END_${marker}>>>`)
  );
  if (!match)
    throw new GuiBridgeError(ERROR_CODES.MARKER, "Reply marker is missing");
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    throw new GuiBridgeError(
      ERROR_CODES.JSON,
      `Reply marker JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function validateVerdict(verdict, nonce) {
  if (!verdict || typeof verdict !== "object" || Array.isArray(verdict))
    throw new GuiBridgeError(ERROR_CODES.VERDICT, "Verdict is not an object");
  if (verdict.type !== "GUI_BRIDGE_TEST")
    throw new GuiBridgeError(ERROR_CODES.VERDICT, "Verdict type is invalid");
  if (verdict.nonce !== nonce)
    throw new GuiBridgeError(ERROR_CODES.NONCE, "Verdict nonce does not match");
  if (verdict.status !== "OK")
    throw new GuiBridgeError(ERROR_CODES.VERDICT, "Verdict status is not OK");
  return verdict;
}

export function parseBridgeArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--config")
      flags.configPath = requiredValue(argv, ++index, arg);
    else if (arg === "--cdp-url")
      flags.cdpUrl = requiredValue(argv, ++index, arg);
    else if (arg === "--conversation-url")
      flags.conversationUrl = requiredValue(argv, ++index, arg);
    else if (arg === "--timeout-ms")
      flags.timeoutMs = Number(requiredValue(argv, ++index, arg));
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else throw new GuiBridgeError("INVALID_USAGE", `Unknown argument: ${arg}`);
  }
  if (
    flags.timeoutMs !== undefined &&
    (!Number.isInteger(flags.timeoutMs) || flags.timeoutMs < 1)
  )
    throw new GuiBridgeError(
      "INVALID_USAGE",
      "--timeout-ms must be a positive integer"
    );
  return flags;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--"))
    throw new GuiBridgeError("INVALID_USAGE", `${flag} requires a value`);
  return value;
}

async function loadConfig(flags) {
  let fileConfig = {};
  if (flags.configPath) {
    try {
      fileConfig = JSON.parse(await readFile(flags.configPath, "utf8"));
    } catch (error) {
      throw new GuiBridgeError(
        "INVALID_CONFIG",
        `Cannot read GUI Bridge config: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const config = {
    cdpUrl:
      flags.cdpUrl ??
      fileConfig.cdpUrl ??
      process.env.CHATGPT_CDP_URL ??
      "http://127.0.0.1:9222",
    conversationUrl:
      flags.conversationUrl ??
      fileConfig.conversationUrl ??
      process.env.CHATGPT_CONVERSATION_URL,
    timeoutMs:
      flags.timeoutMs ??
      fileConfig.timeoutMs ??
      Number(process.env.CHATGPT_GUI_BRIDGE_TIMEOUT_MS ?? 120000),
  };
  if (!config.conversationUrl)
    throw new GuiBridgeError(
      "INVALID_CONFIG",
      "conversationUrl is required via --conversation-url, config JSON, or CHATGPT_CONVERSATION_URL"
    );
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1)
    throw new GuiBridgeError(
      "INVALID_CONFIG",
      "timeoutMs must be a positive integer"
    );
  return config;
}

export async function runGuiBridgeRoundtrip(config, dependencies = {}) {
  const connectOverCDP =
    dependencies.connectOverCDP ?? ((url) => chromium.connectOverCDP(url));
  const nonce = createNonce(dependencies.random);
  let browser;
  try {
    browser = await connectOverCDP(config.cdpUrl);
  } catch (error) {
    throw new GuiBridgeError(
      ERROR_CODES.ATTACH,
      `Cannot attach to Chrome at ${config.cdpUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const page = await locateConversation(
    browser,
    config.conversationUrl,
    config.timeoutMs
  );
  await assertLoggedIn(page);
  const input = await locateInput(page);
  const beforeReply = await assistantTurnSnapshot(page);
  const message = GUI_BRIDGE_MESSAGE(nonce);
  try {
    await input.fill(message);
    const sendButton = await firstVisible(page, SEND_SELECTORS);
    if (sendButton) await sendButton.click();
    else await input.press("Enter");
  } catch (error) {
    throw new GuiBridgeError(
      ERROR_CODES.SEND,
      `Cannot send GUI Bridge message: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const reply = await waitForCompletedAssistant(
    page,
    nonce,
    beforeReply,
    config.timeoutMs
  );
  const verdict = extractMarkedJson(reply);
  validateVerdict(verdict, nonce);
  return { ok: true, nonce, reply, verdict };
}

async function locateConversation(browser, conversationUrl, timeoutMs) {
  const contexts = browser.contexts?.() ?? [];
  const pages = contexts.flatMap((context) => context.pages?.() ?? []);
  let page = pages.find((candidate) =>
    sameConversation(candidate.url(), conversationUrl)
  );
  if (!page) {
    const context = contexts[0];
    if (!context?.newPage)
      throw new GuiBridgeError(
        ERROR_CODES.CONVERSATION,
        "No Chrome page is available"
      );
    try {
      page = await context.newPage();
      await page.goto(conversationUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
    } catch (error) {
      throw new GuiBridgeError(
        ERROR_CODES.CONVERSATION,
        `Cannot open configured conversation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (!sameConversation(page.url(), conversationUrl))
    throw new GuiBridgeError(
      ERROR_CODES.CONVERSATION,
      "Configured conversation was not found"
    );
  return page;
}

function sameConversation(actual, expected) {
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    return (
      actualUrl.origin === expectedUrl.origin &&
      actualUrl.pathname === expectedUrl.pathname
    );
  } catch {
    return actual === expected;
  }
}

async function assertLoggedIn(page) {
  const url = page.url();
  if (/\/auth\/login|\/login(?:[/?#]|$)/i.test(url))
    throw new GuiBridgeError(
      ERROR_CODES.LOGIN,
      "Chrome is not logged in to ChatGPT"
    );
  try {
    const body = (await page.locator("body").innerText()).toLowerCase();
    if (
      (body.includes("log in") || body.includes("登录")) &&
      !body.includes("log out")
    )
      throw new GuiBridgeError(ERROR_CODES.LOGIN, "ChatGPT login is required");
  } catch (error) {
    if (error instanceof GuiBridgeError) throw error;
    // A page without readable body text is handled by the input check below.
  }
}

async function locateInput(page) {
  const input = await firstVisible(page, INPUT_SELECTORS);
  if (!input)
    throw new GuiBridgeError(
      ERROR_CODES.INPUT,
      "ChatGPT message input was not found"
    );
  return input;
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible()) return locator;
    } catch {
      // Try the next semantic selector; a changing ChatGPT DOM is expected.
    }
  }
  return undefined;
}

async function assistantTurnSnapshot(page) {
  for (const selector of ASSISTANT_SELECTORS) {
    const locator = page.locator(selector);
    try {
      const count = await locator.count();
      if (count > 0) {
        return {
          selector,
          count,
          latestText: await locator.nth(count - 1).innerText(),
        };
      }
    } catch {
      // Try the next selector.
    }
  }
  return { selector: ASSISTANT_SELECTORS[0], count: 0, latestText: "" };
}

async function stopButtonVisible(page) {
  return Boolean(await firstVisible(page, STOP_SELECTORS));
}

async function waitForCompletedAssistant(page, nonce, _beforeReply, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawNonce = false;
  while (Date.now() < deadline) {
    for (const selector of ASSISTANT_SELECTORS) {
      const assistant = page.locator(selector);
      let count = 0;
      try {
        count = await assistant.count();
      } catch {
        continue;
      }
      for (let index = count - 1; index >= 0; index -= 1) {
        let current;
        try {
          current = await assistant.nth(index).innerText();
        } catch {
          continue;
        }
        if (!current.includes(nonce)) continue;
        sawNonce = true;
        // The nonce and closing marker in an assistant-role node are the only
        // authoritative completion signals. DOM count/order may be virtualized.
        if (current.includes("<<<END_CHIEF_VERDICT_JSON>>>")) return current;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new GuiBridgeError(
    sawNonce ? ERROR_CODES.INCOMPLETE : ERROR_CODES.TIMEOUT,
    sawNonce
      ? "Assistant reply did not reach a stable completed state"
      : "Assistant reply timed out"
  );
}

function printHelp() {
  process.stdout.write(
    `ralph GUI Bridge (single ChatGPT roundtrip)\n\nUsage:\n  pnpm gui-bridge:test -- --conversation-url URL [--cdp-url URL] [--config FILE]\n\nThe command attaches to an already running Chrome DevTools endpoint. It never starts\nChrome, uses OCR, or uses the clipboard.\n`
  );
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] !== "test")
    throw new GuiBridgeError(
      "INVALID_USAGE",
      "Use: gui-bridge:test test [options]"
    );
  const flags = parseBridgeArgs(argv.slice(1));
  if (flags.help) {
    printHelp();
    return 0;
  }
  const config = await loadConfig(flags);
  const result = await runGuiBridgeRoundtrip(config);
  process.stdout.write(`GUI_BRIDGE_SUCCESS nonce=${result.nonce}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const code = error?.code ?? "GUI_BRIDGE_FAILED";
    process.stderr.write(
      `GUI_BRIDGE_FAIL code=${code}: ${error?.message ?? String(error)}\n`
    );
    process.exitCode = 1;
  });
}
