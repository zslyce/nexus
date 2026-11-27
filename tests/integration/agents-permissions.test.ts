/**
 * Agent registry against the shared OpenCode service. Requires NEXUS_INTEGRATION=1. No inference: sessions
 * are created in a temporary folder, only permission checks are asked, and every session is deleted by the
 * test that created it, with the listing checked before and after the deletion.
 *
 * What `permission.create` evaluates: the raw string it is given, against the agent and session rules. It
 * does not show how the real shell, read or edit tools split or name their requests (R3, R4).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import type { AgentDefinition, AgentRegistry, OpenCodeGateway, PermissionRule } from "../../src/contracts/index.ts";
import { loadConfig } from "../../src/config/index.ts";
import { createAgentRegistry } from "../../src/agents/index.ts";
import { createOpenCodeGateway } from "../../src/server/index.ts";
import {
  CHAINED_STRINGS,
  METACHARACTER_PROPOSAL,
  ORDINARY_COMMANDS,
  containsBlock,
  enabled,
  makeWorkspace,
  mandatoryRules,
  modelRefOf,
  rawClient,
  silent,
  waitFor,
} from "./agents-support.ts";

/** Sessions one block of tests created in one folder. `live` holds the ones not deleted yet. */
interface SessionLog {
  readonly directory: string;
  readonly created: string[];
  readonly live: Set<string>;
}

function newSessionLog(directory: string): SessionLog {
  return { directory, created: [], live: new Set() };
}

async function openSession(
  gateway: OpenCodeGateway,
  log: SessionLog,
  agent: AgentDefinition,
  permissions: PermissionRule[],
): Promise<string> {
  const id = `ses_nexus_${randomBytes(8).toString("hex")}`;
  log.created.push(id);
  log.live.add(id);
  await gateway.createSession({
    id,
    directory: log.directory,
    agent: agent.opencodeId,
    model: modelRefOf(agent.model),
    title: "nexus integration (no inference)",
    metadata: { nexusTaskId: "integration-agents" },
    permissions,
  });
  return id;
}

/** Deletes one session, checking that the folder lists it before and no longer lists it after. */
async function deleteSession(gateway: OpenCodeGateway, log: SessionLog, id: string): Promise<void> {
  const listedBefore = (await gateway.listSessions(log.directory)).map((session) => session.id);
  assert.ok(listedBefore.includes(id), `${id} is not listed before deletion`);
  await gateway.removeSession(id);
  log.live.delete(id);
  const listedAfter = (await gateway.listSessions(log.directory)).map((session) => session.id);
  assert.equal(listedAfter.includes(id), false, `${id} is still listed after deletion`);
}

/** Fallback for sessions left open by a failed test. Failures are reported, not thrown. */
async function deleteLeftovers(gateway: OpenCodeGateway | undefined, log: SessionLog): Promise<void> {
  for (const id of [...log.live]) {
    try {
      await gateway?.removeSession(id);
      log.live.delete(id);
    } catch (error) {
      process.stderr.write(`could not delete test session ${id}: ${String((error as { _tag?: string })._tag ?? error)}\n`);
    }
  }
}

/** Effect OpenCode gives to one action on one raw resource string, for the agent in the session. */
async function decide(
  client: OpenCodeClient,
  sessionId: string,
  agent: AgentDefinition,
  action: string,
  resource: string,
): Promise<string> {
  const decision = await client.permission.create({
    sessionID: sessionId,
    action,
    resources: [resource],
    agent: agent.opencodeId,
  });
  return decision.effect;
}

async function connectGateway(): Promise<OpenCodeGateway> {
  const gateway = createOpenCodeGateway({ logger: silent, autoStart: false, requiredProviders: ["opencode-go"] });
  const status = await gateway.connect();
  assert.equal(status.connected, true, `OpenCode is not reachable: ${JSON.stringify(status.error ?? {})}`);
  return gateway;
}

/** Waits until OpenCode lists every given agent for the workspace (the catalog warms up for a few seconds). */
async function waitForAgents(gateway: OpenCodeGateway, workspace: string, ids: readonly string[]): Promise<void> {
  const listed = await waitFor(
    async () => {
      const current = await gateway.listAgentIds(workspace);
      return ids.every((id) => current.includes(id)) ? current : undefined;
    },
    60_000,
    1_000,
  );
  assert.ok(listed, `OpenCode did not list ${ids.join(", ")} in time`);
}

