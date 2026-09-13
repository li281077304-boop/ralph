#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseExternalChiefPlan,
  parseExternalChiefVerdict,
  runChief,
} from "@daonhan/ralph-core";
import { extractMarkedJson } from "./ralph-gui-bridge.js";
import { runExternalChiefGuiBridge } from "./ralph-gui-chief-bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

runChief(process.argv.slice(2), {
  cliVersion: pkg.version,
  externalChiefBridge: async (context) => {
    try {
      const transport = await runExternalChiefGuiBridge(
        context.config.guiBridge,
        context
      );
      const isPlanning = context.phase === "planning";
      const marked = extractMarkedJson(
        transport.reply,
        isPlanning ? "CHIEF_PLAN_JSON" : "CHIEF_VERDICT_JSON"
      );
      const parsed = isPlanning
        ? parseExternalChiefPlan(JSON.stringify(marked))
        : parseExternalChiefVerdict(JSON.stringify(marked));
      if (!parsed)
        throw new Error(
          isPlanning
            ? "GUI Bridge returned an invalid Ralph external plan"
            : "GUI Bridge returned an invalid Ralph external verdict"
        );
      if (
        parsed.run_id !== context.state.runId ||
        parsed.iteration !== context.state.iteration ||
        parsed.handoff_hash !== context.state.handoff?.handoffHash
      )
        throw new Error(
          "GUI Bridge response does not match the current handoff"
        );
      const verdictPath = join(
        context.runDir,
        isPlanning ? "CHIEF_PLAN.json" : "CHIEF_VERDICT.json"
      );
      writeFileSync(verdictPath, `${JSON.stringify(parsed, null, 2)}\n`, {
        flag: "wx",
      });
      return { verdictPath };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
}).catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
