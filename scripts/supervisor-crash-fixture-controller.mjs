import { readFile, writeFile } from "node:fs/promises";

/**
 * Controller fixture for restart-matrix tests. It records how many times it was
 * started and dies the way the test asks for, without ever changing RUN_STATE
 * unless a scenario explicitly wants progress.
 */
const attemptPath = process.env.RALPH_FIXTURE_ATTEMPTS;
const runStatePath = process.env.RALPH_FIXTURE_RUN_STATE;
if (!attemptPath || !runStatePath) process.exit(64);

let attempts = 0;
try {
  attempts = Number(await readFile(attemptPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
await writeFile(attemptPath, String(attempts + 1), "utf8");

const progressEvery = Number(process.env.RALPH_FIXTURE_PROGRESS_EVERY ?? "0");
if (progressEvery > 0 && attempts + 1 >= progressEvery) {
  const state = JSON.parse(await readFile(runStatePath, "utf8"));
  state.phase = "DONE";
  state.status = "done";
  state.updated_at = new Date().toISOString();
  await writeFile(runStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  process.exit(0);
}

const signal = process.env.RALPH_FIXTURE_CRASH_SIGNAL;
if (signal) {
  process.kill(process.pid, signal);
} else {
  process.exit(Number(process.env.RALPH_FIXTURE_CRASH_CODE ?? "1"));
}
