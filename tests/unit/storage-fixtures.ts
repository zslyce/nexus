import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../../src/contracts/agents.ts";
import type { NexusEventDraft } from "../../src/contracts/events.ts";
import type { Task, TaskResult, TaskStatus } from "../../src/contracts/tasks.ts";
import type { SqliteStore } from "../../src/storage/sqlite-store.ts";

let sequence = 0;

/** Legal paths from `pending` (docs/03 state machine) to each status. */
const PATHS: Partial<Record<TaskStatus, TaskStatus[]>> = {
  queued: ["queued"],
  starting: ["queued", "starting"],
  running: ["queued", "starting", "running"],
  waiting: ["queued", "starting", "running", "waiting"],
  cancelling: ["queued", "starting", "running", "cancelling"],
  completed: ["queued", "starting", "running", "completed"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

/**
 * Inserts the task as `pending` and walks it through legal transitions to its own status.
 * Stores cannot be seeded directly in a non-initial state, so tests use this path.
 */
export function insertInStatus(store: SqliteStore, task: Task): void {
  store.insertTask({ ...task, status: "pending" });
  for (const step of PATHS[task.status] ?? []) {
    store.updateTask(task.id, { status: step });
  }
}

export function uniqueId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence.toString(36).padStart(6, "0")}`;
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? uniqueId("tsk");
  return {
    id,
    title: "Explore the storage module",
    prompt: "Read the schema and report.",
    files: [],
    agent: "explorer",
    model: { providerID: "opencode-go", id: "mimo-v2.6-flash" },
    status: "pending",
    stage: "initialization",
    dependsOn: [],
    attempt: 1,
    maxAttempts: 2,
    timeoutMs: 600_000,
    sessionId: `ses_nexus_${id}`,
    promptMessageId: `msg_nexus_${id}`,
    idempotencyKey: `key-${id}`,
    createdAt: 1_000,
    ...overrides,
  };
}

export function makeDraft(taskId: string, eventId: string, overrides: Partial<NexusEventDraft> = {}): NexusEventDraft {
  return {
    event_id: eventId,
    task_id: taskId,
    session_id: `ses_nexus_${taskId}`,
    agent: "explorer",
    event_type: "AGENT_THINKING",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { note: "sanitized" },
    ...overrides,
  };
}

export function makeResult(taskId: string, status: TaskResult["status"] = "completed"): TaskResult {
  return {
    taskId,
    status,
    summary: "Done.",
    output: "## Summary\nDone.",
    filesModified: [{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1 }],
    errors: [{ code: "EXECUTION_FAILED", message: "permission rejected", transient: false, status: 403 }],
    durationMs: 4_200,
    model: { providerID: "opencode-go", id: "mimo-v2.6-flash", variant: "high" },
    usage: {
      tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 0, cacheWrite: 0 },
      reportedCost: 0.001,
    },
  };
}

export function makeAgent(name = "explorer"): AgentDefinition {
  return {
    name,
    opencodeId: `nexus-${name}`,
    description: "Read-only exploration",
    model: "opencode-go/mimo-v2.6-flash",
    systemPrompt: "You explore.",
    permissions: [{ action: "read", resource: "*", effect: "allow" }],
    canWrite: false,
    steps: 25,
    timeoutMs: 600_000,
    maxConcurrency: 2,
    source: "config",
  };
}

/** Creates a temporary directory for one test file. Call `cleanup` in an `after` hook. */
export function tempWorkspace(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nexus-storage-"));
  return {
    dir,
    dbPath: join(dir, ".nexus", "nexus.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const DAY = 86_400_000;
