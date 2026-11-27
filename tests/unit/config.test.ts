import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../../src/config/index.ts";
import { NexusError } from "../../src/contracts/index.ts";

const created: string[] = [];

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(options: { config?: unknown; raw?: string; files?: Record<string, string> } = {}): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nexus-config-")));
  created.push(dir);
  if (options.raw !== undefined) {
    writeFileSync(join(dir, "nexus.config.json"), options.raw);
  } else if (options.config !== undefined) {
    writeFileSync(join(dir, "nexus.config.json"), JSON.stringify(options.config));
  }
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), content);
  }
  return dir;
}

function expectNexusError(run: () => unknown, code: string, fragment: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof NexusError, `expected a NexusError, got ${String(error)}`);
    assert.equal(error.info.code, code);
    assert.ok(
      error.info.message.includes(fragment),
      `message "${error.info.message}" should name "${fragment}"`,
    );
    return true;
  });
}

const MD = ".claude/agents/explorer.md";
const explorerFile = { [MD]: "# Explorer\nRead only." };
const validAgent = {
  model: "opencode-go/mimo-v2.6-flash",
  description: "Explores the repository",
  systemPrompt: "Read only.",
};

test("a missing file yields the defaults and no agents", () => {
  const config = loadConfig(makeWorkspace());
  assert.deepEqual(config.agents, []);
  assert.deepEqual(config.opencode, { allowedProviders: ["opencode-go"], autoStart: true });
  assert.deepEqual(config.concurrency, { global: 3 });
  assert.deepEqual(config.tasks, {
    defaultTimeoutMs: 900000,
    maxAttempts: 2,
    backoffBaseMs: 2000,
    backoffMaxMs: 60000,
    permissionPolicy: "reject",
    validationCommandPatterns: [
      "npm test",
      "npm run typecheck",
      "npm run build",
      "node --test",
      "tsc",
      "pytest",
      "go test",
      "cargo test",
    ],
  });
  assert.deepEqual(config.history, { maxTasks: 500, maxAgeDays: 30, maxEventsPerTask: 2000 });
});

test("workspace is the realpath and stateDir is <workspace>/.nexus", () => {
  const dir = makeWorkspace();
  const config = loadConfig(dir);
  assert.equal(config.workspace, dir);
  assert.equal(config.stateDir, join(dir, ".nexus"));
});

test("an agent without from keeps its prompt, is source config and gets the nexus- id", () => {
  const dir = makeWorkspace({ config: { agents: { explorer: validAgent } } });
  const [agent] = loadConfig(dir).agents;
  assert.ok(agent);
  assert.equal(agent.name, "explorer");
  assert.equal(agent.opencodeId, "nexus-explorer");
  assert.equal(agent.description, "Explores the repository");
  assert.equal(agent.systemPrompt, "Read only.");
  assert.equal(agent.source, "config");
  assert.equal(agent.from, undefined);
  assert.equal(agent.model, "opencode-go/mimo-v2.6-flash");
});

test("an agent with from copies the path and may omit description and systemPrompt", () => {
  const dir = makeWorkspace({
    config: { agents: { explorer: { from: MD, model: "opencode-go/mimo-v2.6-flash" } } },
    files: explorerFile,
  });
  const [agent] = loadConfig(dir).agents;
  assert.ok(agent);
  assert.equal(agent.from, MD);
  assert.equal(agent.source, "claude-agents");
  assert.equal(agent.description, "");
  assert.equal(agent.systemPrompt, "");
});

test("from is normalized to a workspace-relative path with forward slashes", () => {
  const dir = makeWorkspace({
    config: { agents: { explorer: { from: "./.claude//agents/explorer.md", model: "opencode-go/mimo-v2.6-flash" } } },
    files: explorerFile,
  });
  assert.equal(loadConfig(dir).agents[0]?.from, MD);
});

test("an agent without from requires description and systemPrompt, and names the key", () => {
  const noDescription = makeWorkspace({
    config: { agents: { explorer: { model: "opencode-go/mimo-v2.6-flash", systemPrompt: "x" } } },
  });
  expectNexusError(() => loadConfig(noDescription), "VALIDATION", "agents.explorer.description");

  const noPrompt = makeWorkspace({
    config: { agents: { explorer: { model: "opencode-go/mimo-v2.6-flash", description: "x" } } },
  });
  expectNexusError(() => loadConfig(noPrompt), "VALIDATION", "agents.explorer.systemPrompt");
});

test("unknown top-level keys are rejected and named", () => {
  const dir = makeWorkspace({ config: { surprise: true } });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "surprise");
});

test("unknown nested keys name their full path", () => {
  const dir = makeWorkspace({ config: { tasks: { bogus: 1 } } });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "tasks");
  expectNexusError(() => loadConfig(dir), "VALIDATION", "bogus");
});

test("workspace and stateDir are derived and cannot be written in the file", () => {
  const dir = makeWorkspace({ config: { workspace: "/elsewhere" } });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "workspace");
  const dir2 = makeWorkspace({ config: { stateDir: "/elsewhere" } });
  expectNexusError(() => loadConfig(dir2), "VALIDATION", "stateDir");
});

