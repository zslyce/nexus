import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexusError, type ErrorInfo } from "../../src/contracts/common.ts";
import type { CreateSessionInput } from "../../src/contracts/gateway.ts";
import { createOpenCodeGateway, type GatewaySeams } from "../../src/server/index.ts";
import {
  fakeScheduler,
  fixture,
  recordingLogger,
  startFakeOpenCode,
  writeRegistration,
  type FakeOpenCode,
  type RouteContext,
} from "./server-fake-opencode.ts";
import { assertOpenApiConformance } from "./server-openapi.ts";

interface Harness {
  readonly dir: string;
  readonly file: string;
  readonly fake: FakeOpenCode;
  readonly logger: ReturnType<typeof recordingLogger>;
  readonly sleeps: number[];
  readonly ensureCalls: unknown[];
  gateway: ReturnType<typeof createOpenCodeGateway>;
  seams: Partial<GatewaySeams>;
}

interface HarnessOptions {
  readonly autoStart?: boolean;
  readonly modelListAttempts?: number;
  readonly seams?: Partial<GatewaySeams>;
  readonly registerFake?: boolean;
}

/** Temporary folder, fake service, registration file pointing at it, and a gateway with no real waiting. */
async function harness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "nexus-gateway-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fake = await startFakeOpenCode();
  const file = writeRegistration(dir, { url: fake.url, pid: process.pid });
  if (options.registerFake === false) rmSync(file);
  const logger = recordingLogger();
  const sleeps: number[] = [];
  const ensureCalls: unknown[] = [];
  const seams: Partial<GatewaySeams> = {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ensure: async (ensureOptions) => {
      ensureCalls.push(ensureOptions);
      return { url: fake.url };
    },
    ...options.seams,
  };
  const built = {
    dir,
    file,
    fake,
    logger,
    sleeps,
    ensureCalls,
    seams,
    gateway: createOpenCodeGateway({
      logger,
      autoStart: options.autoStart ?? false,
      registrationFile: file,
      modelListAttempts: options.modelListAttempts ?? 3,
      modelListRetryDelayMs: 1,
      seams,
    }),
  };
  t.after(async () => {
    await fake.close();
    assertOpenApiConformance(fake);
  });
  return built;
}

function sessionBody(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    projectID: "prj_test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    location: { directory: "C:\\tmp\\work" },
    ...extra,
  };
}

const CREATE_INPUT: CreateSessionInput = {
  id: "ses_nexustest0001",
  directory: "C:\\tmp\\work",
  agent: "plan",
  model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "low" },
  title: "test",
  metadata: { nexusTaskId: "tsk_1" },
  permissions: [{ action: "read", resource: "*.env", effect: "deny" }],
};

function expectNexus(error: unknown, code: string): ErrorInfo {
  assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
  assert.equal(error.info.code, code);
  return error.info;
}

test("status reports the version of the registered service and its url", async (t) => {
  const h = await harness(t);
  const status = await h.gateway.status();
  assert.equal(status.connected, true);
  assert.equal(status.version, "2.4.2");
  assert.equal(status.url, h.fake.url);
  assert.equal(status.error, undefined);
});

test("connect adopts a registered service without starting anything", async (t) => {
  const h = await harness(t, { autoStart: true });
  const status = await h.gateway.connect();
  assert.equal(status.connected, true);
  assert.equal(h.ensureCalls.length, 0);
});

test("connect with nothing registered and autoStart off reports a transient OPENCODE_UNAVAILABLE", async (t) => {
  const h = await harness(t, { registerFake: false });
  const status = await h.gateway.connect();
  assert.equal(status.connected, false);
  const info = status.error;
  assert.ok(info !== undefined);
  assert.equal(info.code, "OPENCODE_UNAVAILABLE");
  assert.equal(info.transient, true);
  assert.equal(h.ensureCalls.length, 0);
});

test("connect starts a service only with no version requirement and the Windows command", async (t) => {
  const h = await harness(t, {
    autoStart: true,
    registerFake: false,
    seams: { platform: "win32", comspec: "C:\\WINDOWS\\system32\\cmd.exe" },
  });
  const status = await h.gateway.connect();
  assert.equal(status.connected, true);
  assert.equal(h.ensureCalls.length, 1);
  const options = h.ensureCalls[0] as Record<string, unknown>;
  assert.equal(options["file"], h.file);
  assert.equal("version" in options, false, "a version requirement would let ensure() replace a service");
  assert.deepEqual(options["command"], ["C:\\WINDOWS\\system32\\cmd.exe", "/d", "/c", "opencode", "serve", "--service", "--port", "0"]);
  assert.equal(typeof options["onStart"], "function");
});

