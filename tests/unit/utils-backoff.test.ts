import { test } from "node:test";
import assert from "node:assert/strict";
import { NexusError } from "../../src/contracts/index.ts";
import { backoffDelay, fullJitter, noJitter } from "../../src/utils/index.ts";

const policy = { baseMs: 2000, maxMs: 60000 };

test("the delay doubles per retry from baseMs and is capped at maxMs", () => {
  const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffDelay(attempt, policy));
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test("very large attempt numbers stay at maxMs and never produce NaN", () => {
  assert.equal(backoffDelay(10_000, policy), 60000);
  assert.equal(backoffDelay(Number.MAX_SAFE_INTEGER, policy), 60000);
});

test("a zero base is always zero", () => {
  assert.equal(backoffDelay(50, { baseMs: 0, maxMs: 60000 }), 0);
});

test("a maxMs below baseMs caps the first delay", () => {
  assert.equal(backoffDelay(1, { baseMs: 5000, maxMs: 1000 }), 1000);
});

test("the default jitter leaves the delay unchanged", () => {
  assert.equal(backoffDelay(3, policy, noJitter), 8000);
});

test("an injected jitter receives the capped delay and the attempt number", () => {
  const seen: Array<[number, number]> = [];
  const jitter = (delayMs: number, attempt: number): number => {
    seen.push([delayMs, attempt]);
    return delayMs / 2;
  };
  assert.equal(backoffDelay(2, policy, jitter), 2000);
  assert.deepEqual(seen, [[4000, 2]]);
});

test("a jittered value is clamped to [0, maxMs]", () => {
  assert.equal(backoffDelay(1, policy, () => 999_999), 60000);
  assert.equal(backoffDelay(1, policy, () => -5), 0);
});

test("a non-finite jitter result falls back to the capped delay", () => {
  assert.equal(backoffDelay(2, policy, () => Number.NaN), 4000);
  assert.equal(backoffDelay(2, policy, () => Number.POSITIVE_INFINITY), 4000);
});

test("fullJitter scales the delay with the injected random value", () => {
  assert.equal(backoffDelay(3, policy, fullJitter(() => 0.5)), 4000);
  assert.equal(backoffDelay(3, policy, fullJitter(() => 0)), 0);
});

test("the result is rounded to whole milliseconds", () => {
  assert.equal(backoffDelay(1, policy, () => 1234.6), 1235);
});

test("invalid attempt numbers are VALIDATION errors", () => {
  for (const attempt of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => backoffDelay(attempt, policy), (error: unknown) => {
      assert.ok(error instanceof NexusError);
      assert.equal(error.info.code, "VALIDATION");
      return true;
    });
  }
});

test("invalid policy values are VALIDATION errors", () => {
  assert.throws(() => backoffDelay(1, { baseMs: -1, maxMs: 10 }), NexusError);
  assert.throws(() => backoffDelay(1, { baseMs: 1, maxMs: Number.NaN }), NexusError);
});
