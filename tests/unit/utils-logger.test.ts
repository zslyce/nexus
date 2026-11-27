import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexusError, type Logger } from "../../src/contracts/index.ts";
import {
  createFileSink,
  createLogger,
  createStderrSink,
  isSensitiveKey,
  parseLogLevel,
  redactString,
  redactValue,
  type LogSink,
} from "../../src/utils/index.ts";

const SECRETS = [
  "SAMPLE-BEARER-7f3a",
  "SAMPLE-API-KEY-91bc",
  "SAMPLE-PASSWORD-hunter",
  "SAMPLE-TOKEN-22de",
  "SAMPLE-SECRET-aa10",
  "SAMPLE-QUERY-TOKEN-c4d9",
  "SAMPLE-BASIC-Zm9v",
];

const created: string[] = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function memorySink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return { sink: (line) => lines.push(line), lines };
}

function fixedClock(now: number): { now(): number } {
  return { now: () => now };
}

test("each line is JSON with time, level, message and data", () => {
  const { sink, lines } = memorySink();
  const logger = createLogger({ sinks: [sink], clock: fixedClock(Date.UTC(2026, 10, 26, 12, 0, 0)) });
  logger.info("task started", { taskId: "tsk_1", attempt: 1 });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    time: "2026-11-26T12:00:00.000Z",
    level: "info",
    message: "task started",
    data: { taskId: "tsk_1", attempt: 1 },
  });
});

test("data is omitted when not provided", () => {
  const { sink, lines } = memorySink();
  createLogger({ sinks: [sink] }).warn("plain");
  assert.equal("data" in JSON.parse(lines[0] ?? "{}"), false);
});

test("the minimum level filters lower levels", () => {
  const { sink, lines } = memorySink();
  const logger = createLogger({ sinks: [sink], level: "warn" });
  logger.debug("d");
  logger.info("i");
  logger.warn("w");
  logger.error("e");
  assert.deepEqual(lines.map((line) => JSON.parse(line).level), ["warn", "error"]);
});

test("the default level is info", () => {
  const { sink, lines } = memorySink();
  const logger = createLogger({ sinks: [sink] });
  logger.debug("hidden");
  logger.info("shown");
  assert.equal(lines.length, 1);
});

test("parseLogLevel accepts the four levels and rejects others", () => {
  assert.equal(parseLogLevel("debug"), "debug");
  assert.equal(parseLogLevel("error"), "error");
  assert.throws(() => parseLogLevel("trace"), (error: unknown) => {
    assert.ok(error instanceof NexusError);
    assert.equal(error.info.code, "VALIDATION");
    return true;
  });
});

test("sensitive keys are redacted at any depth, including inside arrays", () => {
  const { sink, lines } = memorySink();
  createLogger({ sinks: [sink] }).info("request", {
    headers: { Authorization: `Bearer ${SECRETS[0]}`, accept: "application/json" },
    config: { apiKey: SECRETS[1], nested: { password: SECRETS[2] } },
    items: [{ token: SECRETS[3] }, { clientSecret: SECRETS[4] }],
  });
  const line = lines[0] ?? "";
  for (const secret of SECRETS.slice(0, 5)) {
    assert.ok(!line.includes(secret), `secret ${secret} must not appear`);
  }
  const data = JSON.parse(line).data;
  assert.equal(data.headers.Authorization, "[REDACTED]");
  assert.equal(data.headers.accept, "application/json");
  assert.equal(data.config.apiKey, "[REDACTED]");
  assert.equal(data.config.nested.password, "[REDACTED]");
  assert.equal(data.items[0].token, "[REDACTED]");
  assert.equal(data.items[1].clientSecret, "[REDACTED]");
});

test("usage counters and idempotency keys are not redacted", () => {
  const redacted = redactValue({
    usage: { tokens: { input: 5, output: 7 } },
    idempotencyKey: "a".repeat(64),
  }) as { usage: { tokens: { input: number } }; idempotencyKey: string };
  assert.equal(redacted.usage.tokens.input, 5);
  assert.equal(redacted.idempotencyKey, "a".repeat(64));
});

