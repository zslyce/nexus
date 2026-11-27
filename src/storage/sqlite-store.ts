import type { AgentDefinition } from "../contracts/agents.ts";
import { NexusError } from "../contracts/common.ts";
import type { NexusEvent, NexusEventDraft } from "../contracts/events.ts";
import type { AttemptRecord, RetentionPolicy, Store, TaskFilter } from "../contracts/store.ts";
import { TASK_STATUSES, TERMINAL_STATUSES, type Task, type TaskResult, type TaskStatus } from "../contracts/tasks.ts";
import { Database, openDatabase, type OpenDatabaseOptions } from "./database.ts";
import { assertNewTaskStatus, assertUpdateRules } from "./transitions.ts";
import { AgentSnapshotsRepository } from "./repositories/agent-snapshots.ts";
import { AttemptsRepository } from "./repositories/attempts.ts";
import { EventsRepository, type EventQuery } from "./repositories/events.ts";
import { ResultsRepository } from "./repositories/results.ts";
import { TasksRepository } from "./repositories/tasks.ts";
import { pruneHistory, type PruneOutcome } from "./retention.ts";
import {
  assertValidDraft,
  assertValidResult,
  assertValidPolicy,
  assertValidTask,
  invalid,
  storageError,
} from "./validation.ts";

const NON_TERMINAL_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter(
  (status) => !(TERMINAL_STATUSES as readonly string[]).includes(status),
);
const TASK_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "batchId",
  "title",
  "prompt",
  "context",
  "files",
  "agent",
  "model",
  "status",
  "stage",
  "activity",
  "dependsOn",
  "attempt",
  "maxAttempts",
  "timeoutMs",
  "sessionId",
  "promptMessageId",
  "idempotencyKey",
  "createdAt",
  "queuedAt",
  "startedAt",
  "finishedAt",
  "notBefore",
  "lastEventAt",
  "lastEventSeq",
  "error",
  "usage",
]);

/** SQLite result codes: BUSY (5) and LOCKED (6) are retryable; FOREIGN KEY (787) is a missing row. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_FOREIGN_KEY = 787;
const SQLITE_UNIQUE = 2067;

/**
 * `Store` over `node:sqlite`. Single writer (the daemon). Every mutation is one transaction;
 * extra read methods beyond the contract are for the task core and for diagnostics.
 */
export class SqliteStore implements Store {
  private readonly database: Database;
  private readonly tasks: TasksRepository;
  private readonly attemptsRepository: AttemptsRepository;
  private readonly snapshots: AgentSnapshotsRepository;
  private readonly events: EventsRepository;
  private readonly results: ResultsRepository;

  constructor(database: Database) {
    this.database = database;
    this.tasks = new TasksRepository(database);
    this.attemptsRepository = new AttemptsRepository(database);
    this.snapshots = new AgentSnapshotsRepository(database);
    this.events = new EventsRepository(database);
    this.results = new ResultsRepository(database);
  }

  get path(): string {
    return this.database.path;
  }

  /**
   * Inserts a new task with its dependencies, attempt record and (optionally) the agent definition
   * it runs with. Dependencies must already be stored: insert them first, in the same transaction if needed.
   */
  insertTask(task: Task, agent?: AgentDefinition): void {
    this.guard("insertTask", () =>
      this.database.transaction(() => {
        assertValidTask(task);
        assertNewTaskStatus(task.status);
        if (this.tasks.exists(task.id)) throw storageError("DUPLICATE_TASK", `Task ${task.id} already exists`);
        const active = this.tasks.findByIdempotencyKey(task.idempotencyKey, NON_TERMINAL_STATUSES);
        if (active !== undefined) {
          throw storageError(
            "DUPLICATE_TASK",
            `Task ${active.id} is still active with the same idempotency key`,
          );
        }
        this.assertSessionFree(task.sessionId, task.id);
        this.assertDependencyTargets(task.id, task.dependsOn);

        this.tasks.insert(task);
        this.tasks.replaceDependencies(task.id, task.dependsOn);
        this.attemptsRepository.sync(task);
        if (agent !== undefined) this.snapshots.insert(task.id, agent, task.createdAt);
      }),
    );
  }

