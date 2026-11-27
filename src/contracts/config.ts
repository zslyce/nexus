import type { AgentDefinition } from "./agents.ts";
import type { RetentionPolicy } from "./store.ts";

export interface NexusConfig {
  /** Absolute and canonical (realpath). */
  workspace: string;
  /** `<workspace>/.nexus` */
  stateDir: string;
  opencode: { allowedProviders: string[]; autoStart: boolean };
  concurrency: { global: number };
  tasks: {
    defaultTimeoutMs: number;
    maxAttempts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    /** `reject`: deny and report. `surface`: the task stays in `waiting` until timeout or cancellation. */
    permissionPolicy: "reject" | "surface";
    validationCommandPatterns: string[];
  };
  history: RetentionPolicy;
  agents: AgentDefinition[];
}
