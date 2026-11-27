import type { AgentDefinition } from "../../contracts/agents.ts";
import type { Database } from "../database.ts";

interface SnapshotRow {
  definition_json: string;
}

/** The agent definition a task ran with. Written once, when the task is inserted. */
export class AgentSnapshotsRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  insert(taskId: string, agent: AgentDefinition, capturedAt: number): void {
    this.db.run("INSERT INTO agent_snapshots (task_id, agent_name, definition_json, captured_at) VALUES (?, ?, ?, ?)", [
      taskId,
      agent.name,
      JSON.stringify(agent),
      capturedAt,
    ]);
  }

  get(taskId: string): AgentDefinition | undefined {
    const row = this.db.get<SnapshotRow>("SELECT definition_json FROM agent_snapshots WHERE task_id = ?", [taskId]);
    return row === undefined ? undefined : (JSON.parse(row.definition_json) as AgentDefinition);
  }
}