test("connect does not start a second service while the registered pid is alive", async (t) => {
  // Registration names a live process (this test) that does not answer: starting would make ensure() terminate it.
  const h = await harness(t, { autoStart: true, registerFake: false });
  writeRegistration(h.dir, { url: "http://127.0.0.1:9", pid: process.pid });
  const status = await h.gateway.connect();
  assert.equal(status.connected, false);
  assert.equal(h.ensureCalls.length, 0);
  assert.match(status.error?.message ?? "", new RegExp(`pid ${process.pid}`));
});

test("a 401 from a session route is OPENCODE_AUTH, not transient, and drops the endpoint for rediscovery", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/session/ses_nexustest0001", (c: RouteContext) =>
    c.json(401, { _tag: "UnauthorizedError", message: "Unauthorized" }),
  );
  await assert.rejects(h.gateway.getSession("ses_nexustest0001"), (error: unknown) => {
    const info = expectNexus(error, "OPENCODE_AUTH");
    assert.equal(info.transient, false);
    assert.equal(info.status, 401);
    return true;
  });
  // The credentials may have changed: the endpoint is dropped, and the next call discovers it again.
  assert.ok(h.logger.records.some((record) => record.message.includes("endpoint lost")));
  assert.equal((await h.gateway.status()).connected, true);
});

test("a 401 on discovery looks like no service: connect reports it unavailable and starts nothing", async (t) => {
  // Finding: discover() treats a non-200 /api/info as "not registered", so the cause is not reported as AUTH.
  const h = await harness(t, { autoStart: true });
  h.fake.route("GET /api/info", (c) => c.json(401, { _tag: "UnauthorizedError", message: "Unauthorized" }));
  const status = await h.gateway.connect();
  assert.equal(status.connected, false);
  assert.equal(status.error?.code, "OPENCODE_UNAVAILABLE");
  assert.equal(h.ensureCalls.length, 0);
});

test("404 on getSession means null, and removing or cancelling a missing object is already done", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/session/ses_missing", (c) => c.json(404, { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "gone" }));
  h.fake.route("GET /api/session/active", (c) => c.json(200, { data: {} }));
  h.fake.route("DELETE /api/session/ses_missing", (c) => c.json(404, { _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "gone" }));
  h.fake.route("DELETE /api/session/ses_missing/form/frm_1", (c) =>
    c.json(404, { _tag: "FormNotFoundError", message: "gone" }),
  );
  assert.equal(await h.gateway.getSession("ses_missing"), null);
  await h.gateway.removeSession("ses_missing");
  await h.gateway.cancelForm("ses_missing", "frm_1");
});

test("404 on createSession is NOT_FOUND and is not swallowed", async (t) => {
  const h = await harness(t);
  h.fake.route("POST /api/session", (c) => c.json(404, { _tag: "LocationNotFoundError", message: "no folder" }));
  await assert.rejects(h.gateway.createSession(CREATE_INPUT), (error: unknown) => {
    expectNexus(error, "NOT_FOUND");
    return true;
  });
});

test("network down after discovery is a transient failure, and the next call rediscovers the new port", async (t) => {
  const h = await harness(t);
  assert.equal((await h.gateway.status()).connected, true);

  await h.fake.close();
  await assert.rejects(h.gateway.getSession("ses_x"), (error: unknown) => {
    const info = expectNexus(error, "OPENCODE_UNAVAILABLE");
    assert.equal(info.transient, true);
    return true;
  });
  assert.ok(h.logger.records.some((record) => record.message.includes("endpoint lost")));

  // The service restarts on another port: the registration changes, and the gateway follows it.
  const restarted = await startFakeOpenCode();
  t.after(() => restarted.close());
  writeRegistration(h.dir, { url: restarted.url, pid: process.pid });
  const status = await h.gateway.status();
  assert.equal(status.connected, true);
  assert.equal(status.url, restarted.url);
});

test("network down with nothing registered reports OPENCODE_UNAVAILABLE in status", async (t) => {
  const h = await harness(t, { registerFake: false });
  const status = await h.gateway.status();
  assert.equal(status.connected, false);
  assert.equal(status.error?.code, "OPENCODE_UNAVAILABLE");
  assert.equal(status.error?.transient, true);
});

