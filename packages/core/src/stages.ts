import type { AgentName } from "./agents/types.js";

/** Provider-neutral per-stage runtime selection. Providers ignore unsupported fields. */
export type StageAgentConfig = {
  agent?: AgentName;
  model?: string;
  reasoningEffort?: string;
};

export type Stage = {
  name: string;
  template: string;
  permissionMode?: string;
} & StageAgentConfig;

// All stages run inside the ephemeral ralph-sandbox container (--rm). Bash +
// edits must auto-approve for AFK to work non-interactively, so every stage
// uses bypassPermissions.
//
// Blast radius depends on the docker.sock mount (off by default — see
// resolveDockerSocketMount in runner.ts): with the socket mounted the agent
// has root-equivalent access to the host Docker daemon (effectively the whole
// host); without RALPH_DOCKER_SOCK=1 it is bounded to the bind-mounted
// workspace tree, which is git-recoverable. See SECURITY.md.
export const STAGES = {
  implementer: {
    name: "implementer",
    template: "afk.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  ghafkImplementer: {
    name: "ghafk-implementer",
    template: "ghafk.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  reviewer: {
    name: "reviewer",
    template: "review.md",
    permissionMode: "bypassPermissions",
  } satisfies Stage,
  chief: {
    name: "chief",
    template: "chief.md",
    // Deliberately no agent/model defaults: this makes the Chief inherit the
    // selected provider unless callers configure it independently.
    permissionMode: "bypassPermissions",
  } satisfies Stage,
};
