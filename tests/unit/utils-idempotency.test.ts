import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveIdempotencyKey, type IdempotencyInput } from "../../src/utils/index.ts";

const base: IdempotencyInput = {
  agent: "explorer",
  model: "opencode-go/mimo-v2.6-flash",
  task: "List the modules",
  context: "Focus on src/utils",
  files: ["src/utils/paths.ts"],
  dependsOn: ["tsk_0123456789abcdef0123"],
};

test("the key for a fixed request is a stable constant (SHA-256 of the canonical JSON)", () => {
  // Canonical form computed by hand:
  // {"v":1,"agent":"explorer","model":"opencode-go/mimo-v2.6-flash","task":"List the modules",
  //  "context":"Focus on src/utils","files":["src/utils/paths.ts"],"dependsOn":["tsk_0123456789abcdef0123"]}
  assert.equal(deriveIdempotencyKey(base), "e58709329a96c84c85df2dfb2edd4c7e12d9f1b430f406fc120e15d164cf727a");
});

test("the same request always gives the same 64-character hex key", () => {
  assert.equal(deriveIdempotencyKey(base), deriveIdempotencyKey({ ...base }));
  assert.match(deriveIdempotencyKey(base), /^[0-9a-f]{64}$/);
});

test("the order and duplicates of files and dependencies do not change the key", () => {
  const a = deriveIdempotencyKey({ ...base, files: ["b.ts", "a.ts", "a.ts"], dependsOn: ["tsk_2", "tsk_1"] });
  const b = deriveIdempotencyKey({ ...base, files: ["a.ts", "b.ts"], dependsOn: ["tsk_1", "tsk_2", "tsk_1"] });
  assert.equal(a, b);
});

test("any change in the request changes the key", () => {
  const original = deriveIdempotencyKey(base);
  const variants: IdempotencyInput[] = [
    { ...base, agent: "developer" },
    { ...base, model: "opencode-go/mimo-v2.6-flash#high" },
    { ...base, task: "List the modules." },
    { ...base, context: "Focus on src" },
    { ...base, files: ["src/utils/backoff.ts"] },
    { ...base, dependsOn: [] },
  ];
  for (const variant of variants) {
    assert.notEqual(deriveIdempotencyKey(variant), original);
  }
});

test("an omitted optional value is the same as null", () => {
  const omitted = deriveIdempotencyKey({ agent: "explorer", task: "t" });
  const nulls = deriveIdempotencyKey({ agent: "explorer", task: "t", model: null, context: null, files: [], dependsOn: [] });
  assert.equal(omitted, nulls);
});

test("an empty context differs from no context", () => {
  assert.notEqual(
    deriveIdempotencyKey({ agent: "explorer", task: "t", context: "" }),
    deriveIdempotencyKey({ agent: "explorer", task: "t" }),
  );
});

test("the input arrays are not modified", () => {
  const files = ["b.ts", "a.ts"];
  deriveIdempotencyKey({ agent: "explorer", task: "t", files });
  assert.deepEqual(files, ["b.ts", "a.ts"]);
});