test("listModels retries while the result is empty, then maps the models", async (t) => {
  const h = await harness(t);
  const model = {
    id: "deepseek-v4.1-flash",
    modelID: "deepseek-v4.1-flash",
    providerID: "opencode-go",
    name: "DeepSeek V4.1 Flash",
    enabled: true,
    status: "active",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "low" }, { id: "high" }],
  };
  let calls = 0;
  h.fake.route("GET /api/model", (c) => {
    calls += 1;
    c.json(200, { location: { directory: c.request.query.get("location[directory]") }, data: calls === 1 ? [] : [model] });
  });
  const models = await h.gateway.listModels("C:\\tmp\\work");
  const modelRequests = h.fake.requests.filter((r) => r.path === "/api/model");
  assert.equal(modelRequests.length, 2);
  assert.equal(modelRequests[0]?.query.get("location[directory]"), "C:\\tmp\\work");
  assert.equal(calls, 2);
  assert.deepEqual(h.sleeps, [1]);
  assert.deepEqual(models, [
    {
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      enabled: true,
      variants: ["low", "high"],
      supportsTools: true,
    },
  ]);
});

test("listModels gives up after its attempts and returns an empty list", async (t) => {
  const h = await harness(t, { modelListAttempts: 3 });
  h.fake.route("GET /api/model", (c) => c.json(200, { location: {}, data: [] }));
  assert.deepEqual(await h.gateway.listModels("C:\\tmp\\work"), []);
  assert.deepEqual(h.sleeps, [1, 2]);
});

test("listModels also retries while a required provider is missing from a partial catalog", async (t) => {
  const h = await harness(t);
  const partial = { id: "zen-model", modelID: "zen-model", providerID: "opencode", name: "Zen", enabled: true, status: "active", capabilities: { tools: true, input: [], output: [] }, variants: [] };
  const go = { ...partial, id: "deepseek-v4.1-flash", modelID: "deepseek-v4.1-flash", providerID: "opencode-go", name: "DeepSeek" };
  let calls = 0;
  h.fake.route("GET /api/model", (c) => {
    calls += 1;
    c.json(200, { location: {}, data: calls === 1 ? [partial] : [partial, go] });
  });
  const gateway = createOpenCodeGateway({
    logger: h.logger,
    autoStart: false,
    registrationFile: h.file,
    requiredProviders: ["opencode-go"],
    modelListRetryDelayMs: 1,
    seams: h.seams,
  });
  const models = await gateway.listModels("C:\tmp\work");
  assert.equal(calls, 2);
  assert.deepEqual(h.sleeps, [1]);
  assert.deepEqual(models.map((m) => m.providerID), ["opencode", "opencode-go"]);
  assert.ok(h.logger.records.some((r) => r.level === "warn" && r.message.includes("incomplete")));
});

test("createSession sends an explicit model, the location and the permissions, and repeats safely", async (t) => {
  const h = await harness(t);
  h.fake.route("POST /api/session", (c) => c.json(200, { data: sessionBody(CREATE_INPUT.id) }));
  await h.gateway.createSession(CREATE_INPUT);
  await h.gateway.createSession(CREATE_INPUT);
  const posts = h.fake.requests.filter((r) => r.method === "POST" && r.path === "/api/session");
  assert.equal(posts.length, 2);
  const body = posts[0]?.body as Record<string, unknown>;
  assert.equal(body["id"], CREATE_INPUT.id);
  assert.deepEqual(body["model"], { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "low" });
  assert.deepEqual(body["location"], { directory: "C:\\tmp\\work" });
  assert.deepEqual(body["permissions"], CREATE_INPUT.permissions);
  assert.equal(body["agent"], "plan");
});

test("prompt sends the message id so that a retry is idempotent", async (t) => {
  const h = await harness(t);
  h.fake.route("POST /api/session/ses_nexustest0001/prompt", (c) =>
    c.json(200, { data: { id: "msg_nexustest0001", sessionID: "ses_nexustest0001", type: "user", delivery: "steer" } }),
  );
  await h.gateway.prompt({ sessionId: "ses_nexustest0001", messageId: "msg_nexustest0001", text: "hi" });
  await h.gateway.prompt({ sessionId: "ses_nexustest0001", messageId: "msg_nexustest0001", text: "hi" });
  const posts = h.fake.requests.filter((r) => r.path.endsWith("/prompt"));
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1]?.body, { id: "msg_nexustest0001", text: "hi" });
});

test("getOutput returns the last assistant text after the prompt, from the fixture messages", async (t) => {
  const h = await harness(t);
  const messages = fixture<unknown[]>("messages.completed.json");
  h.fake.route("GET /api/session/ses_nexustest0001/message", (c) => {
    const ordered = c.request.query.get("order") === "desc" ? [...messages].reverse() : messages;
    c.json(200, { data: ordered, cursor: { previous: null, next: null } });
  });
  const output = await h.gateway.getOutput("ses_nexustest0001", "msg_nexusprobemwydma5h");
  assert.deepEqual(output, { text: "alpha", promptDelivered: true });
});

