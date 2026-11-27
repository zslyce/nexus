import { after, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { NexusError, type ErrorCode } from "../../src/contracts/common.ts";
import type { NexusEventDraft } from "../../src/contracts/events.ts";
import { openStore, type SqliteStore } from "../../src/storage/sqlite-store.ts";
import { makeDraft, makeTask, tempWorkspace } from "./storage-fixtures.ts";

const workspace = tempWorkspace();
after(workspace.cleanup);

let counter = 0;
function freshStore(t: TestContext): SqliteStore {
  counter += 1;
  const store = openStore(join(workspace.dir, `events-${counter}`, "nexus.db"));
  t.after(() => store.close());
  store.insertTask(makeTask({ id: "tsk_a" }));
  store.insertTask(makeTask({ id: "tsk_b" }));
  return store;
}

function assertCode(fn: () => unknown, code: ErrorCode): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
    assert.equal(error.info.code, code, error.message);
    return true;
  });
}

describe("appendEvent", () => {
  test("stores the draft and returns it with an increasing seq", (t) => {
    const store = freshStore(t);
    const first = store.appendEvent(makeDraft("tsk_a", "evt-1", { event_type: "TASK_CREATED" }));
    const second = store.appendEvent(makeDraft("tsk_a", "evt-2", { event_type: "TASK_QUEUED" }));

    assert.equal(first?.seq, 1);
    assert.equal(second?.seq, 2);
    assert.deepEqual(first, { ...makeDraft("tsk_a", "evt-1", { event_type: "TASK_CREATED" }), seq: 1 });
    assert.deepEqual(store.listEvents({ taskId: "tsk_a" }), [first, second]);
  });

  test("a repeated event_id is ignored and returns undefined", (t) => {
    const store = freshStore(t);
    const draft = makeDraft("tsk_a", "evt-dup");
    assert.notEqual(store.appendEvent(draft), undefined);
    assert.equal(store.appendEvent(draft), undefined);
    assert.equal(store.listEvents({}).length, 1);
  });

  test("deduplication is by event_id across tasks", (t) => {
    const store = freshStore(t);
    store.appendEvent(makeDraft("tsk_a", "evt-shared"));
    assert.equal(store.appendEvent(makeDraft("tsk_b", "evt-shared")), undefined);
    assert.equal(store.listEvents({ taskId: "tsk_b" }).length, 0);
  });

  test("payloads round-trip as JSON", (t) => {
    const store = freshStore(t);
    const draft: NexusEventDraft = makeDraft("tsk_a", "evt-payload", {
      event_type: "FILE_MODIFIED",
      payload: { path: "src/a.ts", additions: 3, nested: { ok: true }, missing: null },
    });
    store.appendEvent(draft);
    assert.deepEqual(store.listEvents({})[0]?.payload, draft.payload);
  });

  test("an unknown event type is rejected", (t) => {
    const store = freshStore(t);
    assertCode(
      () => store.appendEvent(makeDraft("tsk_a", "evt-bad", { event_type: "NOT_AN_EVENT" as never })),
      "VALIDATION",
    );
  });

  test("an event for a task that does not exist is rejected", (t) => {
    const store = freshStore(t);
    assertCode(() => store.appendEvent(makeDraft("tsk_missing", "evt-orphan")), "NOT_FOUND");
    assert.equal(store.listEvents({}).length, 0);
  });
});

describe("listEvents", () => {
  test("returns ascending seq and filters by task, cursor and limit", (t) => {
    const store = freshStore(t);
    for (let index = 1; index <= 4; index += 1) store.appendEvent(makeDraft("tsk_a", `a-${index}`));
    store.appendEvent(makeDraft("tsk_b", "b-1"));

    assert.deepEqual(
      store.listEvents({ taskId: "tsk_a" }).map((event) => event.seq),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      store.listEvents({ afterSeq: 3 }).map((event) => event.event_id),
      ["a-4", "b-1"],
    );
    assert.deepEqual(
      store.listEvents({ taskId: "tsk_a", afterSeq: 1, limit: 2 }).map((event) => event.seq),
      [2, 3],
    );
  });

  test("invalid cursors and limits are rejected", (t) => {
    const store = freshStore(t);
    assertCode(() => store.listEvents({ afterSeq: -1 }), "VALIDATION");
    assertCode(() => store.listEvents({ limit: 0 }), "VALIDATION");
  });
});
