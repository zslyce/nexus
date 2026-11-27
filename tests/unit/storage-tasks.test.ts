import { after, describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { NexusError, type ErrorCode } from "../../src/contracts/common.ts";
import type { Task, TaskStatus } from "../../src/contracts/tasks.ts";
import { openStore, type SqliteStore } from "../../src/storage/sqlite-store.ts";
import { insertInStatus, makeAgent, makeTask, tempWorkspace } from "./storage-fixtures.ts";

const workspace = tempWorkspace();
after(workspace.cleanup);

let counter = 0;
function freshStore(t: TestContext): SqliteStore {
  counter += 1;
  const store = openStore(join(workspace.dir, `tasks-${counter}`, "nexus.db"));
  t.after(() => store.close());
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

function patch(value: unknown): Partial<Task> {
  return value as Partial<Task>;
}

const ACTIVE: TaskStatus[] = ["pending", "queued", "starting", "running", "waiting", "cancelling"];

describe("insert and read", () => {
  test("round-trips every field, including optional ones and the dependency order", (t) => {
    const store = freshStore(t);
    insertInStatus(store, makeTask({ id: "tsk_a", status: "completed", stage: "finalization", finishedAt: 1_500 }));
    insertInStatus(store, makeTask({ id: "tsk_b", status: "completed", stage: "finalization", finishedAt: 1_600 }));
    const full = makeTask({
      id: "tsk_c",
      batchId: "bat_1",
      context: "Some context",
      files: ["src/a.ts", "src/b.ts"],
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "high" },
      status: "queued",
      activity: "waiting for a slot",
      dependsOn: ["tsk_b", "tsk_a"],
      queuedAt: 2_000,
      notBefore: 3_000,
      lastEventAt: 2_500,
      lastEventSeq: 7,
      error: { code: "OPENCODE_UNAVAILABLE", message: "service down", transient: true, status: 503 },
      usage: {
        tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
        reportedCost: 0.25,
      },
    });
    store.insertTask(full, makeAgent("developer"));

    assert.deepEqual(store.getTask("tsk_c"), full);
    assert.deepEqual(store.getTask("tsk_c")?.dependsOn, ["tsk_b", "tsk_a"]);
    assert.equal(store.getTask("tsk_missing"), undefined);
  });

  test("a duplicate task id is rejected", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_dup" }));
    assertCode(() => store.insertTask(makeTask({ id: "tsk_dup", idempotencyKey: "other" })), "DUPLICATE_TASK");
  });

  test("a new task must start as pending or queued", (t) => {
    const store = freshStore(t);
    assertCode(() => store.insertTask(makeTask({ status: "running" })), "VALIDATION", /pending or queued/);
  });

  test("dependencies must already exist, may not repeat and may not point at the task itself", (t) => {
    const store = freshStore(t);
    assertCode(
      () => store.insertTask(makeTask({ id: "tsk_x", dependsOn: ["tsk_missing"] })),
      "NOT_FOUND",
      /tsk_missing/,
    );
    store.insertTask(makeTask({ id: "tsk_y" }));
    assertCode(() => store.insertTask(makeTask({ id: "tsk_z", dependsOn: ["tsk_y", "tsk_y"] })), "VALIDATION");
    assertCode(() => store.insertTask(makeTask({ id: "tsk_self", dependsOn: ["tsk_self"] })), "DEPENDENCY_CYCLE");
    assert.equal(store.getTask("tsk_x"), undefined);
    assert.equal(store.getTask("tsk_z"), undefined);
  });

  test("a session id belongs to one task only", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1", sessionId: "ses_shared" }));
    assertCode(() => store.insertTask(makeTask({ id: "tsk_2", sessionId: "ses_shared" })), "INTERNAL", /ses_shared/);
    assert.equal(store.findBySessionId("ses_shared")?.id, "tsk_1");
    assert.equal(store.findBySessionId("ses_unknown"), undefined);
  });

  test("a task inserted without an agent has no snapshot", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_no_snapshot" }));
    assert.equal(store.getAgentSnapshot("tsk_no_snapshot"), undefined);
  });
});