test("source cannot be written in an agent", () => {
  const dir = makeWorkspace({ config: { agents: { explorer: { ...validAgent, source: "config" } } } });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "agents.explorer");
});

test("agent names must be filename-safe and the error names the key", () => {
  const dir = makeWorkspace({ config: { agents: { "Bad Name": validAgent } } });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "Bad Name");
});

test("numeric limits must be positive integers and the error names the key", () => {
  const dir = makeWorkspace({ config: { agents: { explorer: { ...validAgent, timeoutMs: 0 } } } });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "agents.explorer.timeoutMs");

  const dir2 = makeWorkspace({ config: { concurrency: { global: 1.5 } } });
  expectNexusError(() => loadConfig(dir2), "VALIDATION", "concurrency.global");
});

test("a model without a provider is rejected and the error names the key", () => {
  const dir = makeWorkspace({ config: { agents: { explorer: { ...validAgent, model: "mimo-v2.6-flash" } } } });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "agents.explorer.model");
});

test("a model from another provider is PROVIDER_NOT_ALLOWED and names the key", () => {
  const dir = makeWorkspace({ config: { agents: { explorer: { ...validAgent, model: "opencode/gpt-6" } } } });
  expectNexusError(() => loadConfig(dir), "PROVIDER_NOT_ALLOWED", "agents.explorer.model");
});

test("allowedProviders cannot include providers other than opencode-go", () => {
  const dir = makeWorkspace({ config: { opencode: { allowedProviders: ["opencode"] } } });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "opencode.allowedProviders");
});

test("backoffMaxMs below backoffBaseMs is rejected and names the key", () => {
  const dir = makeWorkspace({ config: { tasks: { backoffBaseMs: 5000, backoffMaxMs: 1000 } } });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "tasks.backoffMaxMs");
});

test("permissionPolicy accepts only reject or surface", () => {
  const dir = makeWorkspace({ config: { tasks: { permissionPolicy: "always" } } });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "tasks.permissionPolicy");
});

test("a permission effect is validated and the error names its position", () => {
  const dir = makeWorkspace({
    config: { agents: { explorer: { ...validAgent, permissions: [{ action: "read", resource: "*", effect: "yes" }] } } },
  });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "agents.explorer.permissions.0.effect");
});

test("permissions default to deny-all when omitted", () => {
  const dir = makeWorkspace({ config: { agents: { explorer: validAgent } } });
  assert.deepEqual(loadConfig(dir).agents[0]?.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
});

test("a from path outside the workspace is PATH_OUTSIDE_WORKSPACE and names the key", () => {
  const dir = makeWorkspace({ config: { agents: { explorer: { from: "../../explorer.md", model: "opencode-go/mimo-v2.6-flash" } } } });
  expectNexusError(() => loadConfig(dir), "PATH_OUTSIDE_WORKSPACE", "agents.explorer.from");
});

test("an absolute from path outside the workspace is rejected", () => {
  const outside = join(tmpdir(), "nexus-outside", "explorer.md");
  const dir = makeWorkspace({ config: { agents: { explorer: { from: outside, model: "opencode-go/mimo-v2.6-flash" } } } });
  expectNexusError(() => loadConfig(dir), "PATH_OUTSIDE_WORKSPACE", "agents.explorer.from");
});

test("from must be a markdown file inside .claude/agents", () => {
  const notMarkdown = makeWorkspace({
    config: { agents: { explorer: { from: ".claude/agents/explorer.txt", model: "opencode-go/mimo-v2.6-flash" } } },
    files: { ".claude/agents/explorer.txt": "x" },
  });
  expectNexusError(() => loadConfig(notMarkdown), "VALIDATION", "agents.explorer.from");

  const elsewhere = makeWorkspace({
    config: { agents: { explorer: { from: "docs/explorer.md", model: "opencode-go/mimo-v2.6-flash" } } },
    files: { "docs/explorer.md": "x" },
  });
  expectNexusError(() => loadConfig(elsewhere), "VALIDATION", "agents.explorer.from");
});

test("invalid JSON is reported without echoing the file content", () => {
  const dir = makeWorkspace({ raw: '{ "secret": "SAMPLE-TOKEN-VALUE",' });
  assert.throws(
    () => loadConfig(dir),
    (error: unknown) => {
      assert.ok(error instanceof NexusError);
      assert.equal(error.info.code, "VALIDATION");
      assert.ok(error.info.message.includes("nexus.config.json"));
      assert.ok(!error.info.message.includes("SAMPLE-TOKEN-VALUE"));
      return true;
    },
  );
});

test("a UTF-8 byte order mark is accepted", () => {
  const dir = makeWorkspace({ raw: "﻿" + JSON.stringify({ concurrency: { global: 5 } }) });
  assert.equal(loadConfig(dir).concurrency.global, 5);
});

test("a root value that is not an object is rejected", () => {
  const dir = makeWorkspace({ raw: "[1, 2]" });
  expectNexusError(() => loadConfig(dir), "VALIDATION", "(root)");
});

test("a workspace that does not exist is NOT_FOUND", () => {
  expectNexusError(
    () => loadConfig(join(tmpdir(), "nexus-does-not-exist-" + Date.now())),
    "NOT_FOUND",
    "workspace",
  );
});
