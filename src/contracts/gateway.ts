/**
 * Port to OpenCode. This is the ONLY boundary with `@opencode/client`:
 * only `src/server/**` may import it.
 */
import type { ErrorInfo, ModelRef, PermissionRule, Usage } from "./common.ts";
import type { FileChange } from "./tasks.ts";

/** Native OpenCode event as delivered by the client. `data` varies with `type`. */
export interface RawOpenCodeEvent {
  id: string;
  type: string;
  created?: number;
  location?: { directory: string };
  durable?: { aggregateID: string; seq: number };
  data: Record<string, unknown>;
}

export interface ServerStatus {
  connected: boolean;
  url?: string;
  version?: string;
  error?: ErrorInfo;
}

export interface ModelInfo {
  providerID: string;
  id: string;
  name: string;
  enabled: boolean;
  variants: string[];
  supportsTools: boolean;
}

export interface CreateSessionInput {
  id: string;
  directory: string;
  /** Agent ID in OpenCode (`nexus-<name>`). */
  agent: string;
  model: ModelRef;
  title: string;
  metadata: Record<string, unknown>;
  /** Session rules: they override the agent's, so they must only restrict. */
  permissions: PermissionRule[];
}

export interface SessionSnapshot {
  id: string;
  directory: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  active: boolean;
  metadata?: Record<string, unknown>;
  usage?: Usage;
}

export interface SessionOutput {
  /** Text of the last assistant message. */
  text: string;
  /** False if the prompt never reached the session. */
  promptDelivered: boolean;
  error?: ErrorInfo;
}

export interface OpenCodeGateway {
  /** Discovers the local service; starts one only if `autoStart` and none exists. Never replaces a running one. */
  connect(): Promise<ServerStatus>;
  status(): Promise<ServerStatus>;
  listModels(directory: string): Promise<ModelInfo[]>;
  listAgentIds(directory: string): Promise<string[]>;
  createSession(input: CreateSessionInput): Promise<void>;
  /** Resolves when the message is admitted, not when the agent finishes. Idempotent by `messageId`. */
  prompt(input: { sessionId: string; messageId: string; text: string }): Promise<void>;
  /** Returns false if nothing was running. */
  interrupt(sessionId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<SessionSnapshot | null>;
  listSessions(directory: string): Promise<SessionSnapshot[]>;
  getOutput(sessionId: string, promptMessageId: string): Promise<SessionOutput>;
  getDiff(sessionId: string): Promise<FileChange[]>;
  removeSession(sessionId: string): Promise<void>;
  replyPermission(sessionId: string, requestId: string, decision: "once" | "reject", message?: string): Promise<void>;
  cancelForm(sessionId: string, formId: string): Promise<void>;
  /**
   * Global stream (all of the user's sessions and directories): the consumer must filter.
   * Ends or throws when the connection drops; aborting `signal` must close it without leaving sockets open.
   */
  subscribe(signal: AbortSignal): AsyncIterable<RawOpenCodeEvent>;
}
