import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { NexusError } from "../../src/contracts/common.ts";
import type { RawOpenCodeEvent } from "../../src/contracts/gateway.ts";
import { createOpenCodeGateway, type GatewaySeams } from "../../src/server/index.ts";
import {
  fakeScheduler,
  fixture,
  recordingLogger,
  startFakeOpenCode,
  writeRegistration,
  type FakeOpenCode,
} from "./server-fake-opencode.ts";
import { assertOpenApiConformance } from "./server-openapi.ts";

const EVENTS = fixture<RawOpenCodeEvent[]>("events.two-sessions.json");

const CONNECTED: RawOpenCodeEvent = { id: "evt_connected", type: "server.connected", created: 1, data: {} };

function frame(event: RawOpenCodeEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

interface Harness {
  readonly fake: FakeOpenCode;
  readonly scheduler: ReturnType<typeof fakeScheduler>;
  readonly logger: ReturnType<typeof recordingLogger>;
  readonly gateway: ReturnType<typeof createOpenCodeGateway>;
}

async function harness(t: TestContext, options: { registerFake?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "nexus-subscribe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = await startFakeOpenCode();
  t.after(async () => {
    await fake.close();
    assertOpenApiConformance(fake);
  });
  const file = writeRegistration(dir, { url: fake.url, pid: process.pid });
  if (options.registerFake === false) rmSync(file);
  const scheduler = fakeScheduler();
  const logger = recordingLogger();
  const seams: Partial<GatewaySeams> = { scheduler };
  const gateway = createOpenCodeGateway({ logger, autoStart: false, registrationFile: file, silenceTimeoutMs: 45_000, seams });
  return { fake, scheduler, logger, gateway };
}

/** Starts the stream and waits for `server.connected`, which proves the request is established. */
async function openStream(h: Harness, signal: AbortSignal): Promise<AsyncIterator<RawOpenCodeEvent>> {
  const iterator = h.gateway.subscribe(signal)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.type, "server.connected");
  return iterator;
}

test("the events arrive in order, and leaving the loop closes the socket and the watchdog", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/event", (c) => {
    const stream = c.sse();
    stream.write(frame(CONNECTED));
    for (const event of EVENTS.slice(0, 5)) stream.write(frame(event));
  });
  const controller = new AbortController();
  const received: string[] = [];
  for await (const event of h.gateway.subscribe(controller.signal)) {
    received.push(event.id);
    if (received.length === 3) break;
  }
  assert.deepEqual(received, [CONNECTED.id, EVENTS[0]?.id, EVENTS[1]?.id]);
  await h.fake.whenStreamsClosed();
  assert.equal(h.scheduler.pending().length, 0, "no watchdog timer may outlive the subscription");
});

test("aborting the signal while next() is pending ends the iteration and closes the socket (R2)", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/event", (c) => {
    c.sse().write(frame(CONNECTED));
  });
  const controller = new AbortController();
  const iterator = await openStream(h, controller.signal);
  const pending = iterator.next();
  controller.abort();
  assert.deepEqual(await pending, { done: true, value: undefined });
  await h.fake.whenStreamsClosed();
  assert.equal(h.scheduler.pending().length, 0);
});

test("an abort during discovery leaves no listener behind and opens no stream", async (t) => {
  const h = await harness(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const gateway = createOpenCodeGateway({
    logger: recordingLogger(),
    autoStart: false,
    seams: {
      scheduler: h.scheduler,
      discover: async () => {
        await gate;
        return { url: h.fake.url };
      },
    },
  });
  const controller = new AbortController();
  const iterator = gateway.subscribe(controller.signal)[Symbol.asyncIterator]();
  const pending = iterator.next(); // starts, and waits in discovery
  controller.abort();
  release();
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(h.fake.requests.filter((r) => r.path === "/api/event").length, 0, "no stream may be opened");
  assert.equal(h.scheduler.pending().length, 0, "no watchdog may be armed");
});

test("an already aborted signal makes no request", async (t) => {
  const h = await harness(t);
  const controller = new AbortController();
  controller.abort();
  const received: unknown[] = [];
  for await (const event of h.gateway.subscribe(controller.signal)) received.push(event);
  assert.deepEqual(received, []);
  assert.equal(h.fake.requests.filter((r) => r.path === "/api/event").length, 0);
});

test("a stream cut midway throws a transient OPENCODE_UNAVAILABLE after the events already received", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/event", (c) => {
    const stream = c.sse();
    stream.write(frame(CONNECTED));
    stream.write(frame(EVENTS[0] as RawOpenCodeEvent));
    setImmediate(() => stream.destroy());
  });
  const controller = new AbortController();
  const received: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of h.gateway.subscribe(controller.signal)) received.push(event.id);
    })(),
    (error: unknown) => {
      assert.ok(error instanceof NexusError);
      assert.equal(error.info.code, "OPENCODE_UNAVAILABLE");
      assert.equal(error.info.transient, true);
      return true;
    },
  );
  assert.deepEqual(received, [CONNECTED.id, EVENTS[0]?.id]);
  assert.ok(h.logger.records.some((record) => record.message.includes("endpoint lost")));
});

