import { after, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { NexusError } from "../../src/contracts/common.ts";
import { openStore, type SqliteStore } from "../../src/storage/sqlite-store.ts";
import { makeDraft, makeTask, tempWorkspace } from "./storage-fixtures.ts";

const workspace = tempWorkspace();
after(workspace.cleanup);

let counter = 0;
function freshPath(): string {
  counter += 1;
  return join(workspace.dir, `tx-${counter}`, "nexus.db");
}

function freshStore(t: TestContext): SqliteStore {
  const store = openStore(freshPath());
  t.after(() => store.close());
  return store;
}

describe("transactions", () => {
  test("a callback that returns commits and passes its value through", (t) => {
    const store = freshStore(t);
    const value = store.transaction(() => {
      store.insertTask(makeTask({ id: "tsk_1" }));
      return 42;
    });
    assert.equal(value, 42);
    assert.ok(store.getTask("tsk_1"));
  });

  test("a callback that throws leaves no trace of its writes and rethrows the same error", (t) => {
    const store = freshStore(t);
    const failure = new Error("boom");
    assert.throws(
      () =>
        store.transaction(() => {
          store.insertTask(makeTask({ id: "tsk_1" }));
          store.appendEvent(makeDraft("tsk_1", "evt-1"));
          throw failure;
        }),
      failure,
    );
    assert.equal(store.getTask("tsk_1"), undefined);
    assert.equal(store.listEvents({}).length, 0);
  });

  test("an inner failure caught by the outer callback rolls back only the inner writes", (t) => {
    const store = freshStore(t);
    store.transaction(() => {
      store.insertTask(makeTask({ id: "tsk_outer" }));
      assert.throws(() =>
        store.transaction(() => {
          store.insertTask(makeTask({ id: "tsk_inner" }));
          throw new Error("inner failure");
        }),
      );
      store.insertTask(makeTask({ id: "tsk_after" }));
    });
    assert.ok(store.getTask("tsk_outer"));
    assert.equal(store.getTask("tsk_inner"), undefined);
    assert.ok(store.getTask("tsk_after"));
  });

  test("when the outer callback fails, the writes of nested calls are rolled back too", (t) => {
    const store = freshStore(t);
    assert.throws(() =>
      store.transaction(() => {
        store.transaction(() => store.insertTask(makeTask({ id: "tsk_nested" })));
        throw new Error("outer failure");
      }),
    );
    assert.equal(store.getTask("tsk_nested"), undefined);
  });

  test("a failed update inside a transaction restores the previous state", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1", status: "queued" }));
    assert.throws(() =>
      store.transaction(() => {
        store.updateTask("tsk_1", { status: "starting" });
        throw new Error("abort");
      }),
    );
    assert.equal(store.getTask("tsk_1")?.status, "queued");
  });

  test("an asynchronous callback is rejected and its synchronous writes are rolled back", (t) => {
    const store = freshStore(t);
    assert.throws(
      () =>
        store.transaction(() => {
          store.insertTask(makeTask({ id: "tsk_async" }));
          return Promise.resolve("too late");
        }),
      (error: unknown) => {
        assert.ok(error instanceof NexusError);
        assert.match(error.info.message, /synchronous/);
        return true;
      },
    );
    assert.equal(store.getTask("tsk_async"), undefined);
  });

  test("the store cannot be closed while a transaction is open", (t) => {
    const store = freshStore(t);
    store.transaction(() => {
      assert.throws(() => store.close(), (error: unknown) => error instanceof NexusError);
    });
    assert.equal(store.listTasks().length, 0);
  });

  test("uncommitted writes are invisible to another connection until commit", (t) => {
    const path = freshPath();
    const writer = openStore(path);
    const reader = openStore(path);
    t.after(() => {
      writer.close();
      reader.close();
    });

    writer.transaction(() => {
      writer.insertTask(makeTask({ id: "tsk_pending_commit" }));
      assert.equal(reader.getTask("tsk_pending_commit"), undefined);
    });
    assert.ok(reader.getTask("tsk_pending_commit"));
  });
});