describe("idempotency keys", () => {
  test("only one active task per key; a finished one no longer blocks a new delegation", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1", idempotencyKey: "same" }));
    assertCode(() => store.insertTask(makeTask({ id: "tsk_2", idempotencyKey: "same" })), "DUPLICATE_TASK", /tsk_1/);

    store.updateTask("tsk_1", { status: "queued" });
    store.updateTask("tsk_1", { status: "starting" });
    store.updateTask("tsk_1", { status: "running", stage: "execution" });
    store.updateTask("tsk_1", { status: "completed", stage: "finalization", finishedAt: 9_000 });
    store.insertTask(makeTask({ id: "tsk_2", idempotencyKey: "same" }));

    assert.equal(store.findByIdempotencyKey("same", ACTIVE)?.id, "tsk_2");
    assert.equal(store.findByIdempotencyKey("same", ["completed"])?.id, "tsk_1");
    assert.equal(store.findByIdempotencyKey("same", []), undefined);
    assert.equal(store.findByIdempotencyKey("other", ACTIVE), undefined);
  });

  test("an idempotency key cannot be changed by an update, so no update can join two active tasks", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1", idempotencyKey: "k" }));
    store.insertTask(makeTask({ id: "tsk_2", idempotencyKey: "other" }));
    assertCode(() => store.updateTask("tsk_2", { idempotencyKey: "k" }), "VALIDATION", /idempotencyKey/);
    assert.equal(store.getTask("tsk_2")?.idempotencyKey, "other");
  });
});

describe("listing", () => {
  test("lists oldest first and filters by status, batch and limit", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_c", createdAt: 3_000, batchId: "bat_1" }));
    store.insertTask(makeTask({ id: "tsk_a", createdAt: 1_000, batchId: "bat_1" }));
    store.insertTask(makeTask({ id: "tsk_b", createdAt: 2_000, status: "queued" }));

    assert.deepEqual(
      store.listTasks().map((task) => task.id),
      ["tsk_a", "tsk_b", "tsk_c"],
    );
    assert.deepEqual(
      store.listTasks({ statuses: ["queued"] }).map((task) => task.id),
      ["tsk_b"],
    );
    assert.deepEqual(
      store.listTasks({ batchId: "bat_1" }).map((task) => task.id),
      ["tsk_a", "tsk_c"],
    );
    assert.deepEqual(
      store.listTasks({ limit: 2 }).map((task) => task.id),
      ["tsk_a", "tsk_b"],
    );
    assert.deepEqual(store.listTasks({ statuses: [] }), []);
    assertCode(() => store.listTasks({ limit: 0 }), "VALIDATION");
    assertCode(() => store.listTasks({ statuses: ["bogus" as TaskStatus] }), "VALIDATION");
  });
});

describe("updates", () => {
  test("merges the patch, clears fields set to undefined and returns the stored task", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1", status: "queued", notBefore: 5_000 }));
    const updated = store.updateTask("tsk_1", { status: "starting", startedAt: 6_000, notBefore: undefined });

    assert.equal(updated.status, "starting");
    assert.equal(updated.startedAt, 6_000);
    assert.equal("notBefore" in updated, false);
    assert.deepEqual(store.getTask("tsk_1"), updated);
  });

  test("unknown fields, id changes and missing tasks are rejected", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1" }));
    assertCode(() => store.updateTask("tsk_1", patch({ bogusField: 1 })), "VALIDATION", /bogusField/);
    assertCode(() => store.updateTask("tsk_1", { id: "tsk_other" }), "VALIDATION");
    assertCode(() => store.updateTask("tsk_none", {}), "NOT_FOUND");
  });

  test("required fields cannot be cleared", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1" }));
    assertCode(() => store.updateTask("tsk_1", patch({ title: undefined })), "VALIDATION", /title/);
    assertCode(() => store.updateTask("tsk_1", patch({ status: "bogus" })), "VALIDATION", /bogus/);
  });

  test("status moves follow the state machine; terminal states are final", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1" }));
    store.updateTask("tsk_1", { status: "queued" });
    assertCode(() => store.updateTask("tsk_1", { status: "completed" }), "INTERNAL", /queued -> completed/);
    store.updateTask("tsk_1", { status: "starting" });
    store.updateTask("tsk_1", { status: "running", stage: "execution" });
    store.updateTask("tsk_1", { status: "cancelling" });
    store.updateTask("tsk_1", { status: "cancelled", finishedAt: 4_000 });
    assertCode(() => store.updateTask("tsk_1", { status: "running" }), "INTERNAL", /cancelled -> running/);
    assert.equal(store.getTask("tsk_1")?.status, "cancelled");
  });

  test("a pending task can be cancelled directly", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1" }));
    assert.equal(store.updateTask("tsk_1", { status: "cancelled" }).status, "cancelled");
  });

  test("the stage never moves back within an attempt, but a new attempt may restart", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1", status: "queued" }));
    store.updateTask("tsk_1", { status: "starting" });
    store.updateTask("tsk_1", { status: "running", stage: "execution" });
    assertCode(() => store.updateTask("tsk_1", { stage: "analysis" }), "INTERNAL", /moves back/);
    assert.equal(store.updateTask("tsk_1", { stage: "validation" }).stage, "validation");

    const retried = store.updateTask("tsk_1", {
      attempt: 2,
      status: "queued",
      stage: "initialization",
      sessionId: "ses_retry",
      promptMessageId: "msg_retry",
    });
    assert.equal(retried.stage, "initialization");
    assert.equal(retried.attempt, 2);
  });

  test("the attempt number never decreases", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1", attempt: 1 }));
    assertCode(() => store.updateTask("tsk_1", { attempt: 0 }), "INTERNAL", /cannot decrease/);
  });

  test("a session id may not move to another task", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1", sessionId: "ses_1" }));
    store.insertTask(makeTask({ id: "tsk_2", sessionId: "ses_2" }));
    assertCode(() => store.updateTask("tsk_2", { sessionId: "ses_1" }), "INTERNAL", /ses_1/);
  });

  test("a failing update leaves the stored task exactly as it was", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1", status: "queued" }));
    store.updateTask("tsk_1", { status: "starting" });
    store.updateTask("tsk_1", { status: "running", stage: "execution" });
    const before = store.getTask("tsk_1");
    assertCode(() => store.updateTask("tsk_1", { status: "completed", dependsOn: ["tsk_missing"] }), "NOT_FOUND");
    assert.deepEqual(store.getTask("tsk_1"), before);
  });
});

