import { test } from "node:test";
import assert from "node:assert/strict";
import type { NexusEvent } from "../../src/contracts/events.ts";
import { createEventManager, type EventManager, type EventManagerOptions } from "../../src/events/index.ts";
import { MEMORY_DATABASE, openStore, type SqliteStore } from "../../src/storage/index.ts";
import { draft, makeTask, recordingLogger } from "./events-fixtures.ts";

const TASK = `tsk_${"1".repeat(20)}`;
const OTHER_TASK = `tsk_${"2".repeat(20)}`;
const SESSION = "ses_bus_test_session";

interface Harness {
  store: SqliteStore;
  manager: EventManager;
  /** Runs the deliveries that were scheduled so far (the manual scheduler replaces the microtask). */
  drain: () => void;
  warnings: string[];
  errors: string[];
  close: () => void;
}

function harness(options: Partial<EventManagerOptions> = {}): Harness {
  const store = openStore(MEMORY_DATABASE);
  store.insertTask(makeTask(TASK));
  store.insertTask(makeTask(OTHER_TASK));
  const scheduled: (() => void)[] = [];
  const logger = recordingLogger();
  const errors: string[] = [];
  const manager = createEventManager({
    store,
    schedule: (task) => {
      scheduled.push(task);
    },
    logger: { ...logger, error: (message) => void errors.push(message) },
    ...options,
  });
  const drain = (): void => {
    for (let task = scheduled.shift(); task !== undefined; task = scheduled.shift()) task();
  };
  return { store, manager, drain, warnings: logger.warnings, errors, close: () => store.close() };
}

function publishRange(h: Harness, from: number, to: number, taskId = TASK): void {
  for (let index = from; index <= to; index += 1) {
    h.manager.publish(draft(taskId, SESSION, `evt_${taskId.slice(-2)}_${index}`));
  }
}

async function take(iterator: AsyncIterator<NexusEvent>, count: number): Promise<NexusEvent[]> {
  const out: NexusEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = await iterator.next();
    assert.equal(result.done, false, `expected event ${index + 1} of ${count}`);
    out.push(result.value);
  }
  return out;
}

test("publish persists the event and ignores a repeated event_id", () => {
  const h = harness();
  try {
    const first = h.manager.publish(draft(TASK, SESSION, "evt_same"));
    assert.equal(first?.seq, 1);
    assert.equal(h.manager.publish(draft(TASK, SESSION, "evt_same")), undefined);
    assert.equal(h.store.listEvents({ taskId: TASK }).length, 1);
  } finally {
    h.close();
  }
});

test("publishAll is all or nothing: one invalid draft stores nothing", () => {
  const h = harness();
  try {
    const invalid = { ...draft(TASK, SESSION, "evt_bad"), event_type: "NOT_A_TYPE" as never };
    assert.throws(() => h.manager.publishAll([draft(TASK, SESSION, "evt_ok"), invalid]));
    assert.equal(h.store.listEvents({}).length, 0);
    h.drain();
  } finally {
    h.close();
  }
});

test("history after afterSeq is replayed in pages, then live events follow without gaps or duplicates", async () => {
  const h = harness({ pageSize: 2 });
  const controller = new AbortController();
  try {
    publishRange(h, 1, 5);
    const iterator = h.manager.subscribe({ afterSeq: 1 }, controller.signal)[Symbol.asyncIterator]();
    const history = await take(iterator, 4);
    assert.deepEqual(history.map((event) => event.seq), [2, 3, 4, 5]);

    publishRange(h, 6, 7);
    h.drain();
    const live = await take(iterator, 2);
    assert.deepEqual(live.map((event) => event.seq), [6, 7]);

    publishRange(h, 8, 8);
    h.drain();
    assert.deepEqual((await take(iterator, 1)).map((event) => event.seq), [8]);
  } finally {
    controller.abort();
    h.close();
  }
});

test("an event published while the consumer is replaying is delivered exactly once (replay to live race)", async () => {
  const h = harness({ pageSize: 1 });
  const controller = new AbortController();
  try {
    publishRange(h, 1, 3);
    const iterator = h.manager.subscribe({}, controller.signal)[Symbol.asyncIterator]();
    const seen: number[] = [];
    seen.push((await take(iterator, 1))[0]?.seq ?? -1);

    // Committed, and the replay reads it, before its delivery runs: the replay and the live queue both see 4.
    publishRange(h, 4, 4);
    for (const event of await take(iterator, 3)) seen.push(event.seq);
    h.drain();

    publishRange(h, 5, 5);
    h.drain();
    seen.push((await take(iterator, 1))[0]?.seq ?? -1);

    // The store is now exhausted and stale copies of 4 and 5 are queued: an idle read must wait, not repeat them.
    const idle = iterator.next();
    publishRange(h, 6, 6);
    h.drain();
    const next = await idle;
    assert.equal(next.done, false);
    seen.push(next.value.seq);

    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  } finally {
    controller.abort();
    h.close();
  }
});

