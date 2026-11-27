import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, NexusConfig } from "../../src/contracts/index.ts";
import { NexusError } from "../../src/contracts/index.ts";
import { createAgentRegistry, type AgentFileSystem, type AgentRegistryOptions } from "../../src/agents/registry.ts";
import { parseFrontmatter, splitFrontmatter } from "../../src/agents/markdown.ts";
import {
  DEVELOPER_PERMISSIONS,
  EXPLORER_PERMISSIONS,
  EXPLORER_SOURCE,
  captureLogger,
  makeConfig,
  makeWorkspace,
  removeWorkspaces,
} from "./agents-fixtures.ts";

after(() => removeWorkspaces());

const DEVELOPER_SOURCE = [
  "---",
  "name: developer",
  "description: Well-scoped implementation. Reference for the Nexus developer.",
  "tools: Read, Write, Edit, Bash",
  "---",
  "You implement exactly the task you are given.",
  "",
].join("\n");

const AGENTS_DIR = ".opencode/agents";

/** Agent declarations as `loadConfig` produces them: `from` set, description and prompt empty. */
function declared(name: "explorer" | "developer", overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  const developer = name === "developer";
  return {
    name,
    opencodeId: `nexus-${name}`,
    description: "",
    systemPrompt: "",
    model: developer ? "opencode-go/deepseek-v4.1-flash#high" : "opencode-go/mimo-v2.6-flash",
    permissions: (developer ? DEVELOPER_PERMISSIONS : EXPLORER_PERMISSIONS).map((rule) => ({ ...rule })),
    canWrite: developer,
    steps: developer ? 60 : 25,
    timeoutMs: 600000,
    maxConcurrency: 1,
    source: "claude-agents",
    from: `.claude/agents/${name}.md`,
    ...overrides,
  };
}

function standardWorkspace(): string {
  return makeWorkspace({
    ".claude/agents/explorer.md": EXPLORER_SOURCE,
    ".claude/agents/developer.md": DEVELOPER_SOURCE,
  });
}

function registryFor(
  workspace: string,
  agents: AgentDefinition[],
  extra: Partial<AgentRegistryOptions> = {},
) {
  const logger = captureLogger();
  const config: NexusConfig = makeConfig(workspace, agents);
  return { registry: createAgentRegistry({ config, logger, sleep: async () => {}, ...extra }), logger };
}

function codeOf(run: () => unknown): { code: string; message: string } | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
    return { code: error.info.code, message: error.info.message };
  }
}

async function rejectionOf(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
    return { code: error.info.code, message: error.info.message };
  }
  assert.fail("expected the promise to reject");
}

