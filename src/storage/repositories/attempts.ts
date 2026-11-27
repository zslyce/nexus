import type { ErrorInfo } from "../../contracts/common.ts";
import type { AttemptRecord } from "../../contracts/store.ts";
import type { Task, TaskStatus } from "../../contracts/tasks.ts";
import type { Database } from "../database.ts";

interface AttemptRow {
  task_id: string;
  attempt: number;
  session_id: string;
  prompt_message_id: string;
  status: string;
  started_at: number | null;
  finished_at: number | null;
  error_json: string | null;
}

/**
 * One row per (task, attempt): the session and prompt used by that attempt. The row for the
 * task's current attempt is refreshed on every task write, so it always mirrors the task.
 */
export class AttemptsRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  sync(task: Task): void {
    this.db.run(
      `INSERT INTO attempts (task_id, attempt, session_id, prompt_message_id, status, started_at, finished_at, error_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id, attempt) DO UPDATE SET
         session_id = excluded.session_id,
         prompt_message_id = excluded.prompt_message_id,
         status = excluded.status,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at,
         error_json = excluded.error_json`,
      [
        task.id,
        task.attempt,
        task.sessionId,
        task.promptMessageId,
        task.status,
        task.startedAt ?? null,
        task.finishedAt ?? null,
        task.error === undefined ? null : JSON.stringify(task.error),
      ],
    );
  }

  list(taskId: string): AttemptRecord[] {
    return this.db
      .all<AttemptRow>("SELECT * FROM attempts WHERE task_id = ? ORDER BY attempt ASC", [taskId])
      .map((row) => {
        const record: AttemptRecord = {
          taskId: row.task_id,
          attempt: row.attempt,
          sessionId: row.session_id,
          promptMessageId: row.prompt_message_id,
          status: row.status as TaskStatus,
        };
        if (row.started_at !== null) record.startedAt = row.started_at;
        if (row.finished_at !== null) record.finishedAt = row.finished_at;
        if (row.error_json !== null) record.error = JSON.parse(row.error_json) as ErrorInfo;
        return record;
      });
  }
}
