import { test } from "node:test";
import assert from "node:assert/strict";
import { NexusError } from "../../src/contracts/common.ts";
import { isNotFound, isTransportError, translateError } from "../../src/server/errors.ts";

/** Shape produced by `declared()` in `@opencode/client`: an Error with the body merged in and `name` = `_tag`. */
function declared(tag: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { _tag: tag, message, ...extra }, { name: tag });
}

/** Shape produced by `ClientError` in `@opencode/client` (name and reason are the only parts Nexus reads). */
function clientError(reason: string, cause?: unknown): Error {
  const error = new Error(reason, { cause });
  return Object.assign(error, { name: "ClientError", reason });
}

function info(error: unknown): NexusError {
  const translated = translateError(error, "op");
  assert.ok(translated instanceof NexusError);
  return translated;
}

test("a 401 declared by OpenCode is OPENCODE_AUTH and not transient", () => {
  const failure = info(declared("UnauthorizedError", "bad password"));
  assert.deepEqual(failure.info, { code: "OPENCODE_AUTH", message: "op: bad password", transient: false, status: 401 });
});

test("SessionNotFoundError and other *NotFoundError are NOT_FOUND, which callers can detect", () => {
  const failure = info(declared("SessionNotFoundError", "missing"));
  assert.equal(failure.info.code, "NOT_FOUND");
  assert.equal(failure.info.status, 404);
  assert.equal(failure.info.transient, false);
  assert.equal(isNotFound(failure), true);
});

test("a transport failure is OPENCODE_UNAVAILABLE and transient", () => {
  const error = clientError("Transport");
  assert.equal(isTransportError(error), true);
  const failure = info(error);
  assert.equal(failure.info.code, "OPENCODE_UNAVAILABLE");
  assert.equal(failure.info.transient, true);
});

test("HTTP 5xx and 429 without a declared body are transient; 400 and 409 are not", () => {
  const cases: Array<[number, string, boolean]> = [
    [429, "OPENCODE_API", true],
    [500, "OPENCODE_API", true],
    [502, "OPENCODE_API", true],
    [503, "OPENCODE_UNAVAILABLE", true],
    [400, "OPENCODE_API", false],
    [409, "OPENCODE_API", false],
  ];
  for (const [status, code, transient] of cases) {
    const failure = info(clientError("UnexpectedStatus", { status }));
    assert.equal(failure.info.code, code, `status ${status}`);
    assert.equal(failure.info.transient, transient, `status ${status}`);
    assert.equal(failure.info.status, status);
  }
});

test("UnexpectedStatus 401 without JSON body is still OPENCODE_AUTH", () => {
  const failure = info(clientError("UnexpectedStatus", { status: 401 }));
  assert.equal(failure.info.code, "OPENCODE_AUTH");
  assert.equal(failure.info.transient, false);
});

test("malformed or unsupported responses are not transient", () => {
  for (const reason of ["MalformedResponse", "UnsupportedContentType", "SseEventTooLarge"]) {
    const failure = info(clientError(reason));
    assert.equal(failure.info.code, "OPENCODE_API", reason);
    assert.equal(failure.info.transient, false, reason);
  }
});

test("an unknown failure is OPENCODE_API without transient, and a NexusError passes through unchanged", () => {
  const failure = info(new TypeError("boom"));
  assert.equal(failure.info.code, "OPENCODE_API");
  assert.equal(failure.info.message, "op: boom");
  const original = new NexusError({ code: "NOT_FOUND", message: "x", transient: false });
  assert.equal(translateError(original, "op"), original);
});

test("a TypeError is not mistaken for a declared OpenCode error", () => {
  const failure = info(new TypeError("Error"));
  assert.equal(failure.info.code, "OPENCODE_API");
});

test("a bare 404 (no declared body) is an API problem, never NOT_FOUND: it may come from a foreign endpoint", () => {
  const failure = info(clientError("UnexpectedStatus", { status: 404 }));
  assert.equal(failure.info.code, "OPENCODE_API");
  assert.equal(failure.info.transient, false);
  assert.equal(failure.info.status, 404);
  assert.equal(isNotFound(failure), false);
});

test("only a declared not-found body is NOT_FOUND", () => {
  assert.equal(info(declared("FormNotFoundError", "gone")).info.code, "NOT_FOUND");
  assert.equal(info(declared("PermissionNotFoundError", "gone")).info.code, "NOT_FOUND");
});

test("SessionBusyError (409) is transient: the session frees up", () => {
  const failure = info(declared("SessionBusyError", "busy"));
  assert.equal(failure.info.code, "OPENCODE_API");
  assert.equal(failure.info.status, 409);
  assert.equal(failure.info.transient, true);
});

test("messages are scrubbed of credentials before they can be stored or logged", () => {
  const failure = info(declared("UnauthorizedError", "rejected Authorization: Bearer abc123SECRET and password=hunter2"));
  assert.doesNotMatch(failure.message, /abc123SECRET/);
  assert.doesNotMatch(failure.message, /hunter2/);
  assert.equal(failure.info.code, "OPENCODE_AUTH");
  const plain = info(new TypeError("cannot reach token=zzz999"));
  assert.doesNotMatch(plain.message, /zzz999/);
});
