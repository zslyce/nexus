import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentDefinition, AgentRegistry, Logger, NexusConfig } from "../contracts/index.ts";
import { NexusError } from "../contracts/index.ts";
import { nexusError, resolveWorkspacePath } from "../utils/index.ts";
import {
  AGENT_DIRECTORY,
  GENERATED_MARKER,
  isGeneratedFile,
  renderAgentFile,
  validateDefinition,
  verifyRendered,
  withCatchAllDeny,
} from "./definitions.ts";
import { loadAgentSource } from "./loader.ts";

export interface AgentSyncResult {
  /** Files created or replaced, workspace-relative with forward slashes. */
  readonly written: string[];
  /** Files already identical to the definition. */
  readonly unchanged: string[];
  /** Files that were not touched, with the reason. */
  readonly skipped: { readonly path: string; readonly reason: string }[];
}

/** The file operations `sync` needs. Replaceable so that tests can inject failures. */
export interface AgentFileSystem {
  /** Text of the file, or `undefined` when it does not exist. Other errors are thrown. */
  readText(path: string): string | undefined;
  /** Creates the file; fails if it already exists. */
  writeExclusive(path: string, text: string): void;
  rename(from: string, to: string): void;
  /** Removes the file; a missing file is not an error. */
  remove(path: string): void;
  makeDirectory(path: string): void;
  /** Names of the entries of a directory, or `undefined` when it does not exist. */
  listDirectory(path: string): string[] | undefined;
}

export interface AgentRegistryOptions {
  readonly config: NexusConfig;
  readonly logger: Logger;
  readonly fs?: Partial<AgentFileSystem>;
  /** Waits between retries of a rename. Default: a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Windows refuses a rename while antivirus or an indexer holds the file; these codes are retried. */
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_BASE_MS = 50;

const nodeFileSystem: AgentFileSystem = {
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    }
  },
  writeExclusive(path, text) {
    writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
  },
  rename(from, to) {
    renameSync(from, to);
  },
  remove(path) {
    rmSync(path, { force: true });
  },
  makeDirectory(path) {
    mkdirSync(path, { recursive: true });
  },
  listDirectory(path) {
    try {
      return readdirSync(path);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return undefined;
      throw error;
    }
  },
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One generated file that `sync` intends to write. `expected` is what the file held when it was read. */
interface Plan {
  readonly relative: string;
  readonly absolute: string;
  readonly content: string;
  /** `undefined`: the file did not exist. Otherwise a generated file that is replaced. */
  readonly expected: string | undefined;
}

/**
 * Agent registry built from `config.agents`. Validates every definition, fills `description` and
 * `systemPrompt` from `from` files, and generates `.opencode/agents/nexus-<name>.md` in the workspace.
 * Construction throws on the first invalid definition; `sync` never changes anything it did not generate.
 */
export function createAgentRegistry(options: AgentRegistryOptions): AgentRegistry {
  return new Registry(options);
}