test("a stream that ends by itself is a transient loss, so the caller reconnects", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/event", (c) => {
    const stream = c.sse();
    stream.write(frame(CONNECTED));
    stream.end();
  });
  const controller = new AbortController();
  const iterator = h.gateway.subscribe(controller.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "server.connected");
  await assert.rejects(iterator.next(), (error: unknown) => {
    assert.ok(error instanceof NexusError);
    assert.equal(error.info.code, "OPENCODE_UNAVAILABLE");
    assert.equal(error.info.transient, true);
    assert.equal(error.message, "OpenCode closed the event stream");
    return true;
  });
});

test("a 401 on the stream keeps its classification and is not transient", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/event", (c) => c.json(401, { _tag: "UnauthorizedError", message: "Unauthorized" }));
  const controller = new AbortController();
  await assert.rejects(h.gateway.subscribe(controller.signal)[Symbol.asyncIterator]().next(), (error: unknown) => {
    assert.ok(error instanceof NexusError);
    assert.equal(error.info.code, "OPENCODE_AUTH");
    assert.equal(error.info.transient, false);
    return true;
  });
});

test("keepalive frames re-arm the watchdog: it never fires while the service is alive", async (t) => {
  const h = await harness(t);
  let stream: ServerResponse | undefined;
  h.fake.route("GET /api/event", (c) => {
    stream = c.sse();
    stream.write(frame(CONNECTED));
  });
  const controller = new AbortController();
  const iterator = await openStream(h, controller.signal);
  assert.ok(stream !== undefined);
  const armedBefore = h.scheduler.timers.length;

  // A keepalive is a comment frame: it yields no event, but it is activity.
  stream.write(": keepalive\n\n");
  stream.write(frame(EVENTS[0] as RawOpenCodeEvent));
  assert.equal((await iterator.next()).value?.id, EVENTS[0]?.id);

  assert.ok(h.scheduler.timers.length > armedBefore, "activity must arm the watchdog again");
  assert.ok(h.scheduler.cleared() >= 1, "the previous timer must be cleared");
  assert.equal(h.scheduler.pending().length, 1);
  assert.equal(h.scheduler.timers.filter((timer) => timer.status === "fired").length, 0);

  controller.abort();
  await iterator.next();
});

test("a silent stream: the watchdog ends the pending read with a transient error and closes the socket", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/event", (c) => {
    c.sse().write(frame(CONNECTED));
  });
  const controller = new AbortController();
  const iterator = await openStream(h, controller.signal);
  const pending = iterator.next();
  h.scheduler.fireLast();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof NexusError);
    assert.equal(error.info.code, "OPENCODE_UNAVAILABLE");
    assert.equal(error.info.transient, true);
    assert.match(error.message, /silent for 45000 ms/);
    return true;
  });
  await h.fake.whenStreamsClosed();
});

test("nothing registered: subscribe throws a transient error without making a request", async (t) => {
  const h = await harness(t, { registerFake: false });
  const controller = new AbortController();
  await assert.rejects(h.gateway.subscribe(controller.signal)[Symbol.asyncIterator]().next(), (error: unknown) => {
    assert.ok(error instanceof NexusError);
    assert.equal(error.info.code, "OPENCODE_UNAVAILABLE");
    assert.equal(error.info.transient, true);
    return true;
  });
  assert.equal(h.fake.requests.filter((r) => r.path === "/api/event").length, 0);
});
