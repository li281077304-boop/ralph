import { readFile, writeFile } from "node:fs/promises";

const runStatePath = process.env.RALPH_FIXTURE_RUN_STATE;
const attemptPath = process.env.RALPH_FIXTURE_ATTEMPTS;
if (!runStatePath || !attemptPath) process.exit(64);
const state = JSON.parse(await readFile(runStatePath, "utf8"));
let attempts = 0;
try {
  attempts = Number(await readFile(attemptPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
await writeFile(attemptPath, String(attempts + 1), "utf8");
const scenario = process.env.RALPH_FIXTURE_SCENARIO ?? "worker";
if (attempts === 0) {
  state.phase =
    scenario === "chief"
      ? "CHIEF_REVIEW"
      : scenario === "gate"
        ? "MACHINE_GATE"
        : "WORKER";
  state.status = "running";
  await writeFile(runStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 5);
} else {
  state.phase = "DONE";
  state.status = "done";
  state.stop_reason = "fixture completed after supervisor restart";
  await writeFile(runStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
