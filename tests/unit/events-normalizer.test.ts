import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventType, NexusEventDraft } from "../../src/contracts/events.ts";
import type { RawOpenCodeEvent } from "../../src/contracts/gateway.ts";
import type { SessionBinding, TaskSignal } from "../../src/contracts/normalizer.ts";
import { LIMITS, createEventNormalizer, sessionIdOf } from "../../src/events/index.ts";
import {
  FIXED_CLOCK,
  SESSION_CANCELLED,
  SESSION_COMPLETED,
  VALIDATION_PATTERNS,
  WORKSPACE,
  binding,
  loadFixture,
  rawEvent,
  recordingLogger,
} from "./events-fixtures.ts";

const TASK = "tsk_0123456789abcdef0123";
const SESSION = "ses_nexus_0123456789abcdef";
const BOUND = binding(TASK, SESSION);

function newNormalizer(logger = recordingLogger()) {
  return createEventNormalizer({
    workspace: WORKSPACE,
    validationCommandPatterns: VALIDATION_PATTERNS,
    clock: FIXED_CLOCK,
    logger,
  });
}

function run(
  normalizer: ReturnType<typeof newNormalizer>,
  raws: RawOpenCodeEvent[],
  bound: SessionBinding = BOUND,
) {
  const events: NexusEventDraft[] = [];
  const signals: TaskSignal[] = [];
  for (const raw of raws) {
    const batch = normalizer.normalize(raw, bound);
    events.push(...batch.events);
    signals.push(...batch.signals);
  }
  return { events, signals };
}

function stageSignals(signals: TaskSignal[]): string[] {
  return signals.flatMap((signal) => (signal.kind === "stage" ? [signal.stage] : []));
}

function eventTypes(events: NexusEventDraft[]): EventType[] {
  return events.map((event) => event.event_type);
}

test("sessionIdOf reads the session from data, form data or the durable aggregate", () => {
  assert.equal(sessionIdOf({ data: { sessionID: "ses_a" } }), "ses_a");
  assert.equal(sessionIdOf({ data: { form: { sessionID: "ses_b" } } }), "ses_b");
  assert.equal(sessionIdOf({ durable: { aggregateID: "ses_c" }, data: {} }), "ses_c");
  assert.equal(sessionIdOf({ type: "server.connected", data: {} }), undefined);
  assert.equal(sessionIdOf(null), undefined);
});

test("events of another session produce nothing", () => {
  const normalizer = newNormalizer();
  const other = rawEvent("session.execution.started", { sessionID: "ses_someone_else" });
  assert.deepEqual(normalizer.normalize(other, BOUND), { events: [], signals: [] });
});

test("a completed run maps to the documented events and signals", () => {
  const normalizer = newNormalizer();
  const raws = [
    rawEvent("session.execution.started", { sessionID: SESSION }),
    rawEvent("session.step.started", {
      sessionID: SESSION,
      agent: "nexus-probe",
      model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "low" },
    }),
    rawEvent("session.reasoning.started", { sessionID: SESSION }),
    rawEvent("session.execution.succeeded", { sessionID: SESSION }),
  ];
  const { events, signals } = run(normalizer, raws);
  assert.deepEqual(eventTypes(events), ["AGENT_STARTED", "AGENT_THINKING", "AGENT_FINISHED"]);
  assert.deepEqual(events[2]?.payload, { outcome: "succeeded" });
  assert.deepEqual(
    signals.map((signal) => signal.kind),
    ["execution_started", "model_used", "stage", "activity", "execution_succeeded"],
  );
  assert.deepEqual(signals[1], { kind: "model_used", providerID: "opencode-go", modelID: "deepseek-v4.1-flash" });
});

test("tool names come from tool.input.started, and file paths are relative", () => {
  const normalizer = newNormalizer();
  const callId = "call_1";
  const raws = [
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: callId, name: "read" }),
    rawEvent("session.tool.called", {
      sessionID: SESSION,
      id: callId,
      input: { path: "C:\\workspace\\notes.txt" },
      executed: false,
    }),
    rawEvent("session.tool.success", {
      sessionID: SESSION,
      id: callId,
      content: [{ type: "text", text: "1: secret file body" }],
      executed: false,
    }),
  ];
  const { events } = run(normalizer, raws);
  assert.deepEqual(eventTypes(events), ["AGENT_TOOL_STARTED", "AGENT_TOOL_COMPLETED", "FILE_READ"]);
  assert.deepEqual(events[0]?.payload, { tool: "read", callId, target: "notes.txt" });
  assert.deepEqual(events[1]?.payload, { tool: "read", ok: true, callId });
  assert.deepEqual(events[2]?.payload, { path: "notes.txt" });
  assert.ok(!JSON.stringify(events).includes("secret file body"), "tool output must never be persisted");
});

