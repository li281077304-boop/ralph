#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runChief } from "@daonhan/ralph-core";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));

runChief(process.argv.slice(2), { cliVersion: pkg.version }).catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
