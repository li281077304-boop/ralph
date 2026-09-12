#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseExternalChiefVerdict, runChief } from "@daonhan/ralph-core";
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
      const marked = extractMarkedJson(transport.reply);
      const verdict = parseExternalChiefVerdict(JSON.stringify(marked));
      if (!verdict)
        throw new Error(
          "GUI Bridge returned an invalid Ralph external verdict"
        );
      if (
        verdict.run_id !== context.state.runId ||
        verdict.iteration !== context.state.iteration ||
        verdict.handoff_hash !== context.state.handoff?.handoffHash
      )
        throw new Error(
          "GUI Bridge verdict does not match the current handoff"
        );
      const verdictPath = join(context.runDir, "CHIEF_VERDICT.json");
      writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, {
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