/** The real file operations, with the same semantics as `nodeFileSystem` in registry.ts. */
const realFs: AgentFileSystem = {
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  writeExclusive(path, text) {
    writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
  },
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
  makeDirectory: (path) => mkdirSync(path, { recursive: true }),
  listDirectory(path) {
    try {
      return readdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
};

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

test("construction fills description and prompt from the from file, and config values win when set", () => {
  const workspace = standardWorkspace();
  const { registry, logger } = registryFor(workspace, [
    declared("explorer"),
    declared("developer", { description: "Config description wins", systemPrompt: "Config prompt wins." }),
  ]);
  const explorer = registry.get("explorer");
  assert.ok(explorer);
  assert.equal(explorer.description, "Read-only code research. Reference for the Nexus explorer.");
  assert.equal(explorer.systemPrompt, "You are a read-only code explorer.\n\nAlways end with a `## Summary` section.");
  assert.equal(explorer.source, "claude-agents");
  assert.equal(explorer.opencodeId, "nexus-explorer");

  const developer = registry.get("developer");
  assert.equal(developer?.description, "Config description wins");
  assert.equal(developer?.systemPrompt, "Config prompt wins.");
  assert.equal(logger.warnings.length, 2, "each file reports its ignored keys once");
});

test("list keeps the declaration order and get returns copies", () => {
  const workspace = standardWorkspace();
  const { registry } = registryFor(workspace, [declared("explorer"), declared("developer")]);
  assert.deepEqual(registry.list().map((agent) => agent.name), ["explorer", "developer"]);
  assert.equal(registry.get("unknown"), undefined);
  const copy = registry.get("explorer");
  assert.ok(copy);
  copy.permissions.length = 0;
  copy.description = "changed";
  assert.equal(registry.get("explorer")?.permissions.length, EXPLORER_PERMISSIONS.length);
  assert.notEqual(registry.get("explorer")?.description, "changed");
});

test("a declaration without from needs its description and prompt", () => {
  const workspace = standardWorkspace();
  const error = codeOf(() => registryFor(workspace, [declared("explorer", { from: undefined, source: "config" })]));
  assert.equal(error?.code, "VALIDATION");
  assert.ok(error?.message.includes("agents.explorer.description"), error?.message);
});

test("a from path that escapes .claude/agents is rejected when the registry is built", () => {
  const workspace = standardWorkspace();
  const error = codeOf(() => registryFor(workspace, [declared("explorer", { from: "../outside.md" })]));
  assert.equal(error?.code, "PATH_OUTSIDE_WORKSPACE");
});

test("invalid definitions are rejected at construction with the key named", () => {
  const workspace = standardWorkspace();
  const cases: [AgentDefinition[], string, string][] = [
    [[declared("explorer", { model: "opencode/big-pickle" })], "PROVIDER_NOT_ALLOWED", "agents.explorer.model"],
    [[declared("explorer", { canWrite: false, permissions: [{ action: "edit", resource: "*", effect: "allow" }] })], "VALIDATION", "edit"],
    [[declared("explorer"), declared("explorer")], "VALIDATION", "declared more than once"],
  ];
  for (const [agents, code, fragment] of cases) {
    const error = codeOf(() => registryFor(workspace, agents));
    assert.equal(error?.code, code);
    assert.ok(error?.message.includes(fragment), error?.message);
  }
});

test("sync writes one generated file per agent, and a second sync changes nothing", async () => {
  const workspace = standardWorkspace();
  const { registry, logger } = registryFor(workspace, [declared("explorer"), declared("developer")]);

  const first = await registry.sync();
  assert.deepEqual(first.written, [`${AGENTS_DIR}/nexus-explorer.md`, `${AGENTS_DIR}/nexus-developer.md`]);
  assert.deepEqual(first.unchanged, []);
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(readdirSync(join(workspace, AGENTS_DIR)).sort(), ["nexus-developer.md", "nexus-explorer.md"]);

  const second = await registry.sync();
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.unchanged, first.written);
  assert.equal(logger.infos.at(-1)?.message, "agents synced");
});

test("every permission, the model, the steps and the prompt arrive intact in the generated file", async () => {
  const workspace = standardWorkspace();
  const { registry } = registryFor(workspace, [declared("explorer"), declared("developer")]);
  await registry.sync();

  for (const agent of registry.list()) {
    const text = readFileSync(join(workspace, AGENTS_DIR, `${agent.opencodeId}.md`), "utf8");
    assert.ok(text.split("\n")[1]?.startsWith("# nexus:generated"), "the marker is the first field");
    const parts = splitFrontmatter(text);
    const fields = parseFrontmatter(parts.frontmatter);
    assert.deepEqual(fields["permissions"], agent.permissions, `${agent.name} permissions`);
    assert.equal(fields["model"], agent.model);
    assert.equal(fields["steps"], agent.steps);
    assert.equal(fields["description"], agent.description);
    assert.equal(parts.body.trim(), agent.systemPrompt);
  }
});

test("changing one definition rewrites only its file", async () => {
  const workspace = standardWorkspace();
  const before = registryFor(workspace, [declared("explorer"), declared("developer")]).registry;
  await before.sync();

  const changed = declared("developer", { steps: 90 });
  const after2 = registryFor(workspace, [declared("explorer"), changed]).registry;
  const result = await after2.sync();
  assert.deepEqual(result.written, [`${AGENTS_DIR}/nexus-developer.md`]);
  assert.deepEqual(result.unchanged, [`${AGENTS_DIR}/nexus-explorer.md`]);
  const fields = parseFrontmatter(splitFrontmatter(readFileSync(join(workspace, AGENTS_DIR, "nexus-developer.md"), "utf8")).frontmatter);
  assert.equal(fields["steps"], 90);
});

test("a user file without the marker is never overwritten and is reported as skipped", async () => {
  const workspace = standardWorkspace();
  const userFile = join(workspace, AGENTS_DIR, "nexus-explorer.md");
  mkdirSync(join(workspace, AGENTS_DIR), { recursive: true });
  writeFileSync(userFile, "---\ndescription: mine\n---\nMy own prompt.\n");

  const { registry } = registryFor(workspace, [declared("explorer"), declared("developer")]);
  const result = await registry.sync();
  assert.deepEqual(result.written, [`${AGENTS_DIR}/nexus-developer.md`]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.path, `${AGENTS_DIR}/nexus-explorer.md`);
  assert.ok(result.skipped[0]?.reason.includes("not generated by Nexus"));
  assert.equal(readFileSync(userFile, "utf8"), "---\ndescription: mine\n---\nMy own prompt.\n");
});

test("a generated file edited by hand is regenerated", async () => {
  const workspace = standardWorkspace();
  const { registry } = registryFor(workspace, [declared("explorer"), declared("developer")]);
  await registry.sync();
  const file = join(workspace, AGENTS_DIR, "nexus-explorer.md");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace("effect: allow", "effect: ask").replace("# nexus:generated", "# nexus:generated (edited)"));

  const result = await registry.sync();
  assert.deepEqual(result.written, [`${AGENTS_DIR}/nexus-explorer.md`]);
  assert.equal(readFileSync(file, "utf8"), original, "the generated content is restored");
});

