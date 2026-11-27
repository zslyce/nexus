import { NexusError, type ErrorCode } from "../contracts/common.ts";
import { EVENT_TYPES, type NexusEventDraft } from "../contracts/events.ts";
import type { RetentionPolicy } from "../contracts/store.ts";
import { STAGES, TASK_STATUSES, TERMINAL_STATUSES, type Task, type TaskResult } from "../contracts/tasks.ts";

export function storageError(code: ErrorCode, message: string, cause?: unknown): NexusError {
  return new NexusError({ code, message, transient: false }, cause === undefined ? undefined : { cause });
}

export function invalid(message: string): NexusError {
  return storageError("VALIDATION", message);
}

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

function requireText(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${field} must be a non-empty string`);
  }
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") throw invalid(`${field} must be a string`);
}

function requireCount(value: unknown, field: string, min: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw invalid(`${field} must be an integer >= ${min}`);
  }
}

function optional(value: unknown, check: () => void): void {
  if (value !== undefined) check();
}

function requireObject(value: unknown, field: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${field} must be an object`);
  }
}

/** Field-level checks on a complete task (also used on the result of a patch). */
export function assertValidTask(task: Task): void {
  requireText(task.id, "id");
  requireText(task.title, "title");
  requireText(task.prompt, "prompt");
  optional(task.batchId, () => requireText(task.batchId, "batchId"));
  optional(task.context, () => requireString(task.context, "context"));
  optional(task.activity, () => requireString(task.activity, "activity"));
  if (!Array.isArray(task.files) || !task.files.every((file) => typeof file === "string")) {
    throw invalid("files must be an array of strings");
  }
  requireText(task.agent, "agent");
  requireObject(task.model, "model");
  requireText(task.model.providerID, "model.providerID");
  requireText(task.model.id, "model.id");
  if (!(TASK_STATUSES as readonly string[]).includes(task.status)) throw invalid(`unknown status ${String(task.status)}`);
  if (!(STAGES as readonly string[]).includes(task.stage)) throw invalid(`unknown stage ${String(task.stage)}`);
  if (!Array.isArray(task.dependsOn) || !task.dependsOn.every((dep) => typeof dep === "string" && dep !== "")) {
    throw invalid("dependsOn must be an array of task ids");
  }
  if (new Set(task.dependsOn).size !== task.dependsOn.length) throw invalid("dependsOn contains duplicates");
  requireCount(task.attempt, "attempt", 0);
  requireCount(task.maxAttempts, "maxAttempts", 1);
  requireCount(task.timeoutMs, "timeoutMs", 1);
  requireText(task.sessionId, "sessionId");
  requireText(task.promptMessageId, "promptMessageId");
  requireText(task.idempotencyKey, "idempotencyKey");
  requireCount(task.createdAt, "createdAt", 0);
  optional(task.queuedAt, () => requireCount(task.queuedAt, "queuedAt", 0));
  optional(task.startedAt, () => requireCount(task.startedAt, "startedAt", 0));
  optional(task.finishedAt, () => requireCount(task.finishedAt, "finishedAt", 0));
  optional(task.notBefore, () => requireCount(task.notBefore, "notBefore", 0));
  optional(task.lastEventAt, () => requireCount(task.lastEventAt, "lastEventAt", 0));
  optional(task.lastEventSeq, () => requireCount(task.lastEventSeq, "lastEventSeq", 0));
  optional(task.error, () => requireObject(task.error, "error"));
  optional(task.usage, () => requireObject(task.usage, "usage"));
}

export function assertValidDraft(draft: NexusEventDraft): void {
  requireText(draft.event_id, "event_id");
  requireText(draft.task_id, "task_id");
  requireString(draft.session_id, "session_id");
  requireString(draft.agent, "agent");
  if (!(EVENT_TYPES as readonly string[]).includes(draft.event_type)) {
    throw invalid(`unknown event type ${String(draft.event_type)}`);
  }
  requireText(draft.timestamp, "timestamp");
  requireObject(draft.payload, "payload");
}

export function assertValidResult(result: TaskResult): void {
  requireText(result.taskId, "taskId");
  if (!isTerminal(result.status)) throw invalid("result status must be completed, failed or cancelled");
  requireString(result.summary, "summary");
  requireString(result.output, "output");
  if (!Array.isArray(result.filesModified)) throw invalid("filesModified must be an array");
  if (!Array.isArray(result.errors)) throw invalid("errors must be an array");
  requireCount(result.durationMs, "durationMs", 0);
  requireObject(result.model, "model");
  requireText(result.model.providerID, "model.providerID");
  requireText(result.model.id, "model.id");
}

export function assertValidPolicy(policy: RetentionPolicy): void {
  requireCount(policy.maxTasks, "maxTasks", 0);
  requireCount(policy.maxEventsPerTask, "maxEventsPerTask", 0);
  if (typeof policy.maxAgeDays !== "number" || !Number.isFinite(policy.maxAgeDays) || policy.maxAgeDays < 0) {
    throw invalid("maxAgeDays must be a finite number >= 0");
  }
}
