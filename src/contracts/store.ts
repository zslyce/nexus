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

/** Synchronous on purpose (`node:sqlite`). A single writer process: the daemon. */
export interface Store {
  insertTask(task: Task): void;
  updateTask(id: string, patch: Partial<Task>): Task;
  getTask(id: string): Task | undefined;
  findByIdempotencyKey(key: string, statuses: TaskStatus[]): Task | undefined;
  findBySessionId(sessionId: string): Task | undefined;
  listTasks(filter?: TaskFilter): Task[];
  /** Ignores duplicates by `event_id`; returns undefined in that case. */
  appendEvent(event: NexusEventDraft): NexusEvent | undefined;
  listEvents(query: { taskId?: string; afterSeq?: number; limit?: number }): NexusEvent[];
  saveResult(result: TaskResult): void;
  getResult(taskId: string): TaskResult | undefined;
  /** Never deletes non-terminal tasks or dependencies of non-terminal tasks. */
  prune(policy: RetentionPolicy, now: number): { tasks: number; events: number };
  transaction<T>(fn: () => T): T;
  close(): void;
}