  /**
   * Applies a patch and returns the stored task. Fields whose value is `undefined` are cleared.
   * Enforces docs/03 and ADR-012: identity fields are immutable, terminal tasks keep their
   * attempt, session and prompt, status moves follow the state machine, retries from a run need
   * a new attempt and session, and the stage never moves back within an attempt.
   */
  updateTask(id: string, patch: Partial<Task>): Task {
    return this.guard("updateTask", () =>
      this.database.transaction(() => {
        const current = this.tasks.get(id);
        if (current === undefined) throw storageError("NOT_FOUND", `Task ${id} not found`);
        for (const key of Object.keys(patch)) {
          if (!TASK_FIELDS.has(key)) throw invalid(`Unknown task field ${key}`);
        }
        if (Object.hasOwn(patch, "id") && patch.id !== id) throw invalid("A task cannot change its id");

        const next = applyPatch(current, patch);
        assertValidTask(next);
        assertUpdateRules(current, next, patch);
        if (next.sessionId !== current.sessionId) this.assertSessionFree(next.sessionId, id);
        const dependenciesChanged = patch.dependsOn !== undefined;
        if (dependenciesChanged) {
          this.assertDependencyTargets(id, next.dependsOn);
          this.assertNoCycle(id, next.dependsOn);
        }

        this.tasks.update(next);
        if (dependenciesChanged) this.tasks.replaceDependencies(id, next.dependsOn);
        this.attemptsRepository.sync(next);

        const stored = this.tasks.get(id);
        if (stored === undefined) throw storageError("INTERNAL", `Task ${id} vanished during update`);
        return stored;
      }),
    );
  }

  getTask(id: string): Task | undefined {
    return this.guard("getTask", () => this.tasks.get(id));
  }

  findByIdempotencyKey(key: string, statuses: TaskStatus[]): Task | undefined {
    return this.guard("findByIdempotencyKey", () => this.tasks.findByIdempotencyKey(key, statuses));
  }

  findBySessionId(sessionId: string): Task | undefined {
    return this.guard("findBySessionId", () => this.tasks.findBySessionId(sessionId));
  }