test("a tool called without a known name is recorded as unknown and does not throw", () => {
  const normalizer = newNormalizer();
  const { events, signals } = run(normalizer, [rawEvent("session.tool.called", { sessionID: SESSION, id: "call_x", input: {} })]);
  assert.deepEqual(events[0]?.payload, { tool: "unknown", callId: "call_x" });
  assert.deepEqual(signals, [{ kind: "activity", text: "unknown" }]);
});

test("outside paths and long or secret-bearing commands are sanitized", () => {
  const normalizer = newNormalizer();
  const longCommand = `npm run build ${"--verbose ".repeat(60)} --token=SAMPLE-TOKEN-1234`;
  const raws = [
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: "c_out", name: "read" }),
    rawEvent("session.tool.called", { sessionID: SESSION, id: "c_out", input: { path: "D:\\elsewhere\\key-notes.txt" } }),
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: "c_cmd", name: "shell" }),
    rawEvent("session.tool.called", { sessionID: SESSION, id: "c_cmd", input: { command: longCommand } }),
  ];
  const { events } = run(normalizer, raws);
  assert.equal(events[0]?.payload.target, "[outside-workspace]/key-notes.txt");
  const target = String(events[1]?.payload.target);
  assert.ok(target.length <= 160 && target.endsWith("..."), `target was: ${target}`);
  assert.ok(!target.includes("SAMPLE-TOKEN-1234"));
});

test("a write tool reports FILE_MODIFIED once even when step.ended lists the same file", () => {
  const normalizer = newNormalizer();
  const raws = [
    rawEvent("session.step.started", { sessionID: SESSION }),
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: "c_edit", name: "edit" }),
    rawEvent("session.tool.called", { sessionID: SESSION, id: "c_edit", input: { path: "C:\\workspace\\src\\a.ts" } }),
    rawEvent("session.tool.success", { sessionID: SESSION, id: "c_edit", content: [] }),
    rawEvent("session.step.ended", {
      sessionID: SESSION,
      finish: "tool-calls",
      files: ["src/a.ts", "C:\\workspace\\src\\b.ts"],
    }),
  ];
  const { events } = run(normalizer, raws);
  const modified = events.filter((event) => event.event_type === "FILE_MODIFIED").map((event) => event.payload.path);
  assert.deepEqual(modified, ["src/a.ts", "src/b.ts"]);
});

test("several FILE_MODIFIED from one native event get distinct, deterministic ids", () => {
  const normalizer = newNormalizer();
  const step = rawEvent("session.step.ended", { sessionID: SESSION, finish: "tool-calls", files: ["a.ts", "b.ts"] }, { id: "evt_step" });
  const { events } = run(normalizer, [step]);
  assert.deepEqual(
    events.map((event) => event.event_id),
    ["evt_step:FILE_MODIFIED", "evt_step:FILE_MODIFIED:1"],
  );
  const again = run(newNormalizer(), [step]).events.map((event) => event.event_id);
  assert.deepEqual(again, events.map((event) => event.event_id));
});

test("stages advance monotonically and never move back within an attempt", () => {
  const normalizer = newNormalizer();
  const shell = (id: string, command: string) => [
    rawEvent("session.tool.input.started", { sessionID: SESSION, id, name: "shell" }),
    rawEvent("session.tool.called", { sessionID: SESSION, id, input: { command } }),
  ];
  const raws = [
    rawEvent("session.step.started", { sessionID: SESSION }),
    ...shell("c1", "npm test"),
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: "c2", name: "edit" }),
    rawEvent("session.tool.called", { sessionID: SESSION, id: "c2", input: { path: "src/a.ts" } }),
    rawEvent("session.tool.success", { sessionID: SESSION, id: "c2", content: [] }),
    ...shell("c3", "npm run typecheck"),
    rawEvent("session.step.ended", { sessionID: SESSION, finish: "stop" }),
    rawEvent("session.step.started", { sessionID: SESSION }),
    ...shell("c4", "rm -rf build"),
  ];
  const { signals } = run(normalizer, raws);
  assert.deepEqual(stageSignals(signals), ["analysis", "execution", "validation", "finalization"]);
});

