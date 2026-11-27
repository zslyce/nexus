import type { Migration } from "./runner.ts";

/**
 * Initial schema. Deliberately free of CHECK constraints on enum-like columns: the TypeScript
 * contracts validate values on write, so adding a status or event type does not require
 * rebuilding tables. The one invariant kept in SQL is "one active task per idempotency key".
 */
export const INITIAL_SCHEMA: Migration = {
  version: 1,
  name: "initial-schema",
  sql: `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  batch_id TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  context TEXT,
  files_json TEXT NOT NULL,
  agent TEXT NOT NULL,
  model_provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_variant TEXT,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  activity TEXT,
  attempt INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  prompt_message_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  not_before INTEGER,
  last_event_at INTEGER,
  last_event_seq INTEGER,
  error_json TEXT,
  usage_json TEXT
);
CREATE INDEX tasks_by_batch ON tasks (batch_id);
CREATE INDEX tasks_by_status ON tasks (status);
CREATE INDEX tasks_by_idempotency_key ON tasks (idempotency_key);
CREATE UNIQUE INDEX tasks_one_active_per_idempotency_key
  ON tasks (idempotency_key)
  WHERE status NOT IN ('completed', 'failed', 'cancelled');

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE INDEX task_dependencies_by_parent ON task_dependencies (depends_on_id);

CREATE TABLE attempts (
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  prompt_message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error_json TEXT,
  PRIMARY KEY (task_id, attempt)
);
CREATE INDEX attempts_by_session ON attempts (session_id);

CREATE TABLE agent_snapshots (
  task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX events_by_task ON events (task_id, seq);

CREATE TABLE results (
  task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  output TEXT NOT NULL,
  files_modified_json TEXT NOT NULL,
  errors_json TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  model_provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_variant TEXT,
  usage_json TEXT
);
`,
};
