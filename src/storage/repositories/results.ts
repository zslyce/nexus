import type { ErrorInfo, Usage } from "../../contracts/common.ts";
import type { FileChange, TaskResult } from "../../contracts/tasks.ts";
import type { Database } from "../database.ts";
import { storageError } from "../validation.ts";

interface ResultRow {
  task_id: string;
  status: string;
  summary: string;
  output: string;
  files_modified_json: string;
  errors_json: string;
  duration_ms: number;
  model_provider_id: string;
  model_id: string;
  model_variant: string | null;
  usage_json: string | null;
}

export class ResultsRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * One result per task; saving again replaces it (e.g. when recovery finalizes twice). The task
   * must exist and already be in the status the result reports. Callers run this inside a transaction.
   */
  save(result: TaskResult): void {
    const task = this.db.get<{ status: string }>("SELECT status FROM tasks WHERE id = ?", [result.taskId]);
    if (task === undefined) {
      throw storageError("NOT_FOUND", `Task ${result.taskId} not found`);
    }
    if (task.status !== result.status) {
      throw storageError(
        "INTERNAL",
        `Result for task ${result.taskId} reports ${result.status} but the task is ${task.status}`,
      );
    }
    this.db.run(
      `INSERT INTO results (task_id, status, summary, output, files_modified_json, errors_json, duration_ms,
                            model_provider_id, model_id, model_variant, usage_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id) DO UPDATE SET
         status = excluded.status,
         summary = excluded.summary,
         output = excluded.output,
         files_modified_json = excluded.files_modified_json,
         errors_json = excluded.errors_json,
         duration_ms = excluded.duration_ms,
         model_provider_id = excluded.model_provider_id,
         model_id = excluded.model_id,
         model_variant = excluded.model_variant,
         usage_json = excluded.usage_json`,
      [
        result.taskId,
        result.status,
        result.summary,
        result.output,
        JSON.stringify(result.filesModified),
        JSON.stringify(result.errors),
        result.durationMs,
        result.model.providerID,
        result.model.id,
        result.model.variant ?? null,
        result.usage === undefined ? null : JSON.stringify(result.usage),
      ],
    );
  }

  get(taskId: string): TaskResult | undefined {
    const row = this.db.get<ResultRow>("SELECT * FROM results WHERE task_id = ?", [taskId]);
    if (row === undefined) return undefined;
    const result: TaskResult = {
      taskId: row.task_id,
      status: row.status as TaskResult["status"],
      summary: row.summary,
      output: row.output,
      filesModified: JSON.parse(row.files_modified_json) as FileChange[],
      errors: JSON.parse(row.errors_json) as ErrorInfo[],
      durationMs: row.duration_ms,
      model:
        row.model_variant === null
          ? { providerID: row.model_provider_id, id: row.model_id }
          : { providerID: row.model_provider_id, id: row.model_id, variant: row.model_variant },
    };
    if (row.usage_json !== null) result.usage = JSON.parse(row.usage_json) as Usage;
    return result;
  }
}