test("a generated file for an agent that is no longer declared is reported and kept", async () => {
  const workspace = standardWorkspace();
  mkdirSync(join(workspace, AGENTS_DIR), { recursive: true });
  const stale = join(workspace, AGENTS_DIR, "nexus-retired.md");
  writeFileSync(stale, "---\n# nexus:generated - do not edit\ndescription: old\n---\nOld.\n");
  writeFileSync(join(workspace, AGENTS_DIR, "other.md"), "not ours");

  const { registry } = registryFor(workspace, [declared("explorer")]);
  const result = await registry.sync();
  assert.ok(existsSync(stale), "sync never deletes files");
  assert.ok(result.skipped.some((entry) => entry.path === `${AGENTS_DIR}/nexus-retired.md` && entry.reason.includes("no longer declared")));
  assert.equal(result.skipped.some((entry) => entry.path.endsWith("other.md")), false, "files that are not ours are ignored");
});

test("with no agents declared, nothing is written and the directory is not created", async () => {
  const workspace = standardWorkspace();
  const { registry } = registryFor(workspace, []);
  assert.deepEqual(await registry.sync(), { written: [], unchanged: [], skipped: [] });
  assert.equal(existsSync(join(workspace, ".opencode")), false);
});

test("concurrent sync calls are serialized: the first writes, the second finds everything unchanged", async () => {
  const workspace = standardWorkspace();
  const { registry } = registryFor(workspace, [declared("explorer"), declared("developer")]);
  const [first, second] = await Promise.all([registry.sync(), registry.sync()]);
  assert.equal(first.written.length, 2);
  assert.equal(second.written.length, 0);
  assert.equal(second.unchanged.length, 2);
  assert.deepEqual(readdirSync(join(workspace, AGENTS_DIR)).sort(), ["nexus-developer.md", "nexus-explorer.md"]);
});

test("a failed rename removes the temporary files, reports INTERNAL, and the next sync completes the work", async () => {
  const workspace = standardWorkspace();
  const failing: Partial<AgentFileSystem> = {
    rename(from, to) {
      if (to.endsWith("nexus-developer.md")) throw errno("EIO", "disk went away");
      renameSync(from, to);
    },
  };
  const { registry } = registryFor(workspace, [declared("explorer"), declared("developer")], { fs: failing });

  const error = await rejectionOf(() => registry.sync());
  assert.equal(error.code, "INTERNAL");
  assert.ok(error.message.includes(`${AGENTS_DIR}/nexus-developer.md`), error.message);
  const leftovers = readdirSync(join(workspace, AGENTS_DIR));
  assert.equal(leftovers.some((name) => name.endsWith(".tmp")), false, `temporary files left: ${leftovers.join(", ")}`);

  const { registry: recovered } = registryFor(workspace, [declared("explorer"), declared("developer")]);
  const result = await recovered.sync();
  assert.deepEqual(result.written, [`${AGENTS_DIR}/nexus-developer.md`]);
  assert.deepEqual(result.unchanged, [`${AGENTS_DIR}/nexus-explorer.md`]);
});

