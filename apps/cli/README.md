# @daonhan/ralph

CLI for **[Ralph](https://github.com/daonhan/ralph)** — a harness that drives Claude Code by
default, or Codex when selected with `--agent codex`, against a target repository in an
iterating implementer → reviewer loop inside an ephemeral Docker sandbox.

Exposes three bin entries (thin wrappers over
**[`@daonhan/ralph-core`](https://www.npmjs.com/package/@daonhan/ralph-core)**):

- **`ralph-afk`** — plan/PRD-driven loop. Iterates until the agent emits `<promise>NO MORE TASKS</promise>`.
- **`ralph-ghafk`** — GitHub-issue-driven loop. Pulls open issues and lets the agent pick the next task.
- **`ralph-chief`** — opt-in Chief/Worker loop. A Chief plans and audits, a Worker edits, and
  non-AI machine gates decide whether the loop can advance.

> **Security:** Ralph runs the selected agent without interactive approval inside the sandbox.
> The host Docker socket is disabled by default; set `RALPH_DOCKER_SOCK=1` only for trusted
> projects that need Testcontainers. See
> [SECURITY.md](https://github.com/daonhan/ralph/blob/main/SECURITY.md).

## Install

```bash
npm i -g @daonhan/ralph
```

## Use

```bash
cd /path/to/your/workspace
ralph-afk "<plan-and-prd>" 5      # plan/PRD loop
ralph-ghafk 5                     # GitHub-issue loop
ralph-chief --repo /path/to/repo --task /path/to/TASK.md --config /path/to/ACCEPTANCE.yaml
ralph-chief run --chief-mode external --repo /path/to/repo --task /path/to/TASK.md --config /path/to/ACCEPTANCE.yaml
ralph-chief resume <run-id> --repo /path/to/repo
pnpm gui-bridge:test -- --config /path/to/gui-bridge.config.json
ralph-afk --agent codex "<plan-and-prd>" 5
ralph-ghafk --agent codex 5
ralph-afk --help                  # flags, env vars
ralph-afk --print-config          # diagnose workspace / docker context / image / socket / history dir
```

Every run appends a readable history file under `<workspace>/.ralph/history/` (one Markdown file
per run, self-gitignored) and injects the last ten stage entries into the next implementer prompt.
Needs `@daonhan/ralph-core` 0.8.0 or later.

Claude is the default; `RALPH_AGENT=codex` is the fallback when `--agent` is absent. Requires
Docker and a login for the selected provider (and `gh` for `ralph-ghafk`). Codex users should
follow the root README's [file-backed login](https://github.com/daonhan/ralph#codex-login) and
[provider configuration](https://github.com/daonhan/ralph#choose-the-coding-agent) instructions.
Both providers run from native Windows shells (PowerShell, cmd, Git Bash) or WSL; log in with
the host CLI from the same shell environment that launches Ralph.
First-run setup, per-OS notes, and the full flag/env reference are in the
**[main README](https://github.com/daonhan/ralph#readme)** and
**[QUICKSTART](https://github.com/daonhan/ralph/blob/main/QUICKSTART.md)**.
Read the full [security threat model](https://github.com/daonhan/ralph/blob/main/SECURITY.md)
before running either provider.

### ChatGPT GUI Bridge (single test)

`ralph-gui-bridge` is a deliberately small, opt-in DOM bridge. It attaches to an already
logged-in Chrome DevTools endpoint, opens the configured conversation, sends one nonce test
message, and validates the marked JSON reply. It does not use OCR, absolute mouse coordinates,
or the clipboard, and it does not connect to Ralph resume or any Chief stage.

Create a JSON config from `config.gui-bridge.example.json`, replacing the conversation URL,
then run:

```bash
pnpm gui-bridge:test -- --config /path/to/gui-bridge.config.json
```

The first setup requires launching Chrome with remote debugging enabled (see the root README
for the exact macOS command). The bridge never starts Chrome itself and fails closed on missing
login, conversation, input, send, timeout, incomplete reply, marker, JSON, or nonce errors.

## License

[MIT](https://github.com/daonhan/ralph/blob/main/LICENSE) © Paul Nguyen.
