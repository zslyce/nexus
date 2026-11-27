import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EVENT_TYPES, STAGES, type RawOpenCodeEvent } from "../../src/contracts/index.ts";

const events = JSON.parse(
  readFileSync(new URL("../fixtures/opencode/events.two-sessions.json", import.meta.url), "utf8"),
) as RawOpenCodeEvent[];

function typesFor(index: number): string[] {
  const sessions = [...new Set(events.map((e) => e.data.sessionID).filter((id) => typeof id === "string"))];
  return events.filter((e) => e.data.sessionID === sessions[index]).map((e) => e.type);
}

test("the completed session reaches execution.succeeded", () => {
  assert.ok(typesFor(0).includes("session.execution.succeeded"));
});

test("the cancelled session ends in execution.interrupted", () => {
  assert.equal(typesFor(1).at(-1), "session.execution.interrupted");
});

test("tool.called carries no name: take it from tool.input.started", () => {
  const called = events.find((e) => e.type === "session.tool.called");
  const started = events.find((e) => e.type === "session.tool.input.started" && e.data.id === called?.data.id);
  assert.equal(called?.data.name, undefined);
  assert.equal(started?.data.name, "read");
});

test("contracts expose the 18 event types and the 5 stages", () => {
  assert.equal(EVENT_TYPES.length, 18);
  assert.equal(STAGES.length, 5);
});
