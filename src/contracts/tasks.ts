import type { ErrorInfo, ModelRef, Usage } from "./common.ts";

export const TASK_STATUSES = [
  "pending", // waiting for dependencies
  "queued", // ready, waiting for a concurrency slot or a file lock
  "starting", // creating the session and sending the prompt
  "running",
  "waiting", // OpenCode is waiting for a permission or a form
  "cancelling",
  "completed",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];

/** Order matters: a task never moves back a stage within the same attempt. */
export const STAGES = ["initialization", "analysis", "execution", "validation", "finalization"] as const;
export type Stage = (typeof STAGES)[number];

export interface Task {
  /** `tsk_...` */
  id: string;
  batchId?: string;
  title: string;
  prompt: string;
  context?: string;
  /** Workspace-relative paths, already validated. For writing agents they define the lock scope. */
  files: string[];
  agent: string;
  model: ModelRef;
  status: TaskStatus;
  stage: Stage;
  /** Short description of the current activity, derived from real events. */
  activity?: string;
  dependsOn: string[];
  attempt: number;
  maxAttempts: number;
  timeoutMs: number;
  /** Assigned before calling OpenCode so that creating and sending are idempotent. */
  sessionId: string;
  promptMessageId: string;
  idempotencyKey: string;
  createdAt: number;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  /** No retry before this instant (backoff). */
  notBefore?: number;
  lastEventAt?: number;
  lastEventSeq?: number;
  error?: ErrorInfo;
  usage?: Usage;
}

export interface FileChange {
  path: string;
  status: "added" | "deleted" | "modified" | "unknown";
  additions?: number;
  deletions?: number;
}

export interface TaskResult {
  taskId: string;
  status: Extract<TaskStatus, "completed" | "failed" | "cancelled">;
  /** The "## Summary" section of the last message or, if absent, its beginning. No extra inference. */
  summary: string;
  /** Full text of the last assistant message. */
  output: string;
  filesModified: FileChange[];
  errors: ErrorInfo[];
  durationMs: number;
  model: ModelRef;
  usage?: Usage;
}

export interface DelegateRequest {
  task: string;
  agent: string;
  model?: string;
  context?: string;
  files?: string[];
  dependsOn?: string[];
  timeoutMs?: number;
  /** If omitted, derived from agent + model + task + context + files + dependencies. */
  idempotencyKey?: string;
}

export interface BatchItem extends DelegateRequest {
  /** Local name used to reference dependencies within the same batch. */
  key: string;
}