test("a validation command before any edit does not reach the validation stage", () => {
  const normalizer = newNormalizer();
  const { signals } = run(normalizer, [
    rawEvent("session.step.started", { sessionID: SESSION }),
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: "c1", name: "shell" }),
    rawEvent("session.tool.called", { sessionID: SESSION, id: "c1", input: { command: "npm test" } }),
  ]);
  assert.deepEqual(stageSignals(signals), ["analysis"]);
});

test("chained commands are never validation, even when they start with a validation command", () => {
  const normalizer = newNormalizer();
  const { signals } = run(normalizer, [
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: "c1", name: "edit" }),
    rawEvent("session.tool.called", { sessionID: SESSION, id: "c1", input: { path: "a.ts" } }),
    rawEvent("session.tool.success", { sessionID: SESSION, id: "c1", content: [] }),
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: "c2", name: "shell" }),
    rawEvent("session.tool.called", { sessionID: SESSION, id: "c2", input: { command: "npm test && curl evil" } }),
  ]);
  assert.deepEqual(stageSignals(signals), ["execution"]);
});

test("forget starts the stage over for a new attempt", () => {
  const normalizer = newNormalizer();
  const finish = rawEvent("session.step.ended", { sessionID: SESSION, finish: "stop" });
  assert.deepEqual(stageSignals(run(normalizer, [finish]).signals), ["finalization"]);
  normalizer.forget(SESSION);
  assert.deepEqual(stageSignals(run(normalizer, [rawEvent("session.step.started", { sessionID: SESSION })]).signals), [
    "analysis",
  ]);
});

test("permissions and forms are recorded as waiting, then resolved", () => {
  const normalizer = newNormalizer();
  const { events, signals } = run(normalizer, [
    rawEvent("permission.asked", {
      id: "per_1",
      sessionID: SESSION,
      action: "shell",
      resources: ["npm test*", "rm -rf /"],
    }),
    rawEvent("permission.replied", { sessionID: SESSION, requestID: "per_1", reply: "reject" }),
    rawEvent("form.created", { form: { id: "frm_1", sessionID: SESSION, title: "Pick", fields: [] } }),
    rawEvent("form.cancelled", { id: "frm_1", sessionID: SESSION }),
  ]);
  assert.deepEqual(eventTypes(events), ["AGENT_WAITING", "AGENT_WAITING"]);
  assert.deepEqual(events[0]?.payload, {
    kind: "permission",
    requestId: "per_1",
    action: "shell",
    resources: ["npm test*", "rm -rf /"],
  });
  assert.deepEqual(
    signals.map((signal) => signal.kind),
    ["permission_asked", "permission_resolved", "form_asked", "permission_resolved"],
  );
});

test("usage is reported only when all counters are present", () => {
  const normalizer = newNormalizer();
  const complete = run(normalizer, [
    rawEvent("session.usage.updated", {
      sessionID: SESSION,
      cost: 0,
      tokens: { input: 1132, output: 109, reasoning: 0, cache: { read: 896, write: 0 } },
    }),
  ]);
  assert.deepEqual(complete.signals, [
    {
      kind: "usage",
      usage: {
        tokens: { input: 1132, output: 109, reasoning: 0, cacheRead: 896, cacheWrite: 0 },
        reportedCost: 0,
      },
    },
  ]);
  const partial = run(normalizer, [rawEvent("session.usage.updated", { sessionID: SESSION, cost: 0, tokens: { input: 1 } })]);
  assert.deepEqual(partial.signals, []);
});

test("an aborted step is not an error; a failed step is", () => {
  const normalizer = newNormalizer();
  const aborted = run(normalizer, [
    rawEvent("session.step.failed", { sessionID: SESSION, error: { type: "aborted", message: "Step interrupted" } }),
  ]);
  assert.deepEqual(aborted.events, []);
  const failed = run(normalizer, [
    rawEvent("session.step.failed", {
      sessionID: SESSION,
      error: { type: "APIError", message: "rate limited token=SAMPLE-TOKEN-9", status: 429 },
    }),
  ]);
  assert.deepEqual(eventTypes(failed.events), ["ERROR"]);
  assert.deepEqual(failed.events[0]?.payload, { message: "rate limited token=[REDACTED]", type: "APIError", status: 429 });
});

