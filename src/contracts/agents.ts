import type { ModelString, PermissionRule } from "./common.ts";

export interface AgentDefinition {
  /** Name in Nexus, e.g. `explorer`. */
  name: string;
  /** ID in OpenCode: `nexus-<name>`. */
  opencodeId: string;
  description: string;
  model: ModelString;
  systemPrompt: string;
  permissions: PermissionRule[];
  canWrite: boolean;
  /** Budget: maximum number of agent steps (`steps` in OpenCode). */
  steps: number;
  timeoutMs: number;
  maxConcurrency: number;
  /** Derived by the config loader: `claude-agents` when `from` is set, otherwise `config`. */
  source: "config" | "claude-agents";
  /**
   * Path to a `.md` in `.claude/agents/`. The config loader copies it as is (leaving `description`
   * and `systemPrompt` empty if omitted); the registry fills them in.
   */
  from?: string;
}

export interface AgentRegistry {
  list(): AgentDefinition[];
  get(name: string): AgentDefinition | undefined;
  /**
   * Generates `.opencode/agents/nexus-*.md` in the workspace. Only overwrites files
   * that carry its own generated marker.
   */
  sync(): Promise<{ written: string[]; unchanged: string[]; skipped: { path: string; reason: string }[] }>;
}
