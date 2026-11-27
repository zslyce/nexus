import { test } from "node:test";
import assert from "node:assert/strict";
import { NexusError } from "../../src/contracts/index.ts";
import { AGENT_NAME_PATTERN, MODEL_PATTERN } from "../../src/config/schema.ts";
import {
  CATCH_ALL_DENY,
  globMatch,
  isGeneratedFile,
  MODEL_FORMAT,
  renderAgentFile,
  validateDefinition,
  verifyRendered,
  withCatchAllDeny,
} from "../../src/agents/definitions.ts";
import { parseFrontmatter, splitFrontmatter } from "../../src/agents/markdown.ts";
import { DEVELOPER_PERMISSIONS, EXPLORER_PERMISSIONS, makeAgent } from "./agents-fixtures.ts";

const PROVIDERS = ["opencode-go"];

function codeOf(run: () => unknown): { code: string; message: string } | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
    return { code: error.info.code, message: error.info.message };
  }
}

test("the model format mirrors the config schema", () => {
  assert.equal(MODEL_FORMAT.source, MODEL_PATTERN.source);
  assert.equal(AGENT_NAME_PATTERN.source, /^[a-z0-9][a-z0-9-]{0,63}$/.source);
});

test("well-formed models from an allowed provider are accepted, with or without a variant", () => {
  for (const model of ["opencode-go/mimo-v2.6-flash", "opencode-go/deepseek-v4.1-flash#high", "opencode-go/gpt-6-luna#medium"]) {
    assert.equal(codeOf(() => validateDefinition(makeAgent({ name: "explorer", model }), PROVIDERS)), undefined, model);
  }
});

test("models outside the allowed providers are rejected with PROVIDER_NOT_ALLOWED", () => {
  for (const model of ["opencode/big-pickle", "anthropic/claude-haiku", "openai/gpt"]) {
    const error = codeOf(() => validateDefinition(makeAgent({ name: "explorer", model }), PROVIDERS));
    assert.equal(error?.code, "PROVIDER_NOT_ALLOWED", model);
    assert.ok(error?.message.includes("agents.explorer.model"));
  }
});

test("malformed models are rejected with VALIDATION", () => {
  for (const model of ["mimo-v2.6-flash", "opencode-go/", "opencode-go/x#", "opencode-go/x#a#b", "opencode-go/x y", "/x", ""]) {
    const error = codeOf(() => validateDefinition(makeAgent({ name: "explorer", model }), PROVIDERS));
    assert.equal(error?.code, "VALIDATION", JSON.stringify(model));
  }
});

test("a read-only agent that allows edit, write or shell is rejected, whatever the rule shape", () => {
  const cases: [string, "allow" | "ask"][] = [
    ["edit", "allow"],
    ["write", "allow"],
    ["shell", "ask"],
    ["*", "allow"],
    ["e*", "allow"],
    ["?hell", "allow"],
  ];
  for (const [action, effect] of cases) {
    const permissions = [
      { action: "*", resource: "*", effect: "deny" as const },
      { action, resource: "*", effect },
    ];
    const error = codeOf(() => validateDefinition(makeAgent({ name: "explorer", permissions }), PROVIDERS));
    assert.equal(error?.code, "VALIDATION", `${action} ${effect}`);
    assert.ok(error?.message.includes("agents.explorer.permissions[1]"), error?.message);
  }
});

test("a read-only agent may restrict edit and shell, and may allow read, glob and grep", () => {
  const permissions = [
    ...EXPLORER_PERMISSIONS,
    { action: "edit", resource: "*", effect: "deny" as const },
    { action: "shell", resource: "*", effect: "deny" as const },
  ];
  assert.deepEqual(validateDefinition(makeAgent({ name: "explorer", permissions }), PROVIDERS), []);
});

test("a writable agent without an edit grant gets a warning, not an error", () => {
  const warnings = validateDefinition(
    makeAgent({ name: "developer", canWrite: true, permissions: [{ action: "*", resource: "*", effect: "deny" }] }),
    PROVIDERS,
  );
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes("canWrite is true"));
  assert.deepEqual(validateDefinition(makeAgent({ name: "developer", canWrite: true, permissions: DEVELOPER_PERMISSIONS }), PROVIDERS), []);
});

