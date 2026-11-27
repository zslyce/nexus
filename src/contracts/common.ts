/** Shared base types. Only the orchestrator modifies contracts (see CLAUDE.md). */

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** Text form: `provider/model` or `provider/model#variant`. */
export type ModelString = string;

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Only values reported by OpenCode. Never computed from list prices. */
export interface Usage {
  tokens: TokenUsage;
  reportedCost: number;
}

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export const ERROR_CODES = [
  "VALIDATION",
  "NOT_FOUND",
  "PATH_OUTSIDE_WORKSPACE",
  "PROVIDER_NOT_ALLOWED",
  "MODEL_UNAVAILABLE",
  "AGENT_UNKNOWN",
  "DUPLICATE_TASK",
  "DEPENDENCY_FAILED",
  "DEPENDENCY_CYCLE",
  "OPENCODE_UNAVAILABLE",
  "OPENCODE_AUTH",
  "OPENCODE_API",
  "EXECUTION_FAILED",
  "TIMEOUT",
  "INTERRUPTED",
  "ORPHANED_SESSION",
  "DAEMON_UNAVAILABLE",
  "INTERNAL",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  /** Only transient errors are retried. */
  transient: boolean;
  status?: number;
}

/** The only error type that crosses module boundaries. */
export class NexusError extends Error {
  readonly info: ErrorInfo;

  constructor(info: ErrorInfo, options?: { cause?: unknown }) {
    super(info.message, options);
    this.name = "NexusError";
    this.info = info;
  }
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface Clock {
  now(): number;
}
