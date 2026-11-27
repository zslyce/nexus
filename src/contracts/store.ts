import type { AgentDefinition } from "./agents.ts";
import type { ErrorInfo } from "./common.ts";
import type { NexusEvent, NexusEventDraft } from "./events.ts";
import type { Task, TaskResult, TaskStatus } from "./tasks.ts";

export interface TaskFilter {
  statuses?: TaskStatus[];
  batchId?: string;
  limit?: number;
}

export interface RetentionPolicy {
  maxTasks: number;
  maxAgeDays: number;
  maxEventsPerTask: number;
}

/** The session and prompt used by one attempt of a task. */
export interface AttemptRecord {
  taskId: string;
  attempt: number;
  sessionId: string;
  promptMessageId: string;
  status: TaskStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: ErrorInfo;
}

/** Synchronous on purpose (`node:sqlite`). A single writer process: the daemon. */
export interface Store {
  /** `agent` is stored as the snapshot of the definition the task runs with. */
  insertTask(task: Task, agent?: AgentDefinition): void;
  /**
   * A patch key whose value is `undefined` clears the field. Enforces the state machine of docs/03.
   * `id`, `agent`, `prompt`, `idempotencyKey` and `createdAt` never change.
   */
  updateTask(id: string, patch: Partial<Task>): Task;
  getAgentSnapshot(taskId: string): AgentDefinition | undefined;
  /** Oldest attempt first. */
  listAttempts(taskId: string): AttemptRecord[];
  getTask(id: string): Task | undefined;
  findByIdempotencyKey(key: string, statuses: TaskStatus[]): Task | undefined;
  findBySessionId(sessionId: string): Task | undefined;
  listTasks(filter?: TaskFilter): Task[];
  /** Ignores duplicates by `event_id`; returns undefined in that case. */
  appendEvent(event: NexusEventDraft): NexusEvent | undefined;
  listEvents(query: { taskId?: string; afterSeq?: number; limit?: number }): NexusEvent[];
  /** The task must already be in the terminal status the result reports: update it first, in the same transaction. */
  saveResult(result: TaskResult): void;
  getResult(taskId: string): TaskResult | undefined;
  /** Never deletes non-terminal tasks or dependencies of non-terminal tasks. */
  prune(policy: RetentionPolicy, now: number): { tasks: number; events: number };
  transaction<T>(fn: () => T): T;
  close(): void;
}