test("credentials inside free text are scrubbed from messages and string values", () => {
  const { sink, lines } = memorySink();
  const logger = createLogger({ sinks: [sink] });
  logger.error(`upstream said Authorization: Bearer ${SECRETS[0]} and failed`);
  logger.error("retrying https://host/path?token=" + SECRETS[5] + "&page=2", { note: `Authorization: Basic ${SECRETS[6]}` });
  const output = lines.join("\n");
  assert.ok(!output.includes(SECRETS[0] ?? ""));
  assert.ok(!output.includes(SECRETS[5] ?? ""));
  assert.ok(!output.includes(SECRETS[6] ?? ""));
  assert.ok(output.includes("&page=2"), "non-secret query parameters are kept");
});

test("errors keep their name and message, scrubbed, and their NexusError info", () => {
  const redacted = redactValue(
    new NexusError({ code: "OPENCODE_AUTH", message: `denied: Bearer ${SECRETS[0]}`, transient: false, status: 401 }),
  ) as { name: string; message: string; info: { code: string } };
  assert.equal(redacted.name, "NexusError");
  assert.equal(redacted.info.code, "OPENCODE_AUTH");
  assert.ok(!JSON.stringify(redacted).includes(SECRETS[0] ?? ""));
});

test("circular references and very deep objects do not throw", () => {
  const { sink, lines } = memorySink();
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic.self = cyclic;
  let deep: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < 50; i++) deep = { child: deep };
  createLogger({ sinks: [sink] }).info("cyclic", { cyclic, deep, big: 10n, when: new Date(Number.NaN) });
  const data = JSON.parse(lines[0] ?? "").data;
  assert.equal(data.cyclic.self, "[Circular]");
  assert.equal(data.big, "10");
  assert.equal(data.when, "Invalid Date");
});

test("a sink that throws does not stop the caller or the other sinks", () => {
  const { sink, lines } = memorySink();
  const broken: LogSink = () => {
    throw new Error("disk full");
  };
  const logger = createLogger({ sinks: [broken, sink] });
  assert.doesNotThrow(() => logger.info("still logged"));
  assert.equal(lines.length, 1);
});

test("the stderr sink writes one line per entry to the given stream", () => {
  const chunks: string[] = [];
  const logger = createLogger({ sinks: [createStderrSink({ write: (chunk) => (chunks.push(chunk), true) })] });
  logger.info("hello");
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]?.endsWith("\n"));
  assert.equal(JSON.parse(chunks[0] ?? "").message, "hello");
});

test("the file sink appends lines and creates the folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-log-"));
  created.push(dir);
  const file = join(dir, "state", "daemon.log");
  const logger: Logger = createLogger({ sinks: [createFileSink(file)] });
  logger.info("first");
  logger.error("second", { code: "INTERNAL" });
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  assert.deepEqual(lines.map((line) => JSON.parse(line).message), ["first", "second"]);
});

