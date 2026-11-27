import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventType, NexusEventDraft } from "../../src/contracts/events.ts";
import type { RawOpenCodeEvent } from "../../src/contracts/gateway.ts";
import type { SessionBinding } from "../../src/contracts/normalizer.ts";
import { createEventManager, createEventNormalizer, sessionIdOf } from "../../src/events/index.ts";
import { MEMORY_DATABASE, openStore } from "../../src/storage/index.ts";
import {
  FIXED_CLOCK,
  SESSION_CANCELLED,
  SESSION_COMPLETED,
  VALIDATION_PATTERNS,
  WORKSPACE,
  loadFixture,
  makeTask,
  recordingLogger,
} from "./events-fixtures.ts";

/**
 * `events.two-sessions.json` holds 42 native events of two sessions recorded from OpenCode 2.4.2.
 * The completed session runs twice (the second run repeats `execution.started`/`succeeded`).
 */
const TASK_COMPLETED = `tsk_${"a".repeat(20)}`;
const TASK_CANCELLED = `tsk_${"b".repeat(20)}`;

const EXPECTED_COMPLETED: EventType[] = [
  "AGENT_STARTED",
  "AGENT_TOOL_STARTED",
  "AGENT_TOOL_COMPLETED",
  "FILE_READ",
  "AGENT_FINISHED",
  "AGENT_STARTED",
  "AGENT_FINISHED",
];

const EXPECTED_CANCELLED: EventType[] = ["AGENT_STARTED", "AGENT_THINKING", "AGENT_FINISHED"];

const BINDINGS: Record<string, SessionBinding> = {
  [SESSION_COMPLETED]: { taskId: TASK_COMPLETED, sessionId: SESSION_COMPLETED, agent: "nexus-probe" },
  [SESSION_CANCELLED]: { taskId: TASK_CANCELLED, sessionId: SESSION_CANCELLED, agent: "nexus-probe" },
};

/** Alternates the two sessions one event at a time, with unbound events mixed in. */
function interleave(events: RawOpenCodeEvent[]): RawOpenCodeEvent[] {
  const completed = events.filter((raw) => sessionIdOf(raw) === SESSION_COMPLETED);
  const cancelled = events.filter((raw) => sessionIdOf(raw) === SESSION_CANCELLED);
  const unbound = events.filter((raw) => sessionIdOf(raw) === undefined);
  const out: RawOpenCodeEvent[] = [...unbound];
  const length = Math.max(completed.length, cancelled.length);
  for (let index = 0; index < length; index += 1) {
    const a = completed[index];
    const b = cancelled[index];
    if (a !== undefined) out.push(a);
    if (b !== undefined) out.push(b);
  }
  return out;
}

function newNormalizer() {
  return createEventNormalizer({
    workspace: WORKSPACE,
    validationCommandPatterns: VALIDATION_PATTERNS,
    clock: FIXED_CLOCK,
    logger: recordingLogger(),
  });
}

/** Normalizes every event, routing each to its session's binding. Unbound events yield nothing. */
function normalizeAll(events: RawOpenCodeEvent[]): NexusEventDraft[][] {
  const normalizer = newNormalizer();
  const batches: NexusEventDraft[][] = [];
  for (const raw of events) {
    const session = sessionIdOf(raw);
    const binding = session === undefined ? undefined : BINDINGS[session];
    if (binding === undefined) continue;
    batches.push(normalizer.normalize(raw, binding).events);
  }
  return batches;
}

function setup() {
  const store = openStore(MEMORY_DATABASE);
  store.insertTask(makeTask(TASK_COMPLETED, { sessionId: SESSION_COMPLETED }));
  store.insertTask(makeTask(TASK_CANCELLED, { sessionId: SESSION_CANCELLED }));
  const scheduled: (() => void)[] = [];
  const manager = createEventManager({ store, schedule: (task) => void scheduled.push(task) });
  return { store, manager, close: () => store.close() };
}

test("the fixture is the expected two-session recording", () => {
  const events = loadFixture();
  assert.equal(events.length, 42);
  assert.equal(new Set(events.map((raw) => raw.id)).size, 42, "native ids are unique");
  assert.deepEqual([...new Set(events.map(sessionIdOf).filter(Boolean))].sort(), [SESSION_CANCELLED, SESSION_COMPLETED].sort());
});

test("each session produces the expected sequence of Nexus events", () => {
  const events = interleave(loadFixture());
  const flat = normalizeAll(events).flat();
  const completed = flat.filter((event) => event.session_id === SESSION_COMPLETED).map((event) => event.event_type);
  const cancelled = flat.filter((event) => event.session_id === SESSION_CANCELLED).map((event) => event.event_type);
  assert.deepEqual(completed, EXPECTED_COMPLETED);
  assert.deepEqual(cancelled, EXPECTED_CANCELLED);
});

test("the two interleaved sessions never cross over", () => {
  const flat = normalizeAll(interleave(loadFixture())).flat();
  for (const event of flat) {
    const expected = BINDINGS[event.session_id];
    assert.ok(expected !== undefined, `unknown session ${event.session_id}`);
    assert.equal(event.task_id, expected.taskId);
    assert.equal(event.agent, expected.agent);
  }
});

test("persisted sequences per task match the expected ones, and each event id is unique", () => {
  const { store, manager, close } = setup();
  try {
    for (const batch of normalizeAll(interleave(loadFixture()))) manager.publishAll(batch);
    const completed = store.listEvents({ taskId: TASK_COMPLETED }).map((event) => event.event_type);
    const cancelled = store.listEvents({ taskId: TASK_CANCELLED }).map((event) => event.event_type);
    assert.deepEqual(completed, EXPECTED_COMPLETED);
    assert.deepEqual(cancelled, EXPECTED_CANCELLED);
    const all = store.listEvents({});
    assert.equal(new Set(all.map((event) => event.event_id)).size, all.length);
  } finally {
    close();
  }
});

test("reprocessing the same stream stores nothing new", () => {
  const { store, manager, close } = setup();
  try {
    const batches = normalizeAll(interleave(loadFixture()));
    for (const batch of batches) manager.publishAll(batch);
    const before = store.listEvents({}).length;
    const delivered = batches.map((batch) => manager.publishAll(batch).length);
    assert.equal(
      delivered.reduce((sum, count) => sum + count, 0),
      0,
      "a second pass returns no new events",
    );
    assert.equal(store.listEvents({}).length, before);
  } finally {
    close();
  }
});

test("a subscriber to one task sees only that session, in order", async () => {
  const { manager, close, store } = setup();
  const controller = new AbortController();
  try {
    for (const batch of normalizeAll(interleave(loadFixture()))) manager.publishAll(batch);
    const iterator = manager.subscribe({ taskId: TASK_CANCELLED }, controller.signal)[Symbol.asyncIterator]();
    const seen: string[] = [];
    for (let index = 0; index < EXPECTED_CANCELLED.length; index += 1) {
      const result = await iterator.next();
      assert.equal(result.done, false);
      seen.push(result.value.event_type);
    }
    assert.deepEqual(seen, EXPECTED_CANCELLED);
    assert.equal(store.listEvents({ taskId: TASK_CANCELLED }).length, EXPECTED_CANCELLED.length);
  } finally {
    controller.abort();
    close();
  }
});