describe("attempts", () => {
  test("keeps one record per attempt, with the session and prompt each one used", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_1", sessionId: "ses_1", promptMessageId: "msg_1" }));
    store.updateTask("tsk_1", {
      attempt: 2,
      status: "queued",
      sessionId: "ses_2",
      promptMessageId: "msg_2",
    });
    const attempts = store.listAttempts("tsk_1");
    assert.deepEqual(
      attempts.map((attempt) => [attempt.attempt, attempt.sessionId, attempt.promptMessageId]),
      [
        [1, "ses_1", "msg_1"],
        [2, "ses_2", "msg_2"],
      ],
    );
  });
});

describe("dependency updates", () => {
  test("changing dependencies checks existence and cycles, then replaces the edges", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_a" }));
    store.insertTask(makeTask({ id: "tsk_b", dependsOn: ["tsk_a"] }));
    store.insertTask(makeTask({ id: "tsk_c", dependsOn: ["tsk_b"] }));

    assertCode(() => store.updateTask("tsk_a", { dependsOn: ["tsk_c"] }), "DEPENDENCY_CYCLE");
    assertCode(() => store.updateTask("tsk_a", { dependsOn: ["tsk_missing"] }), "NOT_FOUND");
    assert.deepEqual(store.getTask("tsk_a")?.dependsOn, []);

    assert.deepEqual(store.updateTask("tsk_c", { dependsOn: [] }).dependsOn, []);
    assert.deepEqual(store.updateTask("tsk_a", { dependsOn: ["tsk_c"] }).dependsOn, ["tsk_c"]);
    assert.deepEqual(store.getTask("tsk_c")?.dependsOn, []);
  });
});