test("the default sink writes to stderr and never to stdout", () => {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let stdoutWrites = 0;
  const stderrLines: string[] = [];
  process.stdout.write = (() => {
    stdoutWrites++;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    createLogger().info("goes to stderr only");
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.equal(stdoutWrites, 0);
  assert.equal(stderrLines.length, 1);
});

test("no sample secret appears in the output of any level, however it is passed", () => {
  const { sink, lines } = memorySink();
  const logger = createLogger({ sinks: [sink], level: "debug" });
  const payload = {
    authorization: `Bearer ${SECRETS[0]}`,
    headers: { AUTHORIZATION: `Bearer ${SECRETS[0]}` },
    apiKey: SECRETS[1],
    password: SECRETS[2],
    token: SECRETS[3],
    secret: SECRETS[4],
    text: `Authorization: Bearer ${SECRETS[0]}; api_key=${SECRETS[1]}; password: ${SECRETS[2]}`,
    error: new Error(`token=${SECRETS[3]}`),
  };
  for (const log of [logger.debug, logger.info, logger.warn, logger.error] as const) {
    // A bare secret in free text has no recognizable marker, so it is only covered in `key=value` form.
    log(`message with secret=${SECRETS[4]} and Bearer ${SECRETS[0]}`, payload);
  }
  const output = lines.join("\n");
  for (const secret of SECRETS.slice(0, 5)) {
    assert.ok(!output.includes(secret), `secret ${secret} leaked`);
  }
  assert.equal(lines.length, 4);
});

test("redactString leaves ordinary text alone", () => {
  assert.equal(redactString("Basic usage of the API"), "Basic usage of the API");
  assert.equal(redactString("tokens: 12, keys: 3"), "tokens: 12, keys: 3");
});

test("isSensitiveKey matches the documented names in common spellings", () => {
  for (const key of ["Authorization", "x-authorization", "password", "DB_PASSWORD", "token", "accessToken", "apiKey", "api_key", "clientSecret", "accesstoken", "APIKey"]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  for (const key of ["taskId", "model", "keyboardLayout", "monkey"]) {
    assert.equal(isSensitiveKey(key), false, key);
  }
});

test("a sensitive word followed by a suffix is sensitive", () => {
  for (const key of ["tokenValue", "apiKeyId", "token_value", "secretName", "passwordHash", "authorizationHeader"]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
});

test("plural usage counters and TokenUsage fields are not sensitive", () => {
  for (const key of ["tokens", "maxTokens", "totalTokens", "input", "output", "reasoning", "cacheRead", "cacheWrite", "reportedCost", "idempotencyKey", "idempotency_key"]) {
    assert.equal(isSensitiveKey(key), false, key);
  }
});

test("usage counters stay readable in a logged payload while credential-like keys are redacted", () => {
  const redacted = redactValue({
    tokenValue: `SAMPLE-SUFFIX-${SECRETS[3]}`,
    apiKeyId: "SAMPLE-SUFFIX-KEYID",
    token_value: "SAMPLE-SUFFIX-SNAKE",
    usage: {
      tokens: { input: 5, output: 7, reasoning: 1, cacheRead: 2, cacheWrite: 3 },
      reportedCost: 0.25,
    },
    maxTokens: 4096,
    totalTokens: 9000,
  }) as Record<string, unknown>;
  assert.equal(redacted.tokenValue, "[REDACTED]");
  assert.equal(redacted.apiKeyId, "[REDACTED]");
  assert.equal(redacted.token_value, "[REDACTED]");
  assert.deepEqual(redacted.usage, {
    tokens: { input: 5, output: 7, reasoning: 1, cacheRead: 2, cacheWrite: 3 },
    reportedCost: 0.25,
  });
  assert.equal(redacted.maxTokens, 4096);
  assert.equal(redacted.totalTokens, 9000);
});

test("secrets inside escaped JSON embedded in a string are scrubbed", () => {
  const embedded = '{\\"token\\":\\"SAMPLE-ESC-1\\",\\"Authorization\\":\\"Bearer SAMPLE-ESC-2\\",\\"password\\": \\"SAMPLE-ESC-3\\",\\"apiKey\\":\\"SAMPLE-ESC-4\\"}';
  const scrubbed = redactString(embedded);
  for (const value of ["SAMPLE-ESC-1", "SAMPLE-ESC-2", "SAMPLE-ESC-3", "SAMPLE-ESC-4"]) {
    assert.ok(!scrubbed.includes(value), `${value} must not appear`);
  }
  assert.ok(scrubbed.includes('\\"token\\":\\"[REDACTED]\\"'), scrubbed);
  assert.ok(scrubbed.includes('\\"apiKey\\":\\"[REDACTED]\\"'), scrubbed);
});

test("escaped JSON reaches the logger output through a string value", () => {
  const { sink, lines } = memorySink();
  createLogger({ sinks: [sink] }).error("upstream body", { body: '{\\"token\\":\\"SAMPLE-ESC-5\\"}' });
  assert.ok(!lines.join("\n").includes("SAMPLE-ESC-5"));
});
