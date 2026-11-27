/**
 * Daemon API. Implemented by the service inside the daemon and mirrored by the IPC client;
 * the MCP server, the CLI and the dashboard depend only on this interface.
 */
import type { AgentDefinition } from "./agents.ts";
import type { NexusEvent } from "./events.ts";
import type { ModelInfo, ServerStatus } from "./gateway.ts";
import type { TaskFilter } from "./store.ts";
import type { BatchItem, DelegateRequest, Task, TaskResult } from "./tasks.ts";

export const IPC_PROTOCOL_VERSION = 1;

export interface DelegateReceipt {
  task: Task;
  /** True if an active task with the same key already existed and no new one was created. */
  deduplicated: boolean;
}

export interface TaskStatusView {
  task: Task;
  durationMs: number;
  lastEvent?: NexusEvent;
  /** Human-readable reason while in pending, queued or waiting. */
  blockedReason?: string;
}

export interface WaitRequest {
  taskIds: string[];
  timeoutMs: number;
  mode: "all" | "any";
}

export interface WaitResponse {
  timedOut: boolean;
  tasks: TaskStatusView[];
}

export interface BridgeStatus {
  protocolVersion: number;
  daemonPid: number;
  workspace: string;
  opencode: ServerStatus;
  /** Models from allowed providers only. */
  models: ModelInfo[];
  agents: (AgentDefinition & { modelAvailable: boolean })[];
  counts: { active: number; queued: number; pending: number; completed: number; failed: number; cancelled: number };
  warnings: string[];
}

export interface BridgeApi {
  delegate(request: DelegateRequest): Promise<DelegateReceipt>;
  /** Atomic: if one entry is invalid or there is a cycle, none is created. */
  delegateBatch(items: BatchItem[]): Promise<(DelegateReceipt & { key: string })[]>;
  getStatus(taskId: string): Promise<TaskStatusView>;
  wait(request: WaitRequest, signal?: AbortSignal): Promise<WaitResponse>;
  cancel(taskId: string): Promise<TaskStatusView>;
  getResult(taskId: string): Promise<{ status: TaskStatusView; result?: TaskResult }>;
  listTasks(filter?: TaskFilter): Promise<TaskStatusView[]>;
  listEvents(query: { taskId?: string; afterSeq?: number; limit?: number }): Promise<NexusEvent[]>;
  /** Replays history after `afterSeq` and continues live until aborted. */
  subscribe(query: { afterSeq?: number; taskId?: string }, signal: AbortSignal): AsyncIterable<NexusEvent>;
  serverStatus(): Promise<BridgeStatus>;
  shutdown(): Promise<void>;
}