test("empty descriptions, empty prompts and bad numbers are rejected with the key named", () => {
  const cases: [Partial<ReturnType<typeof makeAgent>>, string][] = [
    [{ description: "   " }, "agents.explorer.description"],
    [{ systemPrompt: "" }, "agents.explorer.systemPrompt"],
    [{ steps: 0 }, "agents.explorer.steps"],
    [{ timeoutMs: 1.5 }, "agents.explorer.timeoutMs"],
    [{ maxConcurrency: -1 }, "agents.explorer.maxConcurrency"],
    [{ opencodeId: "explorer" }, "agents.explorer.opencodeId"],
  ];
  for (const [overrides, key] of cases) {
    const error = codeOf(() => validateDefinition(makeAgent({ name: "explorer", ...overrides }), PROVIDERS));
    assert.equal(error?.code, "VALIDATION");
    assert.ok(error?.message.includes(key), `${error?.message} should name ${key}`);
  }
});

test("names that are not filename-safe are rejected", () => {
  for (const name of ["Explorer", "../x", "a b", "-lead", "x".repeat(65)]) {
    const error = codeOf(() => validateDefinition(makeAgent({ name }), PROVIDERS));
    assert.equal(error?.code, "VALIDATION", name);
  }
});

test("glob matching: star crosses separators and spaces, question mark is one character, the rest is literal", () => {
  assert.equal(globMatch("*", "anything at all"), true);
  assert.equal(globMatch("npm test*", "npm test && del x"), true);
  assert.equal(globMatch("npm test*", "npm run x"), false);
  assert.equal(globMatch("a.b", "aXb"), false);
  assert.equal(globMatch("a.b", "a.b"), true);
  assert.equal(globMatch("(x)", "(x)"), true);
  assert.equal(globMatch("?hell", "shell"), true);
  assert.equal(globMatch("?hell", "hell"), false);
});

test("the rendered file carries the marker, the frontmatter and the prompt, and parses back exactly", () => {
  const agent = makeAgent({ name: "developer", canWrite: true, permissions: DEVELOPER_PERMISSIONS, model: "opencode-go/deepseek-v4.1-flash#high", steps: 60 });
  const text = renderAgentFile(agent);
  assert.ok(text.startsWith("---\n# nexus:generated"), text);
  assert.equal(isGeneratedFile(text), true);
  const parts = splitFrontmatter(text);
  const fields = parseFrontmatter(parts.frontmatter);
  assert.equal(fields["mode"], "subagent");
  assert.equal(fields["model"], "opencode-go/deepseek-v4.1-flash#high");
  assert.equal(fields["steps"], 60);
  assert.deepEqual(fields["permissions"], DEVELOPER_PERMISSIONS);
  assert.equal(parts.body.trim(), agent.systemPrompt);
  verifyRendered(agent, text);
});

test("rendering is stable: the same definition gives the same bytes", () => {
  const agent = makeAgent({ name: "explorer" });
  assert.equal(renderAgentFile(agent), renderAgentFile(agent));
});

test("awkward descriptions and prompts survive the round trip", () => {
  const agent = makeAgent({
    name: "critic",
    description: 'Reviews: "quoted", it\'s #1 & more\nsecond line with --- and * and [brackets]',
    systemPrompt: "First line.\n---\nA fenced-looking line above.\n```\ncode\n```",
  });
  verifyRendered(agent, renderAgentFile(agent));
});

test("verifyRendered reports any altered permission", () => {
  const agent = makeAgent({ name: "explorer" });
  const text = renderAgentFile(agent);
  const tampered = text.replace("effect: allow", "effect: deny");
  const error = codeOf(() => verifyRendered(agent, tampered));
  assert.equal(error?.code, "INTERNAL");
  assert.ok(error?.message.includes("permissions"), error?.message);
});

test("verifyRendered rejects text that is not a generated agent file", () => {
  const agent = makeAgent({ name: "explorer" });
  assert.equal(codeOf(() => verifyRendered(agent, "no frontmatter here"))?.code, "INTERNAL");
  assert.equal(codeOf(() => verifyRendered(agent, "---\nunterminated: true\n"))?.code, "INTERNAL");
});

