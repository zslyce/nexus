import type { ErrorInfo, Usage } from "../../contracts/common.ts";
import type { TaskFilter } from "../../contracts/store.ts";
import type { Stage, Task, TaskStatus } from "../../contracts/tasks.ts";
import type { Database, SqlParam } from "../database.ts";

const TASK_COLUMNS = [
  "id",
  "batch_id",
  "title",
  "prompt",
  "context",
  "files_json",
  "agent",
  "model_provider_id",
  "model_id",
  "model_variant",
  "status",
  "stage",
  "activity",
  "attempt",
  "max_attempts",
  "timeout_ms",
  "session_id",
  "prompt_message_id",
  "idempotency_key",
  "created_at",
  "queued_at",
  "started_at",
  "finished_at",
  "not_before",
  "last_event_at",
  "last_event_seq",
  "error_json",
  "usage_json",
] as const;
type TaskColumn = (typeof TASK_COLUMNS)[number];

/** Typed on purpose: every column must be provided, otherwise it does not compile. */
type TaskColumnValues = Record<TaskColumn, SqlParam>;

const INSERT_SQL = `INSERT INTO tasks (${TASK_COLUMNS.join(", ")}) VALUES (${TASK_COLUMNS.map(() => "?").join(", ")})`;
const UPDATE_SQL = `UPDATE tasks SET ${TASK_COLUMNS.filter((c) => c !== "id")
  .map((c) => `${c} = ?`)
  .join(", ")} WHERE id = ?`;