test("getOutput follows cursors and does not send order together with a cursor", async (t) => {
  const h = await harness(t);
  const messages = fixture<Array<{ id: string }>>("messages.completed.json");
  const newestFirst = [...messages].reverse();
  h.fake.route("GET /api/session/ses_nexustest0001/message", (c) => {
    if (c.request.query.get("cursor") === "page2") {
      c.json(200, { data: newestFirst.slice(2), cursor: { previous: null, next: null } });
      return;
    }
    c.json(200, { data: newestFirst.slice(0, 2), cursor: { previous: null, next: "page2" } });
  });
  const output = await h.gateway.getOutput("ses_nexustest0001", "msg_nexusprobemwydma5h");
  assert.equal(output.text, "alpha");
  const pages = h.fake.requests.filter((r) => r.path.endsWith("/message"));
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.query.get("order"), "desc");
  assert.equal(pages[1]?.query.get("order"), null);
  assert.equal(pages[1]?.query.get("cursor"), "page2");
});

test("getOutput says the prompt was not delivered while it is absent from the session", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/session/ses_nexustest0001/message", (c) =>
    c.json(200, { data: [], cursor: { previous: null, next: null } }),
  );
  assert.deepEqual(await h.gateway.getOutput("ses_nexustest0001", "msg_missing"), { text: "", promptDelivered: false });
});

test("getOutput maps a failed run to EXECUTION_FAILED with the provider status", async (t) => {
  const h = await harness(t);
  const messages = fixture<Array<Record<string, unknown>>>("messages.completed.json");
  const failed = messages.map((m) =>
    m["type"] === "idle"
      ? { ...m, outcome: "failed", error: { type: "ProviderError", message: "rate limited", status: 429 } }
      : m,
  );
  h.fake.route("GET /api/session/ses_nexustest0001/message", (c) =>
    c.json(200, { data: [...failed].reverse(), cursor: { previous: null, next: null } }),
  );
  const output = await h.gateway.getOutput("ses_nexustest0001", "msg_nexusprobemwydma5h");
  assert.equal(output.error?.code, "EXECUTION_FAILED");
  assert.equal(output.error?.transient, true);
  assert.equal(output.error?.status, 429);
});

test("getSession maps usage and the active flag", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/session/ses_nexustest0001", (c) =>
    c.json(200, {
      data: sessionBody("ses_nexustest0001", {
        cost: 0.5,
        outcome: "succeeded",
        metadata: { nexusTaskId: "tsk_1" },
        tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      }),
    }),
  );
  h.fake.route("GET /api/session/active", (c) => c.json(200, { data: { ses_nexustest0001: { type: "running" } } }));
  const snapshot = await h.gateway.getSession("ses_nexustest0001");
  assert.deepEqual(snapshot, {
    id: "ses_nexustest0001",
    directory: "C:\\tmp\\work",
    outcome: "succeeded",
    active: true,
    metadata: { nexusTaskId: "tsk_1" },
    usage: {
      tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      reportedCost: 0.5,
    },
  });
});

test("listSessions follows the cursor and marks the active ones", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/session", (c) => {
    if (c.request.query.get("cursor") === "p2") {
      c.json(200, { data: [sessionBody("ses_second0000001")], cursor: { previous: null, next: null } });
      return;
    }
    c.json(200, { data: [sessionBody("ses_first00000001")], cursor: { previous: null, next: "p2" } });
  });
  h.fake.route("GET /api/session/active", (c) => c.json(200, { data: { ses_second0000001: { type: "running" } } }));
  const sessions = await h.gateway.listSessions("C:\\tmp\\work");
  assert.deepEqual(sessions.map((s) => [s.id, s.active]), [
    ["ses_first00000001", false],
    ["ses_second0000001", true],
  ]);
  const listed = h.fake.requests.filter((r) => r.method === "GET" && r.path === "/api/session");
  assert.equal(listed.length, 2);
  assert.equal(listed[0]?.query.get("directory"), "C:\\tmp\\work");
});

test("interrupt returns the flag reported by OpenCode", async (t) => {
  const h = await harness(t);
  h.fake.route("POST /api/session/ses_nexustest0001/interrupt", (c) => c.json(200, { interrupted: false }));
  assert.equal(await h.gateway.interrupt("ses_nexustest0001"), false);
});

