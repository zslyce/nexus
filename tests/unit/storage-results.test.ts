import { after, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { NexusError, type ErrorCode } from "../../src/contracts/common.ts";
import type { TaskResult } from "../../src/contracts/tasks.ts";
import { openStore, type SqliteStore } from "../../src/storage/sqlite-store.ts";
import { insertInStatus, makeResult, makeTask, tempWorkspace } from "./storage-fixtures.ts";

const workspace = tempWorkspace();
after(workspace.cleanup);

let counter = 0;
function freshStore(t: TestContext): SqliteStore {
  counter += 1;
  const store = openStore(join(workspace.dir, `results-${counter}`, "nexus.db"));
  t.after(() => store.close());
  insertInStatus(store, makeTask({ id: "tsk_done", status: "completed", stage: "finalization", finishedAt: 5_000 }));
  return store;
}

function assertCode(fn: () => unknown, code: ErrorCode, pattern?: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
    assert.equal(error.info.code, code, error.message);
    if (pattern !== undefined) assert.match(error.info.message, pattern);
    return true;
  });
}

describe("results", () => {
  test("round-trip with errors, timings, file changes and usage", (t) => {
    const store = freshStore(t);
    const result = makeResult("tsk_done");
    store.saveResult(result);
    assert.deepEqual(store.getResult("tsk_done"), result);
  });

  test("a result without usage or a model variant keeps those fields absent", (t) => {
    const store = freshStore(t);
    const bare: TaskResult = {
      taskId: "tsk_done",
      status: "completed",
      summary: "",
      output: "",
      filesModified: [],
      errors: [],
      durationMs: 0,
      model: { providerID: "opencode-go", id: "mimo-v2.6-flash" },
    };
    store.saveResult(bare);
    const stored = store.getResult("tsk_done");
    assert.deepEqual(stored, bare);
    assert.equal("usage" in (stored ?? {}), false);
  });

  test("saving again replaces the previous result for the task", (t) => {
    const store = freshStore(t);
    store.saveResult(makeResult("tsk_done"));
    store.saveResult({ ...makeResult("tsk_done"), summary: "Finalized again.", durationMs: 9_999 });
    assert.equal(store.getResult("tsk_done")?.summary, "Finalized again.");
    assert.equal(store.getResult("tsk_done")?.durationMs, 9_999);
  });

  test("only terminal statuses are accepted", (t) => {
    const store = freshStore(t);
    assertCode(() => store.saveResult({ ...makeResult("tsk_done"), status: "running" as never }), "VALIDATION");
  });

  test("a result for a task that does not exist is rejected", (t) => {
    const store = freshStore(t);
    assertCode(() => store.saveResult(makeResult("tsk_missing")), "NOT_FOUND");
    assert.equal(store.getResult("tsk_missing"), undefined);
  });

  test("a result whose status differs from the task's status is rejected and nothing is stored", (t) => {
    const store = freshStore(t);
    assertCode(() => store.saveResult(makeResult("tsk_done", "failed")), "INTERNAL", /reports failed but the task is completed/);
    assert.equal(store.getResult("tsk_done"), undefined);
  });

  test("a result saved before the task reaches its terminal status is rejected", (t) => {
    const store = freshStore(t);
    insertInStatus(store, makeTask({ id: "tsk_live", status: "running", stage: "execution" }));
    assertCode(() => store.saveResult(makeResult("tsk_live", "completed")), "INTERNAL", /but the task is running/);

    store.updateTask("tsk_live", { status: "completed", stage: "finalization", finishedAt: 7_000 });
    store.saveResult(makeResult("tsk_live", "completed"));
    assert.equal(store.getResult("tsk_live")?.status, "completed");
  });
});