interface TaskRow {
  id: string;
  batch_id: string | null;
  title: string;
  prompt: string;
  context: string | null;
  files_json: string;
  agent: string;
  model_provider_id: string;
  model_id: string;
  model_variant: string | null;
  status: string;
  stage: string;
  activity: string | null;
  attempt: number;
  max_attempts: number;
  timeout_ms: number;
  session_id: string;
  prompt_message_id: string;
  idempotency_key: string;
  created_at: number;
  queued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  not_before: number | null;
  last_event_at: number | null;
  last_event_seq: number | null;
  error_json: string | null;
  usage_json: string | null;
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function taskToColumns(task: Task): TaskColumnValues {
  return {
    id: task.id,
    batch_id: task.batchId ?? null,
    title: task.title,
    prompt: task.prompt,
    context: task.context ?? null,
    files_json: JSON.stringify(task.files),
    agent: task.agent,
    model_provider_id: task.model.providerID,
    model_id: task.model.id,
    model_variant: task.model.variant ?? null,
    status: task.status,
    stage: task.stage,
    activity: task.activity ?? null,
    attempt: task.attempt,
    max_attempts: task.maxAttempts,
    timeout_ms: task.timeoutMs,
    session_id: task.sessionId,
    prompt_message_id: task.promptMessageId,
    idempotency_key: task.idempotencyKey,
    created_at: task.createdAt,
    queued_at: task.queuedAt ?? null,
    started_at: task.startedAt ?? null,
    finished_at: task.finishedAt ?? null,
    not_before: task.notBefore ?? null,
    last_event_at: task.lastEventAt ?? null,
    last_event_seq: task.lastEventSeq ?? null,
    error_json: json(task.error),
    usage_json: json(task.usage),
  };
}

function rowToTask(row: TaskRow, dependsOn: string[]): Task {
  const task: Task = {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    files: JSON.parse(row.files_json) as string[],
    agent: row.agent,
    model:
      row.model_variant === null
        ? { providerID: row.model_provider_id, id: row.model_id }
        : { providerID: row.model_provider_id, id: row.model_id, variant: row.model_variant },
    status: row.status as TaskStatus,
    stage: row.stage as Stage,
    dependsOn,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    timeoutMs: row.timeout_ms,
    sessionId: row.session_id,
    promptMessageId: row.prompt_message_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
  if (row.batch_id !== null) task.batchId = row.batch_id;
  if (row.context !== null) task.context = row.context;
  if (row.activity !== null) task.activity = row.activity;
  if (row.queued_at !== null) task.queuedAt = row.queued_at;
  if (row.started_at !== null) task.startedAt = row.started_at;
  if (row.finished_at !== null) task.finishedAt = row.finished_at;
  if (row.not_before !== null) task.notBefore = row.not_before;
  if (row.last_event_at !== null) task.lastEventAt = row.last_event_at;
  if (row.last_event_seq !== null) task.lastEventSeq = row.last_event_seq;
  if (row.error_json !== null) task.error = JSON.parse(row.error_json) as ErrorInfo;
  if (row.usage_json !== null) task.usage = JSON.parse(row.usage_json) as Usage;
  return task;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** Rows of `tasks` and `task_dependencies`. The dependency list keeps its insertion order. */
export class TasksRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  insert(task: Task): void {
    const columns = taskToColumns(task);
    this.db.run(
      INSERT_SQL,
      TASK_COLUMNS.map((c) => columns[c]),
    );
  }

  update(task: Task): void {
    const columns = taskToColumns(task);
    const values = TASK_COLUMNS.filter((c) => c !== "id").map((c) => columns[c]);
    this.db.run(UPDATE_SQL, [...values, task.id]);
  }

  exists(id: string): boolean {
    return this.db.get("SELECT 1 FROM tasks WHERE id = ?", [id]) !== undefined;
  }

  get(id: string): Task | undefined {
    const row = this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [id]);
    return row === undefined ? undefined : this.hydrate(row);
  }

  findBySessionId(sessionId: string): Task | undefined {
    const row = this.db.get<TaskRow>("SELECT * FROM tasks WHERE session_id = ?", [sessionId]);
    return row === undefined ? undefined : this.hydrate(row);
  }

  findByIdempotencyKey(key: string, statuses: readonly TaskStatus[]): Task | undefined {
    if (statuses.length === 0) return undefined;
    const row = this.db.get<TaskRow>(
      `SELECT * FROM tasks WHERE idempotency_key = ? AND status IN (${placeholders(statuses.length)})
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [key, ...statuses],
    );
    return row === undefined ? undefined : this.hydrate(row);
  }

  list(filter: TaskFilter = {}): Task[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return [];
      clauses.push(`status IN (${placeholders(filter.statuses.length)})`);
      params.push(...filter.statuses);
    }
    if (filter.batchId !== undefined) {
      clauses.push("batch_id = ?");
      params.push(filter.batchId);
    }
    let sql = "SELECT * FROM tasks";
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY created_at ASC, rowid ASC";
    if (filter.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }
    return this.db.all<TaskRow>(sql, params).map((row) => this.hydrate(row));
  }

  dependenciesOf(taskId: string): string[] {
    return this.db
      .all<{ depends_on_id: string }>("SELECT depends_on_id FROM task_dependencies WHERE task_id = ? ORDER BY position", [taskId])
      .map((row) => row.depends_on_id);
  }

  replaceDependencies(taskId: string, dependsOn: readonly string[]): void {
    this.db.run("DELETE FROM task_dependencies WHERE task_id = ?", [taskId]);
    dependsOn.forEach((dependency, position) => {
      this.db.run("INSERT INTO task_dependencies (task_id, depends_on_id, position) VALUES (?, ?, ?)", [
        taskId,
        dependency,
        position,
      ]);
    });
  }

  /** Every edge as `task -> dependency`. Used for graph checks and retention. */
  dependencyEdges(): Map<string, string[]> {
    const edges = new Map<string, string[]>();
    const rows = this.db.all<{ task_id: string; depends_on_id: string }>(
      "SELECT task_id, depends_on_id FROM task_dependencies ORDER BY task_id, position",
    );
    for (const row of rows) {
      const list = edges.get(row.task_id);
      if (list === undefined) edges.set(row.task_id, [row.depends_on_id]);
      else list.push(row.depends_on_id);
    }
    return edges;
  }

  private hydrate(row: TaskRow): Task {
    return rowToTask(row, this.dependenciesOf(row.id));
  }
}