describe("retries (ADR-012)", () => {
  test("a retry from running needs the next attempt and a new session", (t) => {
    const store = freshStore(t);
    insertInStatus(store, makeTask({ id: "tsk_run", status: "running", stage: "execution" }));

    assertCode(() => store.updateTask("tsk_run", { status: "queued" }), "INTERNAL", /needs attempt 2 and a new session/);
    assertCode(
      () => store.updateTask("tsk_run", { status: "queued", attempt: 2 }),
      "INTERNAL",
      /needs attempt 2 and a new session/,
    );
    assertCode(
      () => store.updateTask("tsk_run", { status: "queued", attempt: 3, sessionId: "ses_nexus_tsk_run_3" }),
      "INTERNAL",
      /needs attempt 2/,
    );
    assert.equal(store.getTask("tsk_run")?.status, "running");

    const retried = store.updateTask("tsk_run", {
      status: "queued",
      attempt: 2,
      sessionId: "ses_retry_2",
      promptMessageId: "msg_retry_2",
    });
    assert.equal(retried.status, "queued");
    assert.equal(retried.attempt, 2);
  });

  test("a retry from waiting follows the same rule", (t) => {
    const store = freshStore(t);
    insertInStatus(store, makeTask({ id: "tsk_wait", status: "waiting", stage: "execution" }));
    assertCode(() => store.updateTask("tsk_wait", { status: "queued" }), "INTERNAL", /needs attempt 2/);
    assert.equal(
      store.updateTask("tsk_wait", { status: "queued", attempt: 2, sessionId: "ses_wait_2" }).status,
      "queued",
    );
  });

  test("starting may return to queued with the same IDs (ADR-012a)", (t) => {
    const store = freshStore(t);
    insertInStatus(store, makeTask({ id: "tsk_start", status: "starting" }));
    const before = store.getTask("tsk_start");
    const requeued = store.updateTask("tsk_start", { status: "queued" });
    assert.equal(requeued.status, "queued");
    assert.equal(requeued.attempt, before?.attempt);
    assert.equal(requeued.sessionId, before?.sessionId);
    assert.equal(requeued.promptMessageId, before?.promptMessageId);
  });

  test("the failure paths documented in docs/03 are allowed", (t) => {
    const store = freshStore(t);
    insertInStatus(store, makeTask({ id: "tsk_q", status: "queued" }));
    assert.equal(store.updateTask("tsk_q", { status: "failed", finishedAt: 2_000 }).status, "failed");

    insertInStatus(store, makeTask({ id: "tsk_s", status: "starting" }));
    assert.equal(store.updateTask("tsk_s", { status: "failed", finishedAt: 2_000 }).status, "failed");

    insertInStatus(store, makeTask({ id: "tsk_c1", status: "cancelling" }));
    assert.equal(store.updateTask("tsk_c1", { status: "completed", finishedAt: 2_000 }).status, "completed");

    insertInStatus(store, makeTask({ id: "tsk_c2", status: "cancelling" }));
    assert.equal(store.updateTask("tsk_c2", { status: "failed", finishedAt: 2_000 }).status, "failed");
  });
});

describe("identity and terminal rules", () => {
  test("id, agent, prompt, idempotencyKey and createdAt cannot change; repeating the value is fine", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_id", agent: "explorer", prompt: "P", idempotencyKey: "K", createdAt: 7 }));
    assertCode(() => store.updateTask("tsk_id", { agent: "developer" }), "VALIDATION", /agent/);
    assertCode(() => store.updateTask("tsk_id", { prompt: "other" }), "VALIDATION", /prompt/);
    assertCode(() => store.updateTask("tsk_id", { idempotencyKey: "other" }), "VALIDATION", /idempotencyKey/);
    assertCode(() => store.updateTask("tsk_id", { createdAt: 8 }), "VALIDATION", /createdAt/);
    assertCode(() => store.updateTask("tsk_id", patch({ prompt: undefined })), "VALIDATION", /prompt/);
    assert.equal(store.updateTask("tsk_id", { prompt: "P", agent: "explorer", createdAt: 7 }).prompt, "P");
  });

  test("promptMessageId changes only together with a higher attempt", (t) => {
    const store = freshStore(t);
    store.insertTask(makeTask({ id: "tsk_pm", promptMessageId: "msg_1" }));
    assertCode(() => store.updateTask("tsk_pm", { promptMessageId: "msg_2" }), "INTERNAL", /higher attempt/);
    assert.equal(store.getTask("tsk_pm")?.promptMessageId, "msg_1");
    assert.equal(store.updateTask("tsk_pm", { promptMessageId: "msg_2", attempt: 2 }).promptMessageId, "msg_2");
  });

  test("a terminal task keeps its attempt, session and prompt; bookkeeping may still change", (t) => {
    const store = freshStore(t);
    insertInStatus(store, makeTask({ id: "tsk_fin", status: "completed", stage: "finalization", finishedAt: 5_000 }));
    assertCode(() => store.updateTask("tsk_fin", { attempt: 2 }), "INTERNAL", /final/);
    assertCode(() => store.updateTask("tsk_fin", { sessionId: "ses_other" }), "INTERNAL", /final/);
    assertCode(
      () => store.updateTask("tsk_fin", { promptMessageId: "msg_other", attempt: 2 }),
      "INTERNAL",
      /final/,
    );
    assert.equal(store.getTask("tsk_fin")?.attempt, 1);

    const usage = {
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      reportedCost: 0,
    };
    const updated = store.updateTask("tsk_fin", { usage, finishedAt: 6_000 });
    assert.deepEqual(updated.usage, usage);
    assert.equal(updated.finishedAt, 6_000);
  });
});