test("renames refused by Windows (EPERM) are retried with growing delays", async () => {
  const workspace = standardWorkspace();
  const delays: number[] = [];
  let refusals = 2;
  const flaky: Partial<AgentFileSystem> = {
    rename(from, to) {
      if (to.endsWith("nexus-explorer.md") && refusals > 0) {
        refusals -= 1;
        throw errno("EPERM");
      }
      renameSync(from, to);
    },
  };
  const { registry } = registryFor(workspace, [declared("explorer")], {
    fs: flaky,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  const result = await registry.sync();
  assert.deepEqual(result.written, [`${AGENTS_DIR}/nexus-explorer.md`]);
  assert.deepEqual(delays, [50, 100]);
});

test("retries stop after the attempt limit and the error is INTERNAL", async () => {
  const workspace = standardWorkspace();
  let attempts = 0;
  const stuck: Partial<AgentFileSystem> = {
    rename() {
      attempts += 1;
      throw errno("EBUSY");
    },
  };
  const { registry } = registryFor(workspace, [declared("explorer")], { fs: stuck });
  const error = await rejectionOf(() => registry.sync());
  assert.equal(error.code, "INTERNAL");
  assert.equal(attempts, 5);
  assert.equal(readdirSync(join(workspace, AGENTS_DIR)).some((name) => name.endsWith(".tmp")), false);
});

test("a file that changes after the rename fails the read-back check", async () => {
  const workspace = standardWorkspace();
  const renamed = new Set<string>();
  const tampering: Partial<AgentFileSystem> = {
    rename(from, to) {
      renameSync(from, to);
      renamed.add(to);
    },
    readText(path) {
      return renamed.has(path) ? "something else entirely" : realFs.readText(path);
    },
  };
  const { registry } = registryFor(workspace, [declared("explorer")], { fs: tampering });
  const error = await rejectionOf(() => registry.sync());
  assert.equal(error.code, "INTERNAL");
  assert.ok(error.message.includes("does not match what was generated"), error.message);
});

test("a directory that cannot be created fails the sync and writes nothing", async () => {
  const workspace = standardWorkspace();
  const writes: string[] = [];
  const denied: Partial<AgentFileSystem> = {
    makeDirectory() {
      throw errno("EACCES", "denied");
    },
    writeExclusive(path, text) {
      writes.push(path);
      realFs.writeExclusive(path, text);
    },
  };
  const { registry } = registryFor(workspace, [declared("explorer")], { fs: denied });
  const error = await rejectionOf(() => registry.sync());
  assert.equal(error.code, "INTERNAL");
  assert.deepEqual(writes, []);
});

test("an existing file that cannot be read is skipped without stopping the other agents", async () => {
  const workspace = standardWorkspace();
  const unreadable: Partial<AgentFileSystem> = {
    readText(path) {
      if (path.endsWith("nexus-explorer.md")) throw errno("EACCES", "denied");
      return realFs.readText(path);
    },
  };
  const { registry } = registryFor(workspace, [declared("explorer"), declared("developer")], { fs: unreadable });
  const result = await registry.sync();
  assert.deepEqual(result.written, [`${AGENTS_DIR}/nexus-developer.md`]);
  assert.equal(result.skipped[0]?.path, `${AGENTS_DIR}/nexus-explorer.md`);
  assert.ok(result.skipped[0]?.reason.includes("EACCES"));
});

test("a generated-file directory that is a junction to another folder is skipped, not followed", async (t) => {
  const workspace = standardWorkspace();
  const elsewhere = mkdtempSync(join(tmpdir(), "nexus-elsewhere-"));
  mkdirSync(join(workspace, ".opencode"), { recursive: true });
  try {
    symlinkSync(elsewhere, join(workspace, AGENTS_DIR), "junction");
  } catch (error) {
    t.skip(`junctions are not available here: ${(error as Error).message}`);
    rmSync(elsewhere, { recursive: true, force: true });
    return;
  }
  const { registry } = registryFor(workspace, [declared("explorer")]);
  const result = await registry.sync();
  assert.deepEqual(result.written, []);
  assert.equal(result.skipped.length, 1);
  assert.ok(result.skipped[0]?.reason.includes("outside the workspace"), result.skipped[0]?.reason);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing is written through the junction");
  rmSync(elsewhere, { recursive: true, force: true });
});

test("a declaration without a catch-all deny is given one, in list() and in the generated file", async () => {
  const workspace = standardWorkspace();
  const { registry } = registryFor(workspace, [
    declared("explorer", { permissions: [{ action: "read", resource: "*", effect: "allow" }] }),
  ]);
  assert.deepEqual(registry.get("explorer")?.permissions[0], { action: "*", resource: "*", effect: "deny" });
  await registry.sync();
  const fields = parseFrontmatter(splitFrontmatter(readFileSync(join(workspace, AGENTS_DIR, "nexus-explorer.md"), "utf8")).frontmatter);
  assert.deepEqual(fields["permissions"], [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
  ]);
});

test("a write that fails midway leaves no temporary file and reports INTERNAL", async () => {
  const workspace = standardWorkspace();
  const midway: Partial<AgentFileSystem> = {
    writeExclusive(path, text) {
      writeFileSync(path, text.slice(0, 10), { encoding: "utf8", flag: "wx" });
      throw errno("EIO", "disk full");
    },
  };
  const { registry } = registryFor(workspace, [declared("explorer")], { fs: midway });
  const error = await rejectionOf(() => registry.sync());
  assert.equal(error.code, "INTERNAL");
  assert.ok(error.message.includes(`${AGENTS_DIR}/nexus-explorer.md`), error.message);
  assert.equal(readdirSync(join(workspace, AGENTS_DIR)).length, 0, "no partial file is left behind");
});

test("a file that appears between the check and the rename is not overwritten", async () => {
  const workspace = standardWorkspace();
  const target = join(workspace, AGENTS_DIR, "nexus-explorer.md");
  const userText = "---\ndescription: mine\n---\nMine\n";
  let intruded = false;
  const intruder: Partial<AgentFileSystem> = {
    writeExclusive(path, text) {
      realFs.writeExclusive(path, text);
      if (!intruded && path.includes("nexus-explorer.md.")) {
        intruded = true;
        realFs.writeExclusive(target, userText);
      }
    },
  };
  const { registry } = registryFor(workspace, [declared("explorer"), declared("developer")], { fs: intruder });
  const result = await registry.sync();
  assert.deepEqual(result.written, [`${AGENTS_DIR}/nexus-developer.md`]);
  const skippedExplorer = result.skipped.find((entry) => entry.path === `${AGENTS_DIR}/nexus-explorer.md`);
  assert.ok(skippedExplorer?.reason.includes("changed while sync was running"), JSON.stringify(result.skipped));
  assert.equal(readFileSync(target, "utf8"), userText);
  assert.equal(readdirSync(join(workspace, AGENTS_DIR)).some((name) => name.endsWith(".tmp")), false);
});

test("a generated file replaced by a user file during sync is not overwritten", async () => {
  const workspace = standardWorkspace();
  const target = join(workspace, AGENTS_DIR, "nexus-explorer.md");
  const first = registryFor(workspace, [declared("explorer")]).registry;
  await first.sync();

  const userText = "---\ndescription: mine\n---\nMine\n";
  let replaced = false;
  const intruder: Partial<AgentFileSystem> = {
    writeExclusive(path, text) {
      realFs.writeExclusive(path, text);
      if (!replaced && path.includes("nexus-explorer.md.")) {
        replaced = true;
        writeFileSync(target, userText);
      }
    },
  };
  const { registry } = registryFor(workspace, [declared("explorer", { steps: 30 })], { fs: intruder });
  const result = await registry.sync();
  assert.deepEqual(result.written, []);
  assert.ok(result.skipped.some((entry) => entry.reason.includes("changed while sync was running")));
  assert.equal(readFileSync(target, "utf8"), userText);
});

test("the stale scan neither lists nor reads through a junction that leads outside the workspace", async (t) => {
  const workspace = standardWorkspace();
  const outside = makeWorkspace({ "nexus-retired.md": "---\n# nexus:generated - x\ndescription: old\n---\nOld\n" });
  mkdirSync(join(workspace, ".opencode"), { recursive: true });
  try {
    symlinkSync(outside, join(workspace, AGENTS_DIR), "junction");
  } catch (error) {
    t.skip(`junctions are not available here: ${(error as Error).message}`);
    return;
  }
  const reads: string[] = [];
  const lists: string[] = [];
  const spy: Partial<AgentFileSystem> = {
    readText(path) {
      reads.push(path);
      return realFs.readText(path);
    },
    listDirectory(path) {
      lists.push(path);
      return realFs.listDirectory(path);
    },
  };
  const { registry } = registryFor(workspace, [declared("explorer")], { fs: spy });
  const result = await registry.sync();
  assert.equal(result.skipped.some((entry) => entry.path.endsWith("nexus-retired.md")), false);
  assert.equal(reads.some((path) => path.startsWith(outside)), false, `read through the junction: ${reads.join(", ")}`);
  assert.deepEqual(lists, [], "the directory is not listed through the junction");
});