test("only a first-line frontmatter block whose first field is the marker counts as generated", () => {
  assert.equal(isGeneratedFile("---\n# nexus:generated x\n---\nbody"), true);
  assert.equal(isGeneratedFile("---\r\n# nexus:generated x\r\n---\r\nbody"), true);
  assert.equal(isGeneratedFile("﻿---\n# nexus:generated x\n---\n"), true);
  assert.equal(isGeneratedFile("# nexus:generated\n---\n"), false, "marker must be inside the frontmatter");
  assert.equal(isGeneratedFile("---\ndescription: mine\n# nexus:generated\n---\n"), false, "marker must be the first line");
  assert.equal(isGeneratedFile("---\ndescription: hand written\n---\n"), false);
  assert.equal(isGeneratedFile(""), false);
});

test("withCatchAllDeny puts the catch-all deny first, without duplicating it", () => {
  const bare = [{ action: "read", resource: "*", effect: "allow" as const }];
  const closed = withCatchAllDeny(bare);
  assert.deepEqual(closed, [CATCH_ALL_DENY, ...bare]);
  assert.deepEqual(withCatchAllDeny(closed), closed, "idempotent");
  assert.deepEqual(withCatchAllDeny(EXPLORER_PERMISSIONS), EXPLORER_PERMISSIONS, "already first: unchanged");
  const copy = withCatchAllDeny(bare);
  copy[1]!.effect = "deny";
  assert.equal(bare[0]?.effect, "allow", "the input is not modified");
});

test("a definition without a catch-all deny is generated with one first, so edit and shell stay closed", () => {
  const agent = makeAgent({
    name: "explorer",
    permissions: [{ action: "read", resource: "*", effect: "allow" }],
  });
  const text = renderAgentFile(agent);
  const fields = parseFrontmatter(splitFrontmatter(text).frontmatter);
  assert.deepEqual(fields["permissions"], [CATCH_ALL_DENY, { action: "read", resource: "*", effect: "allow" }]);
  verifyRendered(agent, text);
});

test("a definition that already starts with the catch-all is not given a second one", () => {
  const agent = makeAgent({ name: "explorer" });
  const fields = parseFrontmatter(splitFrontmatter(renderAgentFile(agent)).frontmatter);
  const permissions = fields["permissions"] as unknown[];
  assert.equal(permissions.length, EXPLORER_PERMISSIONS.length);
});

test("a read-only agent may allow or ask only read, glob and grep, in any letter case", () => {
  for (const action of ["read", "Read", "READ", "glob", "Grep", "grep"]) {
    const permissions = [CATCH_ALL_DENY, { action, resource: "*", effect: "allow" as const }];
    assert.equal(codeOf(() => validateDefinition(makeAgent({ name: "explorer", permissions }), PROVIDERS)), undefined, action);
  }
  const asked = [CATCH_ALL_DENY, { action: "read", resource: "*", effect: "ask" as const }];
  assert.equal(codeOf(() => validateDefinition(makeAgent({ name: "explorer", permissions: asked }), PROVIDERS)), undefined);
});

test("a read-only agent that allows any other action, in any case or through a wildcard, is refused", () => {
  const actions = ["Edit", "EDIT", "edit", "Shell", "write", "WRITE", "task", "*", "r*", "?ead", "rea?", "read*"];
  for (const action of actions) {
    const permissions = [CATCH_ALL_DENY, { action, resource: "*", effect: "allow" as const }];
    const error = codeOf(() => validateDefinition(makeAgent({ name: "explorer", permissions }), PROVIDERS));
    assert.equal(error?.code, "VALIDATION", action);
    assert.ok(error?.message.includes("read, glob, grep"), error?.message);
  }
});

test("the read-only check ignores the resource: a limited edit grant is still refused", () => {
  const permissions = [CATCH_ALL_DENY, { action: "edit", resource: "src/*.ts", effect: "allow" as const }];
  assert.equal(codeOf(() => validateDefinition(makeAgent({ name: "explorer", permissions }), PROVIDERS))?.code, "VALIDATION");
});

test("glob matching ignores letter case", () => {
  assert.equal(globMatch("EDIT", "edit"), true);
  assert.equal(globMatch("npm TEST*", "npm test && x"), true);
  assert.equal(globMatch("Read", "read"), true);
});
