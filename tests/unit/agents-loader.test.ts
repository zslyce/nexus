import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NexusError } from "../../src/contracts/index.ts";
import { MAX_AGENT_SOURCE_BYTES, loadAgentSource } from "../../src/agents/loader.ts";
import { parseFrontmatter, normalizeText, splitFrontmatter } from "../../src/agents/markdown.ts";
import { EXPLORER_SOURCE, captureLogger, makeWorkspace, removeWorkspaces } from "./agents-fixtures.ts";

after(() => removeWorkspaces());

const FROM = ".claude/agents/explorer.md";

function expectError(run: () => unknown, code: string, fragment?: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
    assert.equal(error.info.code, code);
    if (fragment !== undefined) assert.ok(error.info.message.includes(fragment), error.info.message);
    return true;
  });
}

test("splitFrontmatter separates the block from the body and tolerates BOM and CRLF", () => {
  const parts = splitFrontmatter("﻿---\r\ndescription: x\r\n---\r\nBody line.\r\n");
  assert.equal(parts.hasFrontmatter, true);
  assert.equal(parts.frontmatter, "description: x");
  assert.equal(parts.body, "Body line.\n");
});

test("text without a frontmatter block is all body", () => {
  const parts = splitFrontmatter("# Just a prompt\n\n--- not a fence\n");
  assert.equal(parts.hasFrontmatter, false);
  assert.equal(parts.body, "# Just a prompt\n\n--- not a fence\n");
  assert.equal(normalizeText("a\rb"), "a\nb");
});

test("an unclosed frontmatter block is rejected", () => {
  expectError(() => splitFrontmatter("---\ndescription: x\nbody without a closing fence\n"), "VALIDATION", "not closed");
});

test("frontmatter must be a YAML mapping and valid YAML, and its errors do not echo the content", () => {
  assert.deepEqual(parseFrontmatter(""), {});
  assert.deepEqual(parseFrontmatter("# only a comment"), {});
  expectError(() => parseFrontmatter("- a\n- b\n"), "VALIDATION", "mapping");
  expectError(() => parseFrontmatter("description: [unclosed"), "VALIDATION", "not valid YAML");
  try {
    parseFrontmatter("secret: 'sk-do-not-print\n  broken: [");
    assert.fail("expected a parse error");
  } catch (error) {
    assert.ok(error instanceof NexusError);
    assert.equal(error.info.message.includes("sk-do-not-print"), false);
  }
});

test("the description and body are read, the other keys are ignored and reported once", () => {
  const workspace = makeWorkspace({ [FROM]: EXPLORER_SOURCE });
  const logger = captureLogger();
  const source = loadAgentSource({ workspace, agent: "explorer", from: FROM, logger });
  assert.equal(source.description, "Read-only code research. Reference for the Nexus explorer.");
  assert.equal(source.systemPrompt, "You are a read-only code explorer.\n\nAlways end with a `## Summary` section.");
  assert.deepEqual([...source.ignored].sort(), ["effort", "model", "name", "tools"]);
  assert.equal(logger.warnings.length, 1);
  assert.equal(logger.warnings[0]?.message, "fields of the agent file are ignored by Nexus");
  assert.deepEqual(logger.warnings[0]?.data?.["ignored"], ["name", "tools", "model", "effort"]);
});

test("a file without frontmatter contributes only its body and no description", () => {
  const workspace = makeWorkspace({ [FROM]: "Only a prompt.\n" });
  const logger = captureLogger();
  const source = loadAgentSource({ workspace, agent: "explorer", from: FROM, logger });
  assert.equal(source.description, "");
  assert.equal(source.systemPrompt, "Only a prompt.");
  assert.equal(logger.warnings.length, 0);
});

test("a non-string description is rejected", () => {
  const workspace = makeWorkspace({ [FROM]: "---\ndescription:\n  - a\n---\nBody\n" });
  expectError(
    () => loadAgentSource({ workspace, agent: "explorer", from: FROM, logger: captureLogger() }),
    "VALIDATION",
    "agents.explorer.from: frontmatter description must be a string",
  );
});

test("a missing file is reported with its workspace-relative name", () => {
  const workspace = makeWorkspace({});
  expectError(
    () => loadAgentSource({ workspace, agent: "explorer", from: FROM, logger: captureLogger() }),
    "VALIDATION",
    `file not found: ${FROM}`,
  );
});

test("a file above the size limit is rejected before it is read", () => {
  const workspace = makeWorkspace({ [FROM]: "x".repeat(MAX_AGENT_SOURCE_BYTES + 1) });
  expectError(
    () => loadAgentSource({ workspace, agent: "explorer", from: FROM, logger: captureLogger() }),
    "VALIDATION",
    "larger than",
  );
});

test("the source must be a .md file directly inside .claude/agents, checked on every read", () => {
  const workspace = makeWorkspace({
    ".claude/agents/explorer.txt": "x",
    ".claude/agents/nested/explorer.md": "x",
    "other/explorer.md": "x",
    "secret.md": "x",
  });
  const logger = captureLogger();
  for (const from of [".claude/agents/explorer.txt", ".claude/agents/nested/explorer.md", "other/explorer.md", "secret.md", "../outside.md"]) {
    expectError(() => loadAgentSource({ workspace, agent: "explorer", from, logger }), from.includes("..") ? "PATH_OUTSIDE_WORKSPACE" : "VALIDATION");
  }
});

test("a link inside .claude/agents that points outside the workspace is rejected", (t) => {
  const workspace = makeWorkspace({ ".claude/agents/.keep": "" });
  const outside = makeWorkspace({ "target.md": "---\ndescription: leaked\n---\nLeaked prompt\n" });
  mkdirSync(join(workspace, ".claude", "agents"), { recursive: true });
  try {
    symlinkSync(join(outside, "target.md"), join(workspace, FROM), "file");
  } catch (error) {
    t.skip(`symlinks are not available here: ${(error as Error).message}`);
    return;
  }
  expectError(
    () => loadAgentSource({ workspace, agent: "explorer", from: FROM, logger: captureLogger() }),
    "PATH_OUTSIDE_WORKSPACE",
  );
  rmSync(join(workspace, FROM), { force: true });
  writeFileSync(join(workspace, FROM), "---\ndescription: local\n---\nBody\n");
  assert.equal(loadAgentSource({ workspace, agent: "explorer", from: FROM, logger: captureLogger() }).description, "local");
});

test("a directory junction named .claude/agents that leads outside the workspace is rejected", (t) => {
  const workspace = makeWorkspace({});
  const outside = makeWorkspace({ "agents/explorer.md": "---\ndescription: leaked\n---\nLeaked prompt\n" });
  mkdirSync(join(workspace, ".claude"), { recursive: true });
  try {
    // Directory junctions on Windows do not need the privilege that file symlinks need.
    symlinkSync(join(outside, "agents"), join(workspace, ".claude", "agents"), "junction");
  } catch (error) {
    t.skip(`junctions are not available here: ${(error as Error).message}`);
    return;
  }
  expectError(
    () => loadAgentSource({ workspace, agent: "explorer", from: FROM, logger: captureLogger() }),
    "PATH_OUTSIDE_WORKSPACE",
  );
});
