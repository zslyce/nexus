import { test } from "node:test";
import assert from "node:assert/strict";
import { NexusError } from "../../src/contracts/index.ts";
import { classifyError, isTransientError, isTransientStatus, nexusError } from "../../src/utils/index.ts";

test("nexusError marks only OPENCODE_UNAVAILABLE and 429/5xx as transient by default", () => {
  assert.equal(nexusError("VALIDATION", "bad").info.transient, false);
  assert.equal(nexusError("TIMEOUT", "slow").info.transient, false);
  assert.equal(nexusError("OPENCODE_UNAVAILABLE", "down").info.transient, true);
  assert.equal(nexusError("OPENCODE_API", "busy", { status: 429 }).info.transient, true);
  assert.equal(nexusError("OPENCODE_API", "boom", { status: 503 }).info.transient, true);
  assert.equal(nexusError("OPENCODE_API", "bad request", { status: 400 }).info.transient, false);
});

test("an explicit transient option overrides the default", () => {
  assert.equal(nexusError("OPENCODE_UNAVAILABLE", "down", { transient: false }).info.transient, false);
  assert.equal(nexusError("INTERNAL", "x", { transient: true }).info.transient, true);
});

test("nexusError keeps the cause and the status", () => {
  const cause = new Error("socket");
  const error = nexusError("OPENCODE_API", "bad gateway", { status: 502, cause });
  assert.ok(error instanceof NexusError);
  assert.equal(error.cause, cause);
  assert.equal(error.info.status, 502);
  assert.equal(error.name, "NexusError");
});

test("isTransientStatus covers 429 and 5xx only", () => {
  assert.equal(isTransientStatus(429), true);
  assert.equal(isTransientStatus(500), true);
  assert.equal(isTransientStatus(599), true);
  assert.equal(isTransientStatus(400), false);
  assert.equal(isTransientStatus(404), false);
  assert.equal(isTransientStatus(undefined), false);
});

test("a NexusError keeps its own classification", () => {
  const timeout = nexusError("TIMEOUT", "task exceeded its timeout");
  assert.deepEqual(classifyError(timeout), { code: "TIMEOUT", message: "task exceeded its timeout", transient: false });
  assert.equal(isTransientError(timeout), false);
  assert.equal(isTransientError(nexusError("OPENCODE_UNAVAILABLE", "down")), true);
});

test("HTTP 429 and 5xx are transient OPENCODE_API errors", () => {
  for (const status of [429, 500, 503]) {
    const info = classifyError({ status, message: "upstream" });
    assert.deepEqual(info, { code: "OPENCODE_API", message: "upstream", transient: true, status });
  }
});

test("HTTP 401 and 403 are OPENCODE_AUTH and not transient", () => {
  for (const status of [401, 403]) {
    const info = classifyError({ statusCode: status, message: "denied" });
    assert.equal(info.code, "OPENCODE_AUTH");
    assert.equal(info.transient, false);
    assert.equal(info.status, status);
  }
});

test("other 4xx responses are not transient", () => {
  const info = classifyError({ response: { status: 404 }, message: "missing" });
  assert.equal(info.code, "OPENCODE_API");
  assert.equal(info.transient, false);
  assert.equal(info.status, 404);
});

test("transport failures are transient OPENCODE_UNAVAILABLE, including those wrapped in a cause", () => {
  const direct = new Error("connect failed") as Error & { code?: string };
  direct.code = "ECONNREFUSED";
  assert.deepEqual(classifyError(direct), { code: "OPENCODE_UNAVAILABLE", message: "connect failed", transient: true });

  const fetchFailure = new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET", message: "other side closed" } });
  assert.equal(classifyError(fetchFailure).code, "OPENCODE_UNAVAILABLE");
  assert.equal(isTransientError(fetchFailure), true);
});

test("abort and timeout errors are INTERRUPTED and TIMEOUT, neither transient", () => {
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.deepEqual(classifyError(abort), { code: "INTERRUPTED", message: "aborted", transient: false });

  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  assert.deepEqual(classifyError(timeout), { code: "TIMEOUT", message: "timed out", transient: false });
});

test("unknown values are INTERNAL and not transient", () => {
  assert.deepEqual(classifyError(new Error("logic bug")), { code: "INTERNAL", message: "logic bug", transient: false });
  assert.deepEqual(classifyError("plain string"), { code: "INTERNAL", message: "plain string", transient: false });
  assert.deepEqual(classifyError(undefined), { code: "INTERNAL", message: "undefined", transient: false });
  assert.equal(classifyError(new Error("")).message, "Unknown error");
});

test("messages are scrubbed of credentials before classification", () => {
  const info = classifyError(new Error("request rejected: Authorization: Bearer SAMPLE-LEAK-5501"));
  assert.ok(!info.message.includes("SAMPLE-LEAK-5501"));
  assert.ok(info.message.includes("[REDACTED]"));
});
