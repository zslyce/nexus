import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Endpoint, EnsureOptions } from "@opencode/client/service";
import { NexusError } from "../../src/contracts/common.ts";
import { ServerManager, defaultServiceCommand, readRegisteredPid } from "../../src/server/server-manager.ts";
import { recordingLogger } from "./server-fake-opencode.ts";
import { parseLsofPid, parseNetstatListeningPid } from "../../src/server/process.ts";

const ENDPOINT: Endpoint = { url: "http://127.0.0.1:4096" };

function manager(overrides: { pid?: number; alive?: boolean; command?: readonly string[] } = {}) {
  const calls: EnsureOptions[] = [];
  const instance = new ServerManager({
    registrationFile: "C:\\isolated\\service.json",
    command: overrides.command ?? ["opencode", "serve", "--service", "--port", "0"],
    env: { XDG_STATE_HOME: "C:\\isolated" },
    logger: recordingLogger(),
    readRegisteredPid: async () => overrides.pid,
    isProcessAlive: () => overrides.alive ?? false,
    ensure: async (options) => {
      calls.push(options);
      return ENDPOINT;
    },
  });
  return { instance, calls };
}

test("the Windows command goes through cmd.exe, because the opencode shim is a .cmd file", () => {
  assert.deepEqual(defaultServiceCommand("win32", "C:\\WINDOWS\\system32\\cmd.exe"), [
    "C:\\WINDOWS\\system32\\cmd.exe",
    "/d",
    "/c",
    "opencode",
    "serve",
    "--service",
    "--port",
    "0",
  ]);
  assert.deepEqual(defaultServiceCommand("win32", undefined), ["cmd.exe", "/d", "/c", "opencode", "serve", "--service", "--port", "0"]);
});

test("other platforms run opencode directly", () => {
  assert.deepEqual(defaultServiceCommand("linux", undefined), ["opencode", "serve", "--service", "--port", "0"]);
  assert.deepEqual(defaultServiceCommand("darwin", "/bin/sh"), ["opencode", "serve", "--service", "--port", "0"]);
});

test("start passes the isolated file, the command and the environment, and no version requirement", async () => {
  const { instance, calls } = manager({ command: ["cmd.exe", "/d", "/c", "opencode", "serve", "--service", "--port", "0"] });
  const endpoint = await instance.start();
  assert.deepEqual(endpoint, ENDPOINT);
  assert.equal(calls.length, 1);
  const options = calls[0];
  assert.equal(options?.file, "C:\\isolated\\service.json");
  assert.deepEqual(options?.command, ["cmd.exe", "/d", "/c", "opencode", "serve", "--service", "--port", "0"]);
  assert.deepEqual(options?.env, { XDG_STATE_HOME: "C:\\isolated" });
  assert.equal(options !== undefined && "version" in options, false);
});

test("start refuses while the registered process is alive, so a hung service is never terminated", async () => {
  const { instance, calls } = manager({ pid: 4242, alive: true });
  await assert.rejects(instance.start(), (error: unknown) => {
    assert.ok(error instanceof NexusError);
    assert.equal(error.info.code, "OPENCODE_UNAVAILABLE");
    assert.equal(error.info.transient, true);
    assert.match(error.message, /pid 4242/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("start proceeds when the registered process is gone (a stale registration)", async () => {
  const { instance, calls } = manager({ pid: 4242, alive: false });
  await instance.start();
  assert.equal(calls.length, 1);
});

test("readRegisteredPid reads only the pid and tolerates missing or malformed files", async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-manager-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const valid = join(dir, "valid.json");
  const malformed = join(dir, "malformed.json");
  writeFileSync(valid, JSON.stringify({ id: "x", url: "http://127.0.0.1:1", pid: 777, password: "not-logged" }));
  writeFileSync(malformed, "{ not json");
  assert.equal(await readRegisteredPid(valid), 777);
  assert.equal(await readRegisteredPid(malformed), undefined);
  assert.equal(await readRegisteredPid(join(dir, "missing.json")), undefined);
});

test("concurrent start() calls share one ensure()", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const instance = new ServerManager({
    registrationFile: "C:\isolated\service.json",
    command: ["opencode", "serve", "--service", "--port", "0"],
    env: undefined,
    logger: recordingLogger(),
    readRegisteredPid: async () => undefined,
    ensure: async () => {
      calls += 1;
      await gate;
      return ENDPOINT;
    },
  });
  const first = instance.start();
  const second = instance.start();
  release();
  assert.deepEqual(await Promise.all([first, second]), [ENDPOINT, ENDPOINT]);
  assert.equal(calls, 1);
});

test("a later start() after a finished one starts again (single-flight is not a cache)", async () => {
  let calls = 0;
  const instance = new ServerManager({
    registrationFile: "C:\isolated\service.json",
    command: ["opencode"],
    env: undefined,
    logger: recordingLogger(),
    readRegisteredPid: async () => undefined,
    ensure: async () => {
      calls += 1;
      return ENDPOINT;
    },
  });
  await instance.start();
  await instance.start();
  assert.equal(calls, 2);
});

test("the port owner is read from netstat output (Windows) and lsof output (other platforms)", () => {
  const netstat = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:28894        0.0.0.0:0              LISTENING       37224",
    "  TCP    127.0.0.1:61243        0.0.0.0:0              LISTENING       4242",
    "  TCP    127.0.0.1:61243        127.0.0.1:50000        ESTABLISHED     9999",
  ].join("\r\n");
  assert.equal(parseNetstatListeningPid(netstat, 61243), 4242);
  assert.equal(parseNetstatListeningPid(netstat, 28894), 37224);
  assert.equal(parseNetstatListeningPid(netstat, 1), undefined);
  assert.equal(parseLsofPid("12345\n"), 12345);
  assert.equal(parseLsofPid(""), undefined);
});
