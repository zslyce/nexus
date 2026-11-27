import { test } from "node:test";
import assert from "node:assert/strict";
import { ID_PATTERNS, createIdGenerator } from "../../src/utils/index.ts";

test("generated IDs have their prefixes and match ID_PATTERNS", () => {
  const ids = createIdGenerator();
  for (let i = 0; i < 200; i++) {
    assert.match(ids.taskId(), ID_PATTERNS.task);
    assert.match(ids.sessionId(), ID_PATTERNS.session);
    assert.match(ids.messageId(), ID_PATTERNS.message);
  }
});

test("session IDs start with ses and message IDs with msg_, as OpenCode's schemas require", () => {
  const ids = createIdGenerator();
  assert.ok(ids.sessionId().startsWith("ses"));
  assert.ok(ids.messageId().startsWith("msg_"));
  assert.ok(ids.taskId().startsWith("tsk_"));
});

test("generated IDs are unique across many calls", () => {
  const ids = createIdGenerator();
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    seen.add(ids.taskId());
    seen.add(ids.sessionId());
    seen.add(ids.messageId());
  }
  assert.equal(seen.size, 15000);
});

test("an injected random source makes the output deterministic", () => {
  const counter = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_, index) => index);
  const ids = createIdGenerator(counter);
  assert.equal(ids.taskId(), "tsk_00010203040506070809");
  assert.equal(ids.sessionId(), "ses_nexus_0001020304050607");
  assert.equal(ids.messageId(), "msg_nexus_0001020304050607");
});

test("a random source that returns the wrong number of bytes is rejected", () => {
  const ids = createIdGenerator(() => new Uint8Array(3));
  assert.throws(() => ids.taskId(), RangeError);
});

test("the ID patterns reject malformed values", () => {
  assert.doesNotMatch("tsk_XYZ", ID_PATTERNS.task);
  assert.doesNotMatch("tsk_0123456789abcdef0123extra", ID_PATTERNS.task);
  assert.doesNotMatch("ses_0123456789abcdef", ID_PATTERNS.session);
  assert.doesNotMatch("msg_nexus_0123456789abcdef0", ID_PATTERNS.message);
});
