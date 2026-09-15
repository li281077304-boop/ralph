# Ralph durable development devlog

`devlog/` is the Git-tracked, human-readable history of formal Ralph
development work. It is deliberately separate from `.ralph/` runtime state.

Each entry contains:

- `context.md`: why the work exists, separated into observation, fact,
  assessment, decision, and unknowns.
- `agent-task.md`: the exact text sent to the Agent.
- `task-hash.txt`: SHA-256 of `agent-task.md`; the controller validates it
  immediately before invocation.
- `metadata.json`: stable `run_id`, `round`, `task_id`, `handoff_hash`, and
  task hash links back to runtime evidence.
- `result.md`: what was tested, what was verified in real UAT, and what was
  not verified.
- `decision.md`: durable conclusions, rejected assumptions, open risks, and
  the next recommended action.

The controller must create and read-back-verify `context.md` and
`agent-task.md` before spawning a Worker or Chief. A failed write or hash
validation is fail-closed and must result in zero Agent invocations.

Runtime details remain under `.ralph/chief-runs/`; entries link back to them
with `run_id`, `round`, `task_id`, and `handoff_hash` rather than copying raw
logs into Git.
