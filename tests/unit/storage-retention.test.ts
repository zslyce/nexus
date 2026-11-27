import { after, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { NexusError } from "../../src/contracts/common.ts";
import type { RetentionPolicy } from "../../src/contracts/store.ts";
import type { TaskStatus } from "../../src/contracts/tasks.ts";
import { openDatabase, type Database } from "../../src/storage/database.ts";
import { openStore, SqliteStore } from "../../src/storage/sqlite-store.ts";
import { DAY, insertInStatus, makeDraft, makeResult, makeTask, tempWorkspace } from "./storage-fixtures.ts";

const workspace = tempWorkspace();
after(workspace.cleanup);

const NOW = 100 * DAY;
const GENEROUS: RetentionPolicy = { maxTasks: 10_000, maxAgeDays: 10_000, maxEventsPerTask: 10_000 };

let counter = 0;
function freshStore(t: TestContext): { store: SqliteStore; path: string } {
  counter += 1;
  const path = join(workspace.dir, `retention-${counter}`, "nexus.db");
  const store = openStore(path);
  t.after(() => store.close());
  return { store, path };
}

function seed(
  store: SqliteStore,
  id: string,
  options: { status?: TaskStatus; createdAt: number; finishedAt?: number; dependsOn?: string[]; events?: number },
): void {
  const { status = "completed", createdAt, finishedAt, dependsOn = [], events = 0 } = options;
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  insertInStatus(
    store,
    makeTask({ id, createdAt, dependsOn, status, ...(terminal ? { finishedAt: finishedAt ?? createdAt } : {}) }),
  );
  for (let index = 0; index < events; index += 1) {
    store.appendEvent(makeDraft(id, `${id}-evt-${index}`));
  }
}

function ids(store: SqliteStore): string[] {
  return store.listTasks().map((task) => task.id);
}

function expectNexusError(fn: () => unknown, code: string, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
    assert.equal(error.info.code, code);
    assert.match(error.info.message, pattern);
    return true;
  });
}

describe("prune by age", () => {
  test("removes old terminal tasks with their events and results, and keeps recent ones", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_old", { createdAt: 0, finishedAt: 10 * DAY, events: 3 });
    store.saveResult(makeResult("tsk_old"));
    seed(store, "tsk_recent", { createdAt: 80 * DAY, events: 2 });

    const outcome = store.prune({ maxTasks: 100, maxAgeDays: 30, maxEventsPerTask: 100 }, NOW);

    assert.deepEqual(outcome, { tasks: 1, events: 3 });
    assert.equal(store.getTask("tsk_old"), undefined);
    assert.equal(store.getResult("tsk_old"), undefined);
    assert.equal(store.listEvents({ taskId: "tsk_old" }).length, 0);
    assert.deepEqual(ids(store), ["tsk_recent"]);
    assert.equal(store.listEvents({ taskId: "tsk_recent" }).length, 2);
  });

  test("the age of a terminal task counts from when it finished, not when it was created", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_long_running", { createdAt: 0, finishedAt: 95 * DAY });
    const outcome = store.prune({ maxTasks: 100, maxAgeDays: 30, maxEventsPerTask: 100 }, NOW);
    assert.deepEqual(outcome, { tasks: 0, events: 0 });
    assert.deepEqual(ids(store), ["tsk_long_running"]);
  });
});

describe("active work is never touched", () => {
  test("pending, queued, starting, running, waiting and cancelling tasks survive zero limits", (t) => {
    const { store } = freshStore(t);
    const statuses: TaskStatus[] = ["pending", "queued", "starting", "running", "waiting", "cancelling"];
    for (const status of statuses) {
      seed(store, `tsk_${status}`, { status, createdAt: 0, events: 2 });
    }

    const outcome = store.prune({ maxTasks: 0, maxAgeDays: 0, maxEventsPerTask: 0 }, NOW);

    assert.deepEqual(outcome, { tasks: 0, events: 0 });
    assert.equal(store.listTasks().length, statuses.length);
    for (const status of statuses) {
      assert.equal(store.listEvents({ taskId: `tsk_${status}` }).length, 2, `events of ${status} task`);
    }
  });

  test("the dependencies of active tasks survive, transitively, even when old and over the limits", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_grandparent", { createdAt: 0, finishedAt: 1 * DAY, events: 4 });
    seed(store, "tsk_parent", { createdAt: 0, finishedAt: 1 * DAY, dependsOn: ["tsk_grandparent"], events: 4 });
    seed(store, "tsk_child", { status: "running", createdAt: 0, dependsOn: ["tsk_parent"] });
    seed(store, "tsk_unrelated", { createdAt: 0, finishedAt: 1 * DAY, events: 4 });

    const outcome = store.prune({ maxTasks: 0, maxAgeDays: 1, maxEventsPerTask: 0 }, NOW);

    assert.deepEqual(outcome, { tasks: 1, events: 4 });
    assert.deepEqual(ids(store), ["tsk_grandparent", "tsk_parent", "tsk_child"]);
    assert.deepEqual(store.getTask("tsk_child")?.dependsOn, ["tsk_parent"]);
    assert.deepEqual(store.getTask("tsk_parent")?.dependsOn, ["tsk_grandparent"]);
    assert.equal(store.listEvents({ taskId: "tsk_grandparent" }).length, 4);
    assert.equal(store.listEvents({ taskId: "tsk_parent" }).length, 4);
  });

  test("an old dependency of a recent task survives the age limit", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_old_dependency", { createdAt: 0, finishedAt: 1 * DAY });
    seed(store, "tsk_recent", { createdAt: 99 * DAY, dependsOn: ["tsk_old_dependency"] });

    const outcome = store.prune({ maxTasks: 100, maxAgeDays: 30, maxEventsPerTask: 100 }, NOW);

    assert.deepEqual(outcome, { tasks: 0, events: 0 });
    assert.deepEqual(ids(store), ["tsk_old_dependency", "tsk_recent"]);
    assert.deepEqual(store.getTask("tsk_recent")?.dependsOn, ["tsk_old_dependency"]);
  });

  test("candidates that depend on each other are removed together, edges included", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_base", { createdAt: 0, finishedAt: 1 * DAY });
    seed(store, "tsk_top", { createdAt: 0, finishedAt: 1 * DAY, dependsOn: ["tsk_base"] });

    const outcome = store.prune({ maxTasks: 100, maxAgeDays: 30, maxEventsPerTask: 100 }, NOW);

    assert.deepEqual(outcome, { tasks: 2, events: 0 });
    assert.deepEqual(ids(store), []);
  });
});