class Registry implements AgentRegistry {
  readonly #root: string;
  readonly #logger: Logger;
  readonly #fs: AgentFileSystem;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #definitions: readonly AgentDefinition[];
  readonly #byName: ReadonlyMap<string, AgentDefinition>;
  /** Serializes `sync` calls made within this process, so that two syncs never interleave. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: AgentRegistryOptions) {
    this.#root = options.config.workspace;
    this.#logger = options.logger;
    this.#fs = { ...nodeFileSystem, ...options.fs };
    this.#sleep = options.sleep ?? realSleep;

    const providers = options.config.opencode.allowedProviders;
    const definitions: AgentDefinition[] = [];
    const byName = new Map<string, AgentDefinition>();
    for (const declared of options.config.agents) {
      if (byName.has(declared.name)) {
        throw nexusError("VALIDATION", `agents.${declared.name} is declared more than once`);
      }
      const resolved = this.#resolve(declared);
      for (const warning of validateDefinition(resolved, providers)) {
        this.#logger.warn(warning, { agent: resolved.name });
      }
      definitions.push(resolved);
      byName.set(resolved.name, resolved);
    }
    this.#definitions = definitions;
    this.#byName = byName;
  }

  list(): AgentDefinition[] {
    return this.#definitions.map(cloneDefinition);
  }

  get(name: string): AgentDefinition | undefined {
    const found = this.#byName.get(name);
    return found === undefined ? undefined : cloneDefinition(found);
  }

  sync(): Promise<AgentSyncResult> {
    const run = this.#queue.then(() => this.#syncNow());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Config values win; `from` fills the fields that the config leaves empty. The `from` file is read here,
   * when the registry is built; `sync` does not read it again.
   */
  #resolve(declared: AgentDefinition): AgentDefinition {
    let description = declared.description.trim();
    let systemPrompt = declared.systemPrompt.trim();
    if (declared.from !== undefined) {
      const source = loadAgentSource({
        workspace: this.#root,
        agent: declared.name,
        from: declared.from,
        logger: this.#logger,
      });
      if (description === "") description = source.description;
      if (systemPrompt === "") systemPrompt = source.systemPrompt;
    }
    return {
      ...declared,
      // The catch-all deny is part of the definition, so `list()` shows what the generated file carries.
      permissions: withCatchAllDeny(declared.permissions),
      description,
      systemPrompt,
      source: declared.from === undefined ? "config" : "claude-agents",
    };
  }

  async #syncNow(): Promise<AgentSyncResult> {
    const written: string[] = [];
    const unchanged: string[] = [];
    const skipped: { path: string; reason: string }[] = [];

    // Phase 1: decide for every agent, without writing anything.
    const plans: Plan[] = [];
    const managed = new Set<string>();
    for (const agent of this.#definitions) {
      const relative = `${AGENT_DIRECTORY}/${agent.opencodeId}.md`;
      managed.add(relative);
      const content = renderAgentFile(agent);
      verifyRendered(agent, content);

      let absolute: string;
      try {
        absolute = this.#targetPath(relative);
      } catch (error) {
        if (error instanceof NexusError && error.info.code === "PATH_OUTSIDE_WORKSPACE") {
          skipped.push({ path: relative, reason: "resolves outside the workspace (through a link or junction)" });
          continue;
        }
        throw error;
      }

      let existing: string | undefined;
      try {
        existing = this.#fs.readText(absolute);
      } catch (error) {
        skipped.push({ path: relative, reason: `cannot be read (${codeOf(error) ?? "unknown error"})` });
        continue;
      }
      if (existing === content) {
        unchanged.push(relative);
      } else if (existing !== undefined && !isGeneratedFile(existing)) {
        skipped.push({
          path: relative,
          reason: `exists and was not generated by Nexus (no "${GENERATED_MARKER}" marker); rename or delete it to let sync manage ${agent.name}`,
        });
      } else {
        plans.push({ relative, absolute, content, expected: existing });
      }
    }
    this.#reportStale(managed, skipped);

    // Phase 2: stage every planned file under a temporary name, then move each one into place.
    if (plans.length > 0) {
      await this.#commit(plans, written, skipped);
    }

    this.#logger.info("agents synced", {
      written: written.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
    });
    for (const entry of skipped) {
      this.#logger.warn("agent file skipped", { path: entry.path, reason: entry.reason });
    }
    return { written, unchanged, skipped };
  }

  /**
   * Writes the planned files. Each temporary name is recorded before its file is created, so a write that
   * fails midway is cleaned up too. Right before each rename the target is checked again: a file that
   * appeared (or stopped being generated) since phase 1 is skipped, not overwritten.
   *
   * Residual window: the check and the rename are two operations, so a file created in between is still
   * replaced. The window is one rename long; closing it would need create-if-absent semantics that rename
   * does not offer. Nothing else in Nexus writes to `.opencode/agents`.
   */
  async #commit(plans: readonly Plan[], written: string[], skipped: { path: string; reason: string }[]): Promise<void> {
    const staged: { plan: Plan; temporary: string }[] = [];
    let current: string = AGENT_DIRECTORY;
    try {
      this.#fs.makeDirectory(this.#directoryPath());
      for (const plan of plans) {
        current = plan.relative;
        const temporary = `${plan.absolute}.${randomBytes(6).toString("hex")}.tmp`;
        staged.push({ plan, temporary });
        this.#fs.writeExclusive(temporary, plan.content);
      }
      for (const entry of staged) {
        current = entry.plan.relative;
        if (!this.#stillExpected(entry.plan)) {
          this.#fs.remove(entry.temporary);
          skipped.push({
            path: entry.plan.relative,
            reason: "changed while sync was running; not overwritten (run sync again)",
          });
          continue;
        }
        await this.#renameWithRetry(entry.temporary, entry.plan.absolute);
        const readBack = this.#fs.readText(entry.plan.absolute);
        if (readBack !== entry.plan.content) {
          throw nexusError("INTERNAL", `${entry.plan.relative} does not match what was generated after writing`);
        }
        written.push(entry.plan.relative);
      }
    } catch (error) {
      for (const entry of staged) {
        try {
          this.#fs.remove(entry.temporary);
        } catch {
          // Best effort: a leftover `.tmp` is ignored by OpenCode and replaced by the next sync.
        }
      }
      if (error instanceof NexusError) throw error;
      throw nexusError("INTERNAL", `could not write ${current}: ${codeOf(error) ?? "unknown error"}`, {
        cause: error,
      });
    }
  }

  /** The target is still in the state phase 1 saw: absent for a new file, a generated file for a replacement. */
  #stillExpected(plan: Plan): boolean {
    const current = this.#fs.readText(plan.absolute);
    if (plan.expected === undefined) return current === undefined;
    return current !== undefined && isGeneratedFile(current);
  }

  async #renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        this.#fs.rename(from, to);
        return;
      } catch (error) {
        const code = codeOf(error);
        if (attempt >= RENAME_ATTEMPTS || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw error;
        await this.#sleep(RENAME_RETRY_BASE_MS * attempt);
      }
    }
  }

  /**
   * Generated files of agents that are no longer declared are reported, never deleted. Every path goes
   * through the workspace guard, so a link that leads outside is neither listed nor read.
   */
  #reportStale(managed: ReadonlySet<string>, skipped: { path: string; reason: string }[]): void {
    let names: string[] | undefined;
    try {
      names = this.#fs.listDirectory(this.#directoryPath());
    } catch {
      // Outside the workspace or unreadable: phase 1 already reported each file, so there is nothing more to add.
      return;
    }
    for (const name of names ?? []) {
      if (!/^nexus-[a-z0-9-]+\.md$/.test(name)) continue;
      const relative = `${AGENT_DIRECTORY}/${name}`;
      if (managed.has(relative)) continue;
      let text: string | undefined;
      try {
        text = this.#fs.readText(this.#targetPath(relative));
      } catch {
        continue;
      }
      if (text !== undefined && isGeneratedFile(text)) {
        skipped.push({ path: relative, reason: "generated for an agent no longer declared in nexus.config.json; delete it" });
      }
    }
  }

  /** Validated, workspace-contained absolute path for a generated file. */
  #targetPath(relative: string): string {
    const checked = resolveWorkspacePath(this.#root, relative);
    return join(this.#root, checked);
  }

  /** Validated, workspace-contained absolute path of the agent directory. */
  #directoryPath(): string {
    return this.#targetPath(AGENT_DIRECTORY);
  }
}

function cloneDefinition(agent: AgentDefinition): AgentDefinition {
  return { ...agent, permissions: agent.permissions.map((rule) => ({ ...rule })) };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
