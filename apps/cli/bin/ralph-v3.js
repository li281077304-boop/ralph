#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const supervisor = fileURLToPath(
  new URL("./ralph-v3-supervisor.js", import.meta.url)
);
const child = spawn(process.execPath, [supervisor, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.once("error", (error) => {
  process.stderr.write(
    `Ralph V3 supervisor failed to start: ${error.message}\n`
  );
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