  /** Oldest first (scheduler FIFO). `statuses: []` matches nothing. */
  listTasks(filter: TaskFilter = {}): Task[] {
    return this.guard("listTasks", () => {
      for (const status of filter.statuses ?? []) {
        if (!(TASK_STATUSES as readonly string[]).includes(status)) throw invalid(`Unknown status ${status}`);
      }
      if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit < 1)) {
        throw invalid("limit must be an integer >= 1");
      }
      return this.tasks.list(filter);
    });
  }

  /** Returns undefined when `event_id` was already stored. */
  appendEvent(event: NexusEventDraft): NexusEvent | undefined {
    return this.guard("appendEvent", () => {
      assertValidDraft(event);
      return this.events.insert(event);
    });
  }

  /** Ascending `seq`. Without `limit` the whole range is returned. */
  listEvents(query: EventQuery): NexusEvent[] {
    return this.guard("listEvents", () => {
      if (query.afterSeq !== undefined && (!Number.isSafeInteger(query.afterSeq) || query.afterSeq < 0)) {
        throw invalid("afterSeq must be an integer >= 0");
      }
      if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) {
        throw invalid("limit must be an integer >= 1");
      }
      return this.events.list(query);
    });
  }

  /** The task must already be in the terminal status the result reports (checked in the same transaction). */
  saveResult(result: TaskResult): void {
    this.guard("saveResult", () =>
      this.database.transaction(() => {
        assertValidResult(result);
        this.results.save(result);
      }),
    );
  }

  getResult(taskId: string): TaskResult | undefined {
    return this.guard("getResult", () => this.results.get(taskId));
  }

  /** The agent definition stored when the task was inserted (if one was given). */
  getAgentSnapshot(taskId: string): AgentDefinition | undefined {
    return this.guard("getAgentSnapshot", () => this.snapshots.get(taskId));
  }

  listAttempts(taskId: string): AttemptRecord[] {
    return this.guard("listAttempts", () => this.attemptsRepository.list(taskId));
  }

  prune(policy: RetentionPolicy, now: number): PruneOutcome {
    assertValidPolicy(policy);
    const outcome = this.guard("prune", () => pruneHistory(this.database, policy, now));
    try {
      this.database.reclaimSpace();
    } catch {
      // Best effort: the prune already committed. Free pages are reclaimed by a later prune.
    }
    return outcome;
  }

  /**
   * Nestable: a nested call runs as a savepoint, so a caught inner failure rolls back only its
   * own writes. `fn` must be synchronous.
   */
  transaction<T>(fn: () => T): T {
    try {
      return this.database.transaction(fn);
    } catch (error) {
      if (isSqliteError(error)) throw translateSqliteError(error, "transaction");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private guard<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof NexusError) throw error;
      if (isSqliteError(error)) throw translateSqliteError(error, operation);
      throw storageError("INTERNAL", `Storage operation ${operation} failed`, error);
    }
  }

  private assertSessionFree(sessionId: string, taskId: string): void {
    const other = this.tasks.findBySessionId(sessionId);
    if (other !== undefined && other.id !== taskId) {
      throw storageError("INTERNAL", `Session ${sessionId} is already assigned to task ${other.id}`);
    }
  }

  private assertDependencyTargets(taskId: string, dependsOn: readonly string[]): void {
    if (new Set(dependsOn).size !== dependsOn.length) throw invalid("dependsOn contains duplicates");
    for (const dependency of dependsOn) {
      if (dependency === taskId) throw storageError("DEPENDENCY_CYCLE", `Task ${taskId} cannot depend on itself`);
      if (!this.tasks.exists(dependency)) {
        throw storageError("NOT_FOUND", `Dependency ${dependency} of task ${taskId} not found`);
      }
    }
  }

  /** A cycle exists if any new dependency already (transitively) depends on the task. */
  private assertNoCycle(taskId: string, dependsOn: readonly string[]): void {
    const edges = this.tasks.dependencyEdges();
    const seen = new Set<string>();
    const stack = [...dependsOn];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined || seen.has(node)) continue;
      if (node === taskId) throw storageError("DEPENDENCY_CYCLE", `Dependencies of task ${taskId} form a cycle`);
      seen.add(node);
      for (const next of edges.get(node) ?? []) stack.push(next);
    }
  }
}

/** Opens (creating if needed) the database at `path` and returns a ready `Store`. */
export function openStore(path: string, options?: OpenDatabaseOptions): SqliteStore {
  return new SqliteStore(openDatabase(path, options));
}

function applyPatch(current: Task, patch: Partial<Task>): Task {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as unknown as Task;
}

function isSqliteError(error: unknown): boolean {
  return typeof (error as { errcode?: unknown } | null)?.errcode === "number";
}

function translateSqliteError(error: unknown, operation: string): NexusError {
  const errcode = (error as { errcode: number }).errcode;
  const detail = error instanceof Error ? error.message : String(error);
  if (errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED) {
    return new NexusError(
      { code: "INTERNAL", message: `Database is busy during ${operation}`, transient: true },
      { cause: error },
    );
  }
  if (errcode === SQLITE_FOREIGN_KEY) {
    return storageError("NOT_FOUND", `${operation}: a referenced row does not exist`, error);
  }
  if (errcode === SQLITE_UNIQUE && detail.includes("idempotency_key")) {
    return storageError("DUPLICATE_TASK", `${operation}: an active task already has this idempotency key`, error);
  }
  return storageError("INTERNAL", `Storage operation ${operation} failed: ${detail}`, error);
}
