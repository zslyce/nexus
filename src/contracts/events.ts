export const EVENT_TYPES = [
  "TASK_CREATED",
  "TASK_QUEUED",
  "TASK_STARTED",
  "TASK_PROGRESS",
  "TASK_COMPLETED",
  "TASK_FAILED",
  "TASK_CANCELLED",
  "AGENT_STARTED",
  "AGENT_THINKING",
  "AGENT_TOOL_STARTED",
  "AGENT_TOOL_COMPLETED",
  "AGENT_WAITING",
  "AGENT_FINISHED",
  "FILE_READ",
  "FILE_MODIFIED",
  "COMMAND_EXECUTED",
  "ERROR",
  "WARNING",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface NexusEventDraft {
  /** Deterministic when it comes from OpenCode (`<evt_id>:<EVENT_TYPE>[:n]`) so it can be deduplicated. */
  event_id: string;
  task_id: string;
  session_id: string;
  agent: string;
  event_type: EventType;
  /** ISO 8601. */
  timestamp: string;
  /** Small, sanitized data. Never full file contents or credentials. */
  payload: Record<string, unknown>;
}

export interface NexusEvent extends NexusEventDraft {
  /** Monotonic sequence assigned by the store; cursor for resuming subscriptions. */
  seq: number;
}

export interface EventBus {
  /**
   * Persists, then notifies; undefined if the `event_id` already existed.
   * Inside `Store.transaction`, the notification must not run ahead of the commit.
   */
  publish(draft: NexusEventDraft): NexusEvent | undefined;
  publishAll(drafts: NexusEventDraft[]): NexusEvent[];
  /** History after `afterSeq`, then live, with no gaps or duplicates. */
  subscribe(query: { afterSeq?: number; taskId?: string }, signal: AbortSignal): AsyncIterable<NexusEvent>;
}
