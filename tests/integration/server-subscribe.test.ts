/**
 * Global event stream of the shared service. Requires NEXUS_INTEGRATION=1.
 * Read-only: it receives events of all the user's sessions and never logs or stores them (only types).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Logger } from "../../src/contracts/common.ts";
import { createOpenCodeGateway } from "../../src/server/index.ts";

const enabled = process.env["NEXUS_INTEGRATION"] === "1";
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const CHILD = fileURLToPath(new URL("./server-subscribe-child.ts", import.meta.url));

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
}

/** Runs the child and waits for it to exit by itself. Killing it after the deadline is a failure. */
function runChild(mode: "abort" | "break", deadlineMs: number): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CHILD, mode], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const deadline = setTimeout(() => {
      child.kill();
      reject(new Error(`the ${mode} child did not exit by itself within ${deadlineMs} ms; a socket or timer stayed open`));
    }, deadlineMs);
    child.on("exit", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - started });
    });
  });
}

test("closing the stream by aborting the signal lets the process exit by itself (R2)", { skip: !enabled, timeout: 60_000 }, async () => {
  const result = await runChild("abort", 30_000);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /first:server\.connected/);
  assert.match(result.stdout, /closed:abort/);
});

test("leaving the loop (return) lets the process exit by itself", { skip: !enabled, timeout: 60_000 }, async () => {
  const result = await runChild("break", 30_000);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /closed:return/);
});

test("a quiet stream survives longer than its silence timeout, because keepalives arrive", { skip: !enabled, timeout: 120_000 }, async () => {
  // OpenCode sends keepalives about every 15 s (observed). With a 20 s watchdog, 40 s must not end the stream.
  // Events of the user's other sessions may arrive meanwhile: they are read and discarded, never stored.
  const gateway = createOpenCodeGateway({ logger: silent, autoStart: false, silenceTimeoutMs: 20_000 });
  const controller = new AbortController();
  let ended: unknown;
  const consumed = (async () => {
    for await (const _event of gateway.subscribe(controller.signal)) {
      // keep reading
    }
  })().catch((error: unknown) => {
    ended = error;
  });
  await new Promise((resolve) => setTimeout(resolve, 40_000));
  assert.equal(ended, undefined, "the stream ended by itself while the service was quiet");
  controller.abort();
  await consumed;
  assert.equal(ended, undefined);
});