describe("agent registry against the shared OpenCode service", { skip: !enabled, concurrency: false }, () => {
  let workspace = "";
  let registry: AgentRegistry;
  let gateway: OpenCodeGateway | undefined;
  let client: OpenCodeClient;
  let log: SessionLog = newSessionLog("");

  const agentIds = (): string[] => registry.list().map((agent) => agent.opencodeId);
  const agentOf = (name: string): AgentDefinition => {
    const agent = registry.get(name);
    assert.ok(agent, `agent ${name} is not declared`);
    return agent;
  };
  const connected = (): OpenCodeGateway => {
    assert.ok(gateway, "no gateway: the before hook failed");
    return gateway;
  };
  const open = (agent: AgentDefinition, permissions: PermissionRule[]) => openSession(connected(), log, agent, permissions);
  const close = (id: string) => deleteSession(connected(), log, id);

  before(async () => {
    workspace = makeWorkspace();
    log = newSessionLog(workspace);
    registry = createAgentRegistry({ config: loadConfig(workspace), logger: silent });
    gateway = await connectGateway();
    client = await rawClient();

    const result = await registry.sync();
    assert.equal(result.written.length, registry.list().length, JSON.stringify(result));
    await waitForAgents(gateway, workspace, agentIds());
  });

  // Nothing else to release: these tests never call `subscribe` and start no server, so the gateway holds no
  // stream or timer. The only resources are the sessions (deleted above) and the temporary folder (removed here).
  after(async () => {
    await deleteLeftovers(gateway, log);
    if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
  });

  test("after sync, OpenCode lists the three declared agents", async () => {
    const ids = await connected().listAgentIds(workspace);
    assert.deepEqual(agentIds(), ["nexus-explorer", "nexus-developer", "nexus-critic"]);
    for (const id of agentIds()) assert.ok(ids.includes(id), `${id} missing from agent.list`);
  });

  test("OpenCode reports each agent's description, steps and every declared permission in order", async () => {
    const listed = await client.agent.list({ location: { directory: workspace } });
    for (const agent of registry.list()) {
      const info = listed.data.find((candidate) => candidate.id === agent.opencodeId);
      assert.ok(info, `${agent.opencodeId} missing from agent.list`);
      assert.equal(info.description, agent.description, `${agent.name} description`);
      assert.equal(info.steps, agent.steps, `${agent.name} steps`);
      assert.equal(info.mode, "subagent", `${agent.name} mode`);
      assert.ok(
        containsBlock(info.permissions as PermissionRule[], agent.permissions),
        `${agent.name}: declared permissions are not present in order: ${JSON.stringify(info.permissions)}`,
      );
    }
  });

  test("explorer cannot edit or execute, and still reads files but not .env", async () => {
    const explorer = agentOf("explorer");
    const session = await open(explorer, mandatoryRules());
    assert.equal(await decide(client, session, explorer, "edit", "src/index.ts"), "deny");
    assert.equal(await decide(client, session, explorer, "shell", "npm test"), "deny");
    assert.equal(await decide(client, session, explorer, "shell", "node --test"), "deny");
    assert.equal(await decide(client, session, explorer, "shell", "rm -rf x"), "deny");
    // Controls: the same check must allow what the agent is meant to do.
    assert.equal(await decide(client, session, explorer, "read", "src/index.ts"), "allow");
    assert.equal(await decide(client, session, explorer, "grep", "*"), "allow");
    assert.equal(await decide(client, session, explorer, "read", ".env"), "deny");
    await close(session);
  });

  test("developer cannot run commands outside its patterns, and can run its own", async () => {
    const developer = agentOf("developer");
    const session = await open(developer, mandatoryRules());
    assert.equal(await decide(client, session, developer, "shell", "rm -rf x"), "deny");
    assert.equal(await decide(client, session, developer, "shell", "git push"), "deny");
    assert.equal(await decide(client, session, developer, "shell", "curl https://example.com"), "deny");
    // Controls: its own commands and its edit permission still work.
    for (const command of ORDINARY_COMMANDS.slice(0, 3)) {
      assert.equal(await decide(client, session, developer, "shell", command), "allow", command);
    }
    assert.equal(await decide(client, session, developer, "edit", "src/index.ts"), "allow");
    await close(session);
  });

  test("critic cannot edit or execute, and can read", async () => {
    const critic = agentOf("critic");
    const session = await open(critic, mandatoryRules());
    assert.equal(await decide(client, session, critic, "edit", "src/index.ts"), "deny");
    assert.equal(await decide(client, session, critic, "shell", "npm test"), "deny");
    assert.equal(await decide(client, session, critic, "read", "src/index.ts"), "allow");
    await close(session);
  });

  test("the daemon token file .nexus/daemon.json cannot be read or edited by any of the three agents", async () => {
    for (const name of ["explorer", "developer", "critic"]) {
      const agent = agentOf(name);
      const session = await open(agent, mandatoryRules());
      // Both the workspace-relative form and an absolute path are checked. The real resource format is
      // unverified (R3), so a deny for both forms is the minimum this test requires.
      const absolute = join(workspace, ".nexus", "daemon.json");
      for (const resource of [".nexus/daemon.json", absolute]) {
        assert.equal(await decide(client, session, agent, "read", resource), "deny", `${name} read ${resource}`);
        assert.equal(await decide(client, session, agent, "edit", resource), "deny", `${name} edit ${resource}`);
      }
      await close(session);
    }
  });

  // R4 is OPEN. These two tests only record what `permission.create` returns for raw strings. They do not
  // show that the real shell tool runs chained commands (it may split them and check each part), and they
  // do not prove that the proposed metacharacter denies would stop anything in a real run. The policy is
  // not adopted and waits for a decision.
  test("R4 (raw strings, open): under the mandatory rules alone, the developer's prefix patterns allow chained strings", async () => {
    const developer = agentOf("developer");
    const session = await open(developer, mandatoryRules());
    for (const command of CHAINED_STRINGS) {
      assert.equal(await decide(client, session, developer, "shell", command), "allow", command);
    }
    await close(session);
  });

  test("R4 (proposal, NOT ADOPTED, raw strings only): metacharacter denies would block chained strings and keep ordinary ones", async () => {
    const developer = agentOf("developer");
    const session = await open(developer, [...mandatoryRules(), ...METACHARACTER_PROPOSAL]);
    for (const command of CHAINED_STRINGS) {
      assert.equal(await decide(client, session, developer, "shell", command), "deny", command);
    }
    for (const command of ORDINARY_COMMANDS) {
      assert.equal(await decide(client, session, developer, "shell", command), "allow", command);
    }
    assert.equal(await decide(client, session, developer, "edit", "src/index.ts"), "allow");
    await close(session);
  });

  test("every session created by these tests was deleted and none is left in the folder", async () => {
    assert.ok(log.created.length > 0, "the earlier tests created sessions");
    assert.equal(log.live.size, 0, `sessions still open: ${[...log.live].join(", ")}`);
    const listed = (await connected().listSessions(workspace)).map((session) => session.id);
    for (const id of log.created) assert.equal(listed.includes(id), false, `${id} is still listed`);
  });
});

