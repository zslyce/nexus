import { STAGES, type Stage, type Task, type TaskStatus } from "../contracts/tasks.ts";
import { invalid, isTerminal, storageError } from "./validation.ts";

/**
 * Status transitions from docs/03-architecture.md (state machine). Terminal states have no
 * outgoing transitions. Staying in the same status is always allowed.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["queued", "cancelled", "failed"],
  queued: ["starting", "cancelled", "failed"],
  starting: ["running", "queued", "failed", "cancelling"],
  running: ["waiting", "completed", "failed", "queued", "cancelling"],
  waiting: ["running", "completed", "failed", "queued", "cancelling"],
  cancelling: ["cancelled", "completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** Identity of a task. Patches may repeat the current value but never change it. */
const IMMUTABLE_FIELDS = ["id", "agent", "prompt", "idempotencyKey", "createdAt"] as const;

export function assertNewTaskStatus(status: TaskStatus): void {
  if (status !== "pending" && status !== "queued") {
    throw invalid(`A new task must start as pending or queued, not ${status}`);
  }
}

export function assertStatusTransition(taskId: string, from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw storageError("INTERNAL", `Invalid status transition ${from} -> ${to} for task ${taskId}`);
  }
}

/** The stage never moves back within an attempt. A new attempt may restart from `initialization`. */
export function assertStageProgress(taskId: string, from: Stage, to: Stage): void {
  if (STAGES.indexOf(to) < STAGES.indexOf(from)) {
    throw storageError("INTERNAL", `Stage ${from} -> ${to} moves back within attempt for task ${taskId}`);
  }
}

/**
 * Checks one update of a stored task against the rules of docs/03 and ADR-012.
 * `patch` is what the caller sent; `next` is the task that would be stored.
 */
export function assertUpdateRules(current: Task, next: Task, patch: Partial<Task>): void {
  const id = current.id;

  for (const field of IMMUTABLE_FIELDS) {
    if (Object.hasOwn(patch, field) && patch[field] !== current[field]) {
      throw invalid(`${field} of task ${id} cannot change`);
    }
  }

  const identityChanged =
    next.attempt !== current.attempt ||
    next.sessionId !== current.sessionId ||
    next.promptMessageId !== current.promptMessageId;
  if (isTerminal(current.status) && identityChanged) {
    throw storageError("INTERNAL", `Task ${id} is ${current.status}: its attempt, session and prompt are final`);
  }

  if (next.promptMessageId !== current.promptMessageId && next.attempt <= current.attempt) {
    throw storageError("INTERNAL", `promptMessageId of task ${id} may change only together with a higher attempt`);
  }

  if (next.status !== current.status) {
    assertStatusTransition(id, current.status, next.status);
    // ADR-012(b): a retry after a mid-run failure needs a new attempt with a new session.
    // starting -> queued (ADR-012a) keeps the same IDs and needs no increment.
    const retryFromRun =
      (current.status === "running" || current.status === "waiting") && next.status === "queued";
    if (retryFromRun && (next.attempt !== current.attempt + 1 || next.sessionId === current.sessionId)) {
      throw storageError(
        "INTERNAL",
        `Retry of task ${id} from ${current.status} needs attempt ${current.attempt + 1} and a new session`,
      );
    }
  }

  if (next.attempt < current.attempt) {
    throw storageError("INTERNAL", `Attempt of task ${id} cannot decrease`);
  }
  if (next.attempt === current.attempt) assertStageProgress(id, current.stage, next.stage);
}