test("execution failures carry an ErrorInfo with transient set only for retryable statuses", () => {
  const normalizer = newNormalizer();
  const transient = run(normalizer, [
    rawEvent("session.execution.failed", { sessionID: SESSION, error: { type: "APIError", message: "busy", status: 503 } }),
  ]);
  assert.deepEqual(transient.signals, [
    {
      kind: "execution_failed",
      error: { code: "EXECUTION_FAILED", message: "busy", transient: true, status: 503 },
    },
  ]);
  const permanent = run(normalizer, [
    rawEvent("session.execution.failed", { sessionID: SESSION, error: { type: "ProviderError", message: "bad model" } }),
  ]);
  assert.deepEqual(permanent.signals, [
    { kind: "execution_failed", error: { code: "EXECUTION_FAILED", message: "bad model", transient: false } },
  ]);
});

test("unknown types and incomplete data never throw", () => {
  const normalizer = newNormalizer();
  const noId = rawEvent("session.execution.started", { sessionID: SESSION }, { id: "" });
  const malformed: RawOpenCodeEvent[] = [
    rawEvent("unknown.future.type", { sessionID: SESSION }),
    rawEvent("session.tool.called", { sessionID: SESSION }),
    rawEvent("session.execution.failed", { sessionID: SESSION, error: "boom" }),
    rawEvent("session.execution.interrupted", { sessionID: SESSION, reason: "bogus" }),
    rawEvent("session.step.ended", { sessionID: SESSION, files: "not-an-array", finish: 3 }),
    rawEvent("session.step.started", { sessionID: SESSION, model: "text" }),
    rawEvent("session.usage.updated", { sessionID: SESSION, tokens: null, cost: "free" }),
    rawEvent("permission.asked", { sessionID: SESSION }),
    rawEvent("form.created", { sessionID: SESSION }),
    rawEvent("session.retry.scheduled", { sessionID: SESSION, error: null, attempt: "two" }),
    noId,
    { type: "session.execution.started", data: { sessionID: SESSION } } as unknown as RawOpenCodeEvent,
    null as unknown as RawOpenCodeEvent,
  ];
  for (const raw of malformed) {
    const batch = normalizer.normalize(raw, BOUND);
    assert.ok(Array.isArray(batch.events) && Array.isArray(batch.signals));
  }
  assert.equal(normalizer.normalize(noId, BOUND).events.length, 0, "no stable id, nothing persisted");
});

test("an event that makes the normalizer throw is dropped and logged", () => {
  const logger = recordingLogger();
  const normalizer = newNormalizer(logger);
  const hostile = rawEvent("session.execution.started", {});
  Object.defineProperty(hostile, "data", {
    enumerable: true,
    get() {
      throw new Error("getter exploded");
    },
  });
  assert.deepEqual(normalizer.normalize(hostile, BOUND), { events: [], signals: [] });
  assert.deepEqual(logger.warnings, ["dropped an OpenCode event that could not be normalized"]);
});

test("normalizing a completed session twice gives the same ids", () => {
  const fixture = loadFixture().filter((raw) => sessionIdOf(raw) === SESSION_COMPLETED);
  const bound = binding("tsk_completed", SESSION_COMPLETED);
  const first = run(newNormalizer(), fixture, bound).events.map((event) => event.event_id);
  const second = run(newNormalizer(), fixture, bound).events.map((event) => event.event_id);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length);
});

test("the cancelled session of the fixture ends with an interruption and no error", () => {
  const fixture = loadFixture().filter((raw) => sessionIdOf(raw) === SESSION_CANCELLED);
  const { events, signals } = run(newNormalizer(), fixture, binding("tsk_cancelled", SESSION_CANCELLED));
  assert.deepEqual(eventTypes(events), ["AGENT_STARTED", "AGENT_THINKING", "AGENT_FINISHED"]);
  assert.deepEqual(events[2]?.payload, { outcome: "interrupted", reason: "user" });
  assert.deepEqual(signals.at(-1), { kind: "execution_interrupted", reason: "user" });
});

test("an interruption with no recognised reason still signals, with the reason key absent", () => {
  const normalizer = newNormalizer();
  const { events, signals } = run(normalizer, [
    rawEvent("session.execution.interrupted", { sessionID: SESSION, reason: "bogus" }),
  ]);
  assert.deepEqual(events[0]?.payload, { outcome: "interrupted" });
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0], { kind: "execution_interrupted" });
  assert.equal("reason" in (signals[0] ?? {}), false);
});