describe("an agent declared without a catch-all deny stays closed", { skip: !enabled, concurrency: false }, () => {
  test("the generated file starts with the catch-all, so edit and shell are denied while read is allowed", async () => {
    const workspace = makeWorkspace({
      agents: {
        explorer: {
          from: ".claude/agents/explorer.md",
          model: "opencode-go/mimo-v2.6-flash",
          // Only a read grant, no catch-all. OpenCode's base ruleset (`* * allow`) would otherwise apply.
          permissions: [{ action: "read", resource: "*", effect: "allow" }],
        },
      },
    });
    const log = newSessionLog(workspace);
    let gateway: OpenCodeGateway | undefined;
    try {
      const registry = createAgentRegistry({ config: loadConfig(workspace), logger: silent });
      const explorer = registry.get("explorer");
      assert.ok(explorer);
      gateway = await connectGateway();
      const client = await rawClient();
      const result = await registry.sync();
      assert.deepEqual(result.written, [".opencode/agents/nexus-explorer.md"], JSON.stringify(result));
      await waitForAgents(gateway, workspace, ["nexus-explorer"]);

      const session = await openSession(gateway, log, explorer, mandatoryRules());
      assert.equal(await decide(client, session, explorer, "edit", "src/index.ts"), "deny");
      assert.equal(await decide(client, session, explorer, "shell", "npm test"), "deny");
      assert.equal(await decide(client, session, explorer, "read", "src/index.ts"), "allow");
      await deleteSession(gateway, log, session);
    } finally {
      await deleteLeftovers(gateway, log);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
