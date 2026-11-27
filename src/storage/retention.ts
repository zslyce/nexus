import type { RetentionPolicy } from "../contracts/store.ts";
import type { TaskStatus } from "../contracts/tasks.ts";
import type { Database } from "./database.ts";
import { TasksRepository } from "./repositories/tasks.ts";
import { assertValidPolicy, invalid, isTerminal, storageError } from "./validation.ts";

const DAY_MS = 86_400_000;

interface HistoryRow {
  id: string;
  status: TaskStatus;
  created_at: number;
  finished_at: number | null;
}

export interface PruneOutcome {
  tasks: number;
  events: number;
}

/**
 * Applies a retention policy in one transaction.
 *
 * - Active (non-terminal) tasks are never deleted, and neither is anything they depend on,
 *   directly or transitively. Their events are not trimmed either.
 * - Candidates are terminal tasks that are either older than `maxAgeDays` or beyond the
 *   `maxTasks` budget (newest kept first, active tasks counted against the budget).
 * - A candidate that some kept task still depends on is kept, so no surviving task loses an edge.
 * - Terminal tasks that survive have their events trimmed to the newest `maxEventsPerTask`.
 */
export function pruneHistory(database: Database, policy: RetentionPolicy, now: number): PruneOutcome {
  assertValidPolicy(policy);
  if (!Number.isFinite(now)) throw invalid("now must be a finite timestamp");

  return database.transaction(() => {
    const tasks = new TasksRepository(database);
    const rows = database.all<HistoryRow>(
      "SELECT id, status, created_at, finished_at FROM tasks ORDER BY created_at DESC, rowid DESC",
    );
    const edges = tasks.dependencyEdges();

    const active = rows.filter((row) => !isTerminal(row.status)).map((row) => row.id);
    const terminal = rows.filter((row) => isTerminal(row.status));
    const cutoff = now - policy.maxAgeDays * DAY_MS;
    const budget = Math.max(0, policy.maxTasks - active.length);

    const candidates = new Set<string>();
    terminal.forEach((row, rank) => {
      const age = row.finished_at ?? row.created_at;
      if (rank >= budget || age < cutoff) candidates.add(row.id);
    });

    const nonCandidates = rows.map((row) => row.id).filter((id) => !candidates.has(id));
    const kept = closure(nonCandidates, edges);
    const deletable = [...candidates].filter((id) => !kept.has(id));
    const deletableSet = new Set(deletable);
    assertNoLiveEdgeToDeleted(edges, deletableSet);

    const protectedIds = closure(active, edges);
    let events = 0;
    for (const row of terminal) {
      if (protectedIds.has(row.id) || deletableSet.has(row.id)) continue;
      events += trimEvents(database, row.id, policy.maxEventsPerTask);
    }

    for (const id of deletable) {
      events += database.run("DELETE FROM events WHERE task_id = ?", [id]).changes;
      // Edges go first, so ON DELETE RESTRICT on depends_on_id only guards against bugs.
      database.run("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?", [id, id]);
      database.run("DELETE FROM tasks WHERE id = ?", [id]);
    }
    return { tasks: deletable.length, events };
  });
}

/** Every id reachable from `seeds` by following `task -> dependency` edges, seeds included. */
function closure(seeds: readonly string[], edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    for (const dependency of edges.get(id) ?? []) stack.push(dependency);
  }
  return seen;
}

function assertNoLiveEdgeToDeleted(edges: ReadonlyMap<string, readonly string[]>, deletable: ReadonlySet<string>): void {
  for (const [task, dependencies] of edges) {
    if (deletable.has(task)) continue;
    for (const dependency of dependencies) {
      if (deletable.has(dependency)) {
        throw storageError("INTERNAL", `Refusing to prune ${dependency}: task ${task} still depends on it`);
      }
    }
  }
}

function trimEvents(database: Database, taskId: string, keep: number): number {
  return database.run(
    `DELETE FROM events WHERE task_id = ? AND seq NOT IN
       (SELECT seq FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?)`,
    [taskId, taskId, keep],
  ).changes;
}