test("a full live queue falls back to the store and loses nothing", async () => {
  const h = harness({ queueLimit: 2 });
  const controller = new AbortController();
  try {
    const iterator = h.manager.subscribe({}, controller.signal)[Symbol.asyncIterator]();
    const waiting = iterator.next();
    publishRange(h, 1, 5);
    h.drain();
    const first = await waiting;
    assert.equal(first.done, false);
    const rest = await take(iterator, 4);
    assert.deepEqual([first.value, ...rest].map((event) => event.seq), [1, 2, 3, 4, 5]);
  } finally {
    controller.abort();
    h.close();
  }
});

test("events from a rolled-back transaction are never delivered", async () => {
  const h = harness();
  const controller = new AbortController();
  try {
    const iterator = h.manager.subscribe({}, controller.signal)[Symbol.asyncIterator]();
    const waiting = iterator.next();
    assert.throws(() =>
      h.store.transaction(() => {
        h.manager.publish(draft(TASK, SESSION, "evt_rolled_back"));
        throw new Error("rollback");
      }),
    );
    h.drain();
    h.manager.publish(draft(TASK, SESSION, "evt_kept"));
    h.drain();
    const result = await waiting;
    assert.equal(result.done, false);
    assert.equal(result.value.event_id, "evt_kept");
    assert.equal(h.store.listEvents({}).length, 1);
  } finally {
    controller.abort();
    h.close();
  }
});

test("a failed delivery makes subscribers re-read the store instead of losing the event", async () => {
  const h = harness();
  const controller = new AbortController();
  try {
    const iterator = h.manager.subscribe({}, controller.signal)[Symbol.asyncIterator]();
    const waiting = iterator.next();

    const realList = h.store.listEvents.bind(h.store);
    let failNext = true;
    h.store.listEvents = (query) => {
      if (failNext) {
        failNext = false;
        throw new Error("transient read failure");
      }
      return realList(query);
    };
    h.manager.publish(draft(TASK, SESSION, "evt_recovered"));
    h.drain();

    assert.equal(h.errors.length, 1);
    const result = await waiting;
    assert.equal(result.done, false);
    assert.equal(result.value.event_id, "evt_recovered");
  } finally {
    controller.abort();
    h.close();
  }
});

test("aborting the signal while waiting ends the iteration and detaches the subscriber", async () => {
  const h = harness();
  const controller = new AbortController();
  try {
    const iterator = h.manager.subscribe({}, controller.signal)[Symbol.asyncIterator]();
    const waiting = iterator.next();
    assert.equal(h.manager.subscriberCount, 1);
    controller.abort();
    assert.deepEqual(await waiting, { done: true, value: undefined });
    assert.equal(h.manager.subscriberCount, 0);
  } finally {
    h.close();
  }
});

test("return() detaches the subscriber and ends the iteration", async () => {
  const h = harness();
  const controller = new AbortController();
  try {
    const iterator = h.manager.subscribe({}, controller.signal)[Symbol.asyncIterator]();
    const waiting = iterator.next();
    assert.equal(h.manager.subscriberCount, 1);
    await iterator.return?.();
    assert.deepEqual(await waiting, { done: true, value: undefined });
    assert.equal(h.manager.subscriberCount, 0);
    publishRange(h, 1, 1);
    h.drain();
  } finally {
    controller.abort();
    h.close();
  }
});

test("an already aborted signal never attaches the subscriber", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  try {
    const iterator = h.manager.subscribe({}, controller.signal)[Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    assert.equal(h.manager.subscriberCount, 0);
  } finally {
    h.close();
  }
});

test("a taskId subscription receives only that task's events", async () => {
  const h = harness();
  const controller = new AbortController();
  try {
    const iterator = h.manager.subscribe({ taskId: TASK }, controller.signal)[Symbol.asyncIterator]();
    const waiting = take(iterator, 2);
    publishRange(h, 1, 1, OTHER_TASK);
    publishRange(h, 1, 1, TASK);
    publishRange(h, 2, 2, OTHER_TASK);
    publishRange(h, 2, 2, TASK);
    h.drain();
    const events = await waiting;
    assert.deepEqual(
      events.map((event) => event.task_id),
      [TASK, TASK],
    );
    assert.deepEqual(events.map((event) => event.event_id), ["evt_11_1", "evt_11_2"]);
  } finally {
    controller.abort();
    h.close();
  }
});

test("a negative afterSeq is rejected", () => {
  const h = harness();
  const controller = new AbortController();
  try {
    assert.throws(() => h.manager.subscribe({ afterSeq: -1 }, controller.signal), /afterSeq/);
  } finally {
    h.close();
  }
});

test("a subscription can be iterated only once; a second iterator is rejected", () => {
  const h = harness();
  const controller = new AbortController();
  try {
    const subscribed = h.manager.subscribe({}, controller.signal);
    subscribed[Symbol.asyncIterator]();
    assert.throws(() => subscribed[Symbol.asyncIterator](), /only once/);
  } finally {
    controller.abort();
    h.close();
  }
});

test("concurrent next() calls are served in call order and none is left waiting forever", async () => {
  const h = harness();
  const controller = new AbortController();
  try {
    const iterator = h.manager.subscribe({}, controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();
    const third = iterator.next();
    publishRange(h, 1, 3);
    h.drain();
    const results = await Promise.all([first, second, third]);
    assert.deepEqual(
      results.map((result) => (result.done === false ? result.value.seq : -1)),
      [1, 2, 3],
    );
  } finally {
    controller.abort();
    h.close();
  }
});
