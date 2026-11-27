import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadConfig } from "../../src/config/index.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("the real nexus.config.json loads without errors", () => {
  const config = loadConfig(repoRoot);
  assert.equal(config.stateDir, join(config.workspace, ".nexus"));
  assert.deepEqual(
    config.agents.map((agent) => agent.name),
    ["explorer", "developer", "critic"],
  );
});

test("the real agents keep the models and limits written in the file", () => {
  const file = JSON.parse(readFileSync(join(repoRoot, "nexus.config.json"), "utf8")) as {
    agents: Record<string, { model: string; canWrite: boolean; steps: number; timeoutMs: number; maxConcurrency: number; from: string }>;
    tasks: { validationCommandPatterns: string[] };
  };
  const config = loadConfig(repoRoot);
  for (const agent of config.agents) {
    const expected = file.agents[agent.name];
    assert.ok(expected, `agent ${agent.name} is in the file`);
    assert.equal(agent.model, expected.model);
    assert.equal(agent.canWrite, expected.canWrite);
    assert.equal(agent.steps, expected.steps);
    assert.equal(agent.timeoutMs, expected.timeoutMs);
    assert.equal(agent.maxConcurrency, expected.maxConcurrency);
    assert.equal(agent.from, expected.from);
    assert.equal(agent.source, "claude-agents");
    assert.equal(agent.opencodeId, `nexus-${agent.name}`);
    assert.equal(agent.description, "");
    assert.equal(agent.systemPrompt, "");
  }
  assert.deepEqual(config.tasks.validationCommandPatterns, file.tasks.validationCommandPatterns);
});
