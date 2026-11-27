/**
 * Integration with the shared OpenCode service. Requires NEXUS_INTEGRATION=1.
 * No inference: only queries and session creation/deletion in a temporary folder. The service is never
 * stopped or restarted here, and `connect()` never starts one (autoStart is off).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreateSessionInput, Logger } from "../../src/contracts/index.ts";
import { createOpenCodeGateway } from "../../src/server/index.ts";

const enabled = process.env["NEXUS_INTEGRATION"] === "1";
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** The mandatory session rules of docs/06-security.md. Restrictive only. */
const MANDATORY_PERMISSIONS = [
  { action: "external_directory", resource: "*", effect: "deny" as const },
  { action: "subagent", resource: "*", effect: "deny" as const },
  { action: "question", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*.env", effect: "deny" as const },
  { action: "read", resource: "*.env.*", effect: "deny" as const },
  { action: "read", resource: "*.env.example", effect: "allow" as const },
];

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

test("connect reports the shared service without starting anything", { skip: !enabled }, async () => {
  const gateway = createOpenCodeGateway({ logger: silent, autoStart: false, requiredProviders: ["opencode-go"] });
  const status = await gateway.connect();
  assert.equal(status.connected, true, JSON.stringify(status.error ?? {}));
  assert.equal(typeof status.version, "string");
  assert.equal((await gateway.status()).connected, true);
});

test("the Go models are listed for a temporary folder", { skip: !enabled }, async () => {
  const gateway = createOpenCodeGateway({ logger: silent, autoStart: false, requiredProviders: ["opencode-go"] });
  await gateway.connect();
  const directory = mkdtempSync(join(tmpdir(), "nexus-int-models-"));
  try {
    const models = await gateway.listModels(directory);
    const go = models.filter((model) => model.providerID === "opencode-go");
    assert.ok(go.length > 0, "no opencode-go models: check the existing Go authentication");
    assert.ok(go.some((model) => model.enabled), "no enabled opencode-go model");
    const agents = await gateway.listAgentIds(directory);
    assert.ok(agents.length > 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a session is created, read, repeated, listed and deleted in a temporary folder", { skip: !enabled }, async () => {
  const gateway = createOpenCodeGateway({ logger: silent, autoStart: false, requiredProviders: ["opencode-go"] });
  await gateway.connect();
  const directory = mkdtempSync(join(tmpdir(), "nexus-int-session-"));
  const id = `ses_nexus${randomBytes(8).toString("hex")}`;
  try {
    const models = await gateway.listModels(directory);
    const model = models.find((m) => m.providerID === "opencode-go" && m.id === "deepseek-v4.1-flash")
      ?? models.find((m) => m.providerID === "opencode-go" && m.enabled);
    assert.ok(model, "no opencode-go model to validate against");
    const agents = await gateway.listAgentIds(directory);
    const agent = agents.includes("plan") ? "plan" : agents.find((a) => a !== "build");
    assert.ok(agent, "no agent other than build");

    const input: CreateSessionInput = {
      id,
      directory,
      agent,
      model: { providerID: model.providerID, id: model.id },
      title: "nexus integration (no inference)",
      metadata: { nexusTaskId: "integration-test" },
      permissions: MANDATORY_PERMISSIONS,
    };
    await gateway.createSession(input);
    const created = await gateway.getSession(id);
    assert.ok(created !== null);
    assert.equal(created.id, id);
    assert.ok(samePath(created.directory, resolve(directory)), `directory ${created.directory}`);
    assert.equal(created.active, false);
    assert.equal(created.outcome, undefined);

    // Repeating the creation returns the original session and does not fail.
    await gateway.createSession(input);
    assert.equal((await gateway.getSession(id))?.id, id);

    const listed = await gateway.listSessions(directory);
    assert.ok(listed.some((session) => session.id === id), "the session is listed for its folder");

    await gateway.removeSession(id);
    assert.equal(await gateway.getSession(id), null);
    await gateway.removeSession(id);
  } finally {
    // Idempotent for a session that is already gone. A failure here fails the test: nothing may be left behind.
    await gateway.removeSession(id);
    rmSync(directory, { recursive: true, force: true });
  }
});