describe("the task budget and event trimming", () => {
  test("maxTasks keeps the newest terminal tasks and counts active tasks against the budget", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_1", { createdAt: 1 * DAY });
    seed(store, "tsk_2", { createdAt: 2 * DAY });
    seed(store, "tsk_3", { createdAt: 3 * DAY });
    seed(store, "tsk_4", { createdAt: 4 * DAY });
    seed(store, "tsk_live", { status: "running", createdAt: 0 });

    const outcome = store.prune({ maxTasks: 3, maxAgeDays: 10_000, maxEventsPerTask: 100 }, NOW);

    assert.deepEqual(outcome, { tasks: 2, events: 0 });
    assert.deepEqual(ids(store), ["tsk_live", "tsk_3", "tsk_4"]);
  });

  test("finished tasks keep only their newest events; active tasks keep all of theirs", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_done", { createdAt: 0, events: 10 });
    seed(store, "tsk_live", { status: "running", createdAt: 0, events: 10 });

    const outcome = store.prune({ maxTasks: 100, maxAgeDays: 10_000, maxEventsPerTask: 3 }, NOW);

    assert.deepEqual(outcome, { tasks: 0, events: 7 });
    assert.deepEqual(
      store.listEvents({ taskId: "tsk_done" }).map((event) => event.seq),
      [8, 9, 10],
    );
    assert.equal(store.listEvents({ taskId: "tsk_live" }).length, 10);
  });
});

describe("sequence numbers and space", () => {
  test("seq is never reused after the newest events are pruned", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_recent", { createdAt: 99 * DAY, events: 2 });
    seed(store, "tsk_old", { createdAt: 0, finishedAt: 1 * DAY, events: 2 });
    assert.deepEqual(
      store.listEvents({ taskId: "tsk_old" }).map((event) => event.seq),
      [3, 4],
    );

    store.prune({ maxTasks: 100, maxAgeDays: 30, maxEventsPerTask: 100 }, NOW);
    const next = store.appendEvent(makeDraft("tsk_recent", "after-prune"));

    assert.equal(next?.seq, 5);
  });

  test("a second prune with the same policy changes nothing", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_old", { createdAt: 0, finishedAt: 1 * DAY, events: 2 });
    const policy = { maxTasks: 100, maxAgeDays: 30, maxEventsPerTask: 100 };
    assert.deepEqual(store.prune(policy, NOW), { tasks: 1, events: 2 });
    assert.deepEqual(store.prune(policy, NOW), { tasks: 0, events: 0 });
  });

  test("prune can run inside a caller's transaction", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_old", { createdAt: 0, finishedAt: 1 * DAY });
    const outcome = store.transaction(() => store.prune({ maxTasks: 0, maxAgeDays: 1, maxEventsPerTask: 0 }, NOW));
    assert.deepEqual(outcome, { tasks: 1, events: 0 });
    assert.deepEqual(ids(store), []);
  });

  test("free pages are returned to the file after a large prune", (t) => {
    const { store, path } = freshStore(t);
    const payload = { blob: "x".repeat(4_000) };
    seed(store, "tsk_big", { createdAt: 0, finishedAt: 1 * DAY });
    for (let index = 0; index < 300; index += 1) {
      store.appendEvent(makeDraft("tsk_big", `big-${index}`, { payload }));
    }
    const reader: Database = openDatabase(path);
    t.after(() => reader.close());
    assert.equal(
      Number(reader.get<{ freelist_count: number }>("PRAGMA freelist_count")?.freelist_count),
      0,
    );

    store.prune({ maxTasks: 0, maxAgeDays: 1, maxEventsPerTask: 0 }, NOW);

    assert.equal(
      Number(reader.get<{ freelist_count: number }>("PRAGMA freelist_count")?.freelist_count),
      0,
    );
    assert.deepEqual(ids(store), []);
  });
});

describe("policy validation", () => {
  test("invalid policies and timestamps are rejected before anything is deleted", (t) => {
    const { store } = freshStore(t);
    seed(store, "tsk_old", { createdAt: 0, finishedAt: 1 * DAY });
    const bad: RetentionPolicy[] = [
      { maxTasks: -1, maxAgeDays: 30, maxEventsPerTask: 1 },
      { maxTasks: 1, maxAgeDays: Number.NaN, maxEventsPerTask: 1 },
      { maxTasks: 1, maxAgeDays: 30, maxEventsPerTask: 1.5 },
    ];
    for (const policy of bad) {
      expectNexusError(() => store.prune(policy, NOW), "VALIDATION", /must be|finite|integer/);
    }
    expectNexusError(() => store.prune(GENEROUS, Number.POSITIVE_INFINITY), "VALIDATION", /finite/);
    assert.deepEqual(ids(store), ["tsk_old"]);
  });
});