test("signals are still returned when the native event has no id, although no history row is written", () => {
  const normalizer = newNormalizer();
  const { events, signals } = run(normalizer, [
    rawEvent("session.execution.started", { sessionID: SESSION }, { id: "" }),
  ]);
  assert.equal(events.length, 0);
  assert.deepEqual(signals, [{ kind: "execution_started" }]);
});

test("restore keeps a restored execution stage: a later step.started does not move it back to analysis", () => {
  const normalizer = newNormalizer();
  normalizer.restore(SESSION, { stage: "execution", filesModified: true });
  const { signals } = run(normalizer, [rawEvent("session.step.started", { sessionID: SESSION })]);
  assert.deepEqual(stageSignals(signals), []);
});

test("a restored filesModified flag lets a validation command reach the validation stage", () => {
  const normalizer = newNormalizer();
  normalizer.restore(SESSION, { stage: "execution", filesModified: true });
  const { signals } = run(normalizer, [
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: "c_val", name: "shell" }),
    rawEvent("session.tool.called", { sessionID: SESSION, id: "c_val", input: { command: "npm run typecheck" } }),
  ]);
  assert.deepEqual(stageSignals(signals), ["validation"]);
});

test("without a restored filesModified flag, a validation command does not reach validation", () => {
  const normalizer = newNormalizer();
  normalizer.restore(SESSION, { stage: "execution", filesModified: false });
  const { signals } = run(normalizer, [
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: "c_val", name: "shell" }),
    rawEvent("session.tool.called", { sessionID: SESSION, id: "c_val", input: { command: "npm test" } }),
  ]);
  assert.deepEqual(stageSignals(signals), []);
});

test("restore replaces the state held for the session", () => {
  const normalizer = newNormalizer();
  run(normalizer, [rawEvent("session.step.ended", { sessionID: SESSION, finish: "stop" })]);
  normalizer.restore(SESSION, { stage: "analysis", filesModified: false });
  // Finalization was reached before the restore; if the restore had not replaced the state, nothing would be signalled.
  const { signals } = run(normalizer, [rawEvent("session.step.ended", { sessionID: SESSION, finish: "stop" })]);
  assert.deepEqual(stageSignals(signals), ["finalization"]);
});

test("tool names are redacted and bounded before they are stored or echoed", () => {
  const normalizer = newNormalizer();
  const name = `token=SAMPLE-TOKEN-5 ${"x".repeat(400)}`;
  const { events } = run(normalizer, [
    rawEvent("session.tool.input.started", { sessionID: SESSION, id: "c_name", name }),
    rawEvent("session.tool.called", { sessionID: SESSION, id: "c_name", input: {} }),
    rawEvent("session.tool.failed", { sessionID: SESSION, id: "c_name", error: { message: "boom" } }),
  ]);
  const tool = String(events[0]?.payload.tool);
  assert.ok(tool.length <= LIMITS.identifier, `tool name length ${tool.length}`);
  assert.ok(tool.includes("[REDACTED]"));
  assert.ok(!JSON.stringify(events).includes("SAMPLE-TOKEN-5"));
});

test("permission signals keep the request id intact and bound the action and resources", () => {
  const normalizer = newNormalizer();
  const requestId = `per_${"9".repeat(200)}`;
  const { events, signals } = run(normalizer, [
    rawEvent("permission.asked", {
      id: requestId,
      sessionID: SESSION,
      action: `shell ${"a".repeat(300)}`,
      resources: ["npm test password=SAMPLE-PASSWORD-1", ...Array.from({ length: 8 }, (_, index) => `r${index}`)],
    }),
  ]);
  const signal = signals[0];
  assert.equal(signal?.kind, "permission_asked");
  if (signal?.kind !== "permission_asked") return;
  assert.equal(signal.requestId, requestId);
  assert.ok(signal.action.length <= LIMITS.identifier);
  assert.equal(signal.resources.length, LIMITS.items);
  assert.ok(!signal.resources[0]?.includes("SAMPLE-PASSWORD-1"));
  assert.equal(events[0]?.payload.requestId, requestId);
  assert.ok(String(events[0]?.payload.action).length <= LIMITS.identifier);
});
