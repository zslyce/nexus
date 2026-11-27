import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentDefinition, Logger, NexusConfig, PermissionRule } from "../../src/contracts/index.ts";

export interface CapturedLogger extends Logger {
  readonly warnings: { message: string; data?: Record<string, unknown> }[];
  readonly infos: { message: string; data?: Record<string, unknown> }[];
}

export function captureLogger(): CapturedLogger {
  const warnings: CapturedLogger["warnings"] = [];
  const infos: CapturedLogger["infos"] = [];
  return {
    warnings,
    infos,
    debug() {},
    info(message, data) {
      infos.push(data === undefined ? { message } : { message, data });
    },
    warn(message, data) {
      warnings.push(data === undefined ? { message } : { message, data });
    },
    error() {},
  };
}

/** The read-only permissions of the explorer in nexus.config.json. */
export const EXPLORER_PERMISSIONS: PermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
];

/** The writing permissions of the developer in nexus.config.json. */
export const DEVELOPER_PERMISSIONS: PermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "shell", resource: "npm test*", effect: "allow" },
  { action: "shell", resource: "npm run *", effect: "allow" },
  { action: "shell", resource: "node --test*", effect: "allow" },
];

/** An already-resolved definition, as the registry hands it to the rest of the system. */
export function makeAgent(overrides: Partial<AgentDefinition> & { name: string }): AgentDefinition {
  return {
    opencodeId: `nexus-${overrides.name}`,
    description: "Read-only exploration",
    model: "opencode-go/mimo-v2.6-flash",
    systemPrompt: "You are a read-only explorer.",
    permissions: EXPLORER_PERMISSIONS.map((rule) => ({ ...rule })),
    canWrite: false,
    steps: 25,
    timeoutMs: 600000,
    maxConcurrency: 2,
    source: "config",
    ...overrides,
  };
}

/** A config as `loadConfig` would produce it for the given workspace. */
export function makeConfig(workspace: string, agents: AgentDefinition[], allowedProviders = ["opencode-go"]): NexusConfig {
  return {
    workspace,
    stateDir: join(workspace, ".nexus"),
    opencode: { allowedProviders, autoStart: false },
    concurrency: { global: 3 },
    tasks: {
      defaultTimeoutMs: 900000,
      maxAttempts: 2,
      backoffBaseMs: 2000,
      backoffMaxMs: 60000,
      permissionPolicy: "reject",
      validationCommandPatterns: [],
    },
    history: { maxTasks: 500, maxAgeDays: 30, maxEventsPerTask: 2000 },
    agents,
  };
}

const created: string[] = [];

/** Empty temporary workspace (canonical path). Removed by `removeWorkspaces`. */
export function makeWorkspace(files: Record<string, string> = {}): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nexus-agents-")));
  created.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return dir;
}

/** Removes every workspace created so far. Call from an `after` hook. */
export function removeWorkspaces(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const EXPLORER_SOURCE = [
  "---",
  "name: explorer",
  "description: Read-only code research. Reference for the Nexus explorer.",
  "tools: Read, Glob, Grep",
  "model: haiku",
  "effort: low",
  "---",
  "You are a read-only code explorer.",
  "",
  "Always end with a `## Summary` section.",
  "",
].join("\n");
