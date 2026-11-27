import type { EventType, NexusEvent, NexusEventDraft } from "../../contracts/events.ts";
import type { Database } from "../database.ts";

interface EventRow {
  seq: number;
  event_id: string;
  task_id: string;
  session_id: string;
  agent: string;
  event_type: string;
  timestamp: string;
  payload_json: string;
}

export interface EventQuery {
  taskId?: string;
  afterSeq?: number;
  limit?: number;
}

export class EventsRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Returns undefined when `event_id` was already stored (the insert is a no-op). */
  insert(draft: NexusEventDraft): NexusEvent | undefined {
    const result = this.db.run(
      `INSERT INTO events (event_id, task_id, session_id, agent, event_type, timestamp, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        draft.event_id,
        draft.task_id,
        draft.session_id,
        draft.agent,
        draft.event_type,
        draft.timestamp,
        JSON.stringify(draft.payload),
      ],
    );
    if (result.changes === 0) return undefined;
    return {
      seq: result.lastInsertRowid,
      event_id: draft.event_id,
      task_id: draft.task_id,
      session_id: draft.session_id,
      agent: draft.agent,
      event_type: draft.event_type,
      timestamp: draft.timestamp,
      payload: draft.payload,
    };
  }

  list(query: EventQuery): NexusEvent[] {
    const clauses: string[] = [];
    const bind: (string | number)[] = [];
    if (query.taskId !== undefined) {
      clauses.push("task_id = ?");
      bind.push(query.taskId);
    }
    if (query.afterSeq !== undefined) {
      clauses.push("seq > ?");
      bind.push(query.afterSeq);
    }
    let sql = "SELECT * FROM events";
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += " ORDER BY seq ASC";
    if (query.limit !== undefined) {
      sql += " LIMIT ?";
      bind.push(query.limit);
    }
    return this.db.all<EventRow>(sql, bind).map(toEvent);
  }
}

function toEvent(row: EventRow): NexusEvent {
  return {
    seq: row.seq,
    event_id: row.event_id,
    task_id: row.task_id,
    session_id: row.session_id,
    agent: row.agent,
    event_type: row.event_type as EventType,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  };
}