test("getDiff maps file diffs to file changes", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/session/ses_nexustest0001/diff", (c) =>
    c.json(200, { data: [{ file: "src/a.ts", patch: "", additions: 2, deletions: 1, status: "modified" }] }),
  );
  assert.deepEqual(await h.gateway.getDiff("ses_nexustest0001"), [
    { path: "src/a.ts", status: "modified", additions: 2, deletions: 1 },
  ]);
});

test("replyPermission sends the decision and the message", async (t) => {
  const h = await harness(t);
  h.fake.route("POST /api/session/ses_nexustest0001/permission/per_1/reply", (c) => c.empty(204));
  await h.gateway.replyPermission("ses_nexustest0001", "per_1", "reject", "not allowed");
  const reply = h.fake.requests.find((r) => r.path.endsWith("/reply"));
  assert.deepEqual(reply?.body, { decision: "reject", message: "not allowed" });
});

test("cancelForm sends the form path and tolerates an already settled form", async (t) => {
  const h = await harness(t);
  h.fake.route("DELETE /api/session/ses_nexustest0001/form/frm_1", (c) =>
    c.json(409, { _tag: "FormAlreadySettledError", message: "settled" }),
  );
  await h.gateway.cancelForm("ses_nexustest0001", "frm_1");
  assert.equal(h.fake.requests.filter((r) => r.path.endsWith("/form/frm_1")).length, 1);
});

test("a declared UnknownError (500) is transient OPENCODE_API", async (t) => {
  const h = await harness(t);
  // session.diff declares 500 (UnknownError) in the fixture; session.get does not.
  h.fake.route("GET /api/session/ses_nexustest0001/diff", (c) => c.json(500, { _tag: "UnknownError", message: "boom" }));
  await assert.rejects(h.gateway.getDiff("ses_nexustest0001"), (error: unknown) => {
    const info = expectNexus(error, "OPENCODE_API");
    assert.equal(info.transient, true);
    return true;
  });
});

test("a request without an answer is aborted at the call deadline and fails transiently", async (t) => {
  const scheduler = fakeScheduler();
  const h = await harness(t, { seams: { scheduler } });
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  h.fake.route("GET /api/session/ses_slow", () => {
    arrived(); // never answers
  });
  const pending = h.gateway.getSession("ses_slow");
  await reached; // the deadline is armed before the request is sent
  assert.equal(scheduler.pending().length, 1);
  scheduler.fireLast();
  await assert.rejects(pending, (error: unknown) => {
    const info = expectNexus(error, "OPENCODE_UNAVAILABLE");
    assert.equal(info.transient, true);
    assert.match(info.message, /did not answer within/);
    return true;
  });
  assert.ok(h.logger.records.some((record) => record.message.includes("endpoint lost")));
});

test("a bare 404 from a foreign endpoint is an error, never a missing session", async (t) => {
  const h = await harness(t);
  h.fake.route("GET /api/session/ses_foreign", (c) => c.text(404, "<html>not OpenCode</html>"));
  await assert.rejects(h.gateway.getSession("ses_foreign"), (error: unknown) => {
    const info = expectNexus(error, "OPENCODE_API");
    assert.equal(info.transient, false);
    return true;
  });
});

test("concurrent connect() calls share one start", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const starts: unknown[] = [];
  const h = await harness(t, {
    autoStart: true,
    registerFake: false,
    seams: {
      ensure: async (options) => {
        starts.push(options);
        await gate;
        return { url: h.fake.url };
      },
    },
  });
  const first = h.gateway.connect();
  const second = h.gateway.connect();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.connected, true);
  assert.equal(b.connected, true);
  assert.equal(starts.length, 1, "a second caller must not start a second service");
});

test("concurrent calls after a loss share one discovery", async (t) => {
  let discoveries = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = await harness(t, {
    seams: {
      discover: async () => {
        discoveries += 1;
        await gate;
        return { url: h.fake.url };
      },
    },
  });
  const calls = Promise.all([h.gateway.status(), h.gateway.status(), h.gateway.status()]);
  release();
  const results = await calls;
  assert.equal(discoveries, 1);
  assert.ok(results.every((result) => result.connected));
});

test("cancelForm does not swallow a busy session: only the declared already-settled form counts as done", async (t) => {
  const h = await harness(t);
  h.fake.route("DELETE /api/session/ses_busy/form/frm_2", (c) => c.json(409, { _tag: "SessionBusyError", message: "busy" }));
  await assert.rejects(h.gateway.cancelForm("ses_busy", "frm_2"), (error: unknown) => {
    const info = expectNexus(error, "OPENCODE_API");
    assert.equal(info.status, 409);
    assert.equal(info.transient, true);
    return true;
  });
});
