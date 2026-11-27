/**
 * Startup of a service (R7). Requires NEXUS_INTEGRATION=1 and runs on Windows only (the process listing is
 * PowerShell). The service is started with an ISOLATED registration file and XDG directories inside a
 * temporary folder, so it never touches the user's registration, database, configuration or credentials.
 *
 * Fail closed: the processes to terminate are the DESCENDANTS of this test process that are `cmd.exe` or
 * `opencode.exe`, which is how `ensure()` starts a service. They are found whether or not the service
 * honoured the isolated registration. The user's service is never a descendant of this test, and its pid
 * (read from the user's registration, never signalled) is excluded explicitly. The user's registration
 * file must be byte-identical before and after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/contracts/common.ts";
import { createOpenCodeGateway } from "../../src/server/index.ts";
import { readRegisteredPid } from "../../src/server/server-manager.ts";

const enabled = process.env["NEXUS_INTEGRATION"] === "1" && process.platform === "win32";
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const STARTED_NAMES = new Set(["cmd.exe", "opencode.exe"]);

/** OpenCode's default registration file (same rule as the client: XDG state directory). */
function userRegistrationFile(): string {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "service.json");
}

function digest(file: string): string {
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "absent";
}

interface ProcessRow {
  readonly pid: number;
  readonly parent: number;
  readonly name: string;
}

/** Read-only listing of every process (id, parent id and image name). */
function processTable(): Promise<ProcessRow[]> {
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      const parsed: unknown = JSON.parse(stdout);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      resolve(
        rows.flatMap((row: unknown) => {
          if (typeof row !== "object" || row === null) return [];
          const r = row as Record<string, unknown>;
          if (typeof r["ProcessId"] !== "number" || typeof r["ParentProcessId"] !== "number" || typeof r["Name"] !== "string") return [];
          return [{ pid: r["ProcessId"], parent: r["ParentProcessId"], name: r["Name"] }];
        }),
      );
    });
  });
}

/** Every descendant of `root`, transitively. */
function descendantsOf(rows: readonly ProcessRow[], root: number): ProcessRow[] {
  const found: ProcessRow[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift() as number;
    for (const row of rows) {
      if (row.parent === parent && !found.some((f) => f.pid === row.pid)) {
        found.push(row);
        queue.push(row.pid);
      }
    }
  }
  return found;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Windows keeps the database files locked for a moment after the process ends. */
async function removeWithRetries(root: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

test("R7: autoStart starts an isolated service and registers it only in the temporary folder", { skip: !enabled, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "nexus-int-startup-"));
  const isolatedFile = join(root, "state", "opencode", "service.json");
  const env = {
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  const userFile = userRegistrationFile();
  const userBefore = digest(userFile);
  const userPid = await readRegisteredPid(userFile); // read only: this pid is never signalled
  let connected: boolean | undefined;
  let failure: unknown;
  let started: ProcessRow[] = [];
  // Captured before the temporary folder is removed: the file lives inside it.
  let registeredInIsolatedFile = false;
  try {
    const gateway = createOpenCodeGateway({ logger: silent, autoStart: true, registrationFile: isolatedFile, env });
    const status = await gateway.connect();
    connected = status.connected;
    if (status.connected) assert.equal(typeof status.version, "string");
  } catch (error) {
    failure = error;
  } finally {
    // Terminate only what this test started. Everything found here is a descendant of this process.
    const rows = await processTable();
    started = descendantsOf(rows, process.pid).filter((row) => STARTED_NAMES.has(row.name.toLowerCase()) && row.pid !== userPid);
    for (const row of started) {
      try {
        process.kill(row.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    for (const row of started) await waitForExit(row.pid, 15_000);
    registeredInIsolatedFile = existsSync(isolatedFile);
    await removeWithRetries(root);
  }

  if (failure !== undefined) throw failure;
  assert.ok(started.length > 0, "the started service must be identifiable as a descendant of this test");
  assert.equal(connected, true, "the service must answer after autoStart");
  assert.equal(registeredInIsolatedFile, true, "the service must register in the isolated file (XDG honoured)");
  assert.equal(digest(userFile), userBefore, "the user's registration file must not change");
});

test("R7: the user's service keeps answering after the isolated check", { skip: !enabled }, async () => {
  const gateway = createOpenCodeGateway({ logger: silent, autoStart: false });
  assert.equal((await gateway.connect()).connected, true);
});
