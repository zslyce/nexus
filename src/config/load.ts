import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  NexusError,
  type AgentDefinition,
  type NexusConfig,
} from "../contracts/index.ts";
import { nexusError, canonicalWorkspace, resolveWorkspacePath } from "../utils/index.ts";
import { ConfigFileSchema, MODEL_PATTERN, type AgentFileParsed } from "./schema.ts";

export const CONFIG_FILE_NAME = "nexus.config.json";
export const STATE_DIR_NAME = ".nexus";
/** `agents.<n>.from` must point to a markdown file here. */
const AGENTS_DIR = ".claude/agents";

const IS_WINDOWS = process.platform === "win32";

/**
 * Loads `<workspace>/nexus.config.json`, merges it over the defaults and validates it. A missing file
 * means defaults only. Throws `NexusError` (`VALIDATION`, `NOT_FOUND`, `PATH_OUTSIDE_WORKSPACE` or
 * `PROVIDER_NOT_ALLOWED`) whose message names the offending key. Derived fields (`workspace`,
 * `stateDir`, `opencodeId`, `source`) are never read from the file.
 */
export function loadConfig(workspace: string): NexusConfig {
  const root = canonicalWorkspace(workspace);
  const raw = readConfigFile(join(root, CONFIG_FILE_NAME));
  const parsed = parseConfig(raw);

  const agents: AgentDefinition[] = Object.entries(parsed.agents).map(([name, input]) =>
    buildAgent(root, name, input, parsed.opencode.allowedProviders),
  );

  return {
    workspace: root,
    stateDir: join(root, STATE_DIR_NAME),
    opencode: parsed.opencode,
    concurrency: parsed.concurrency,
    tasks: parsed.tasks,
    history: parsed.history,
    agents,
  };
}

function readConfigFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw nexusError("VALIDATION", `${CONFIG_FILE_NAME} cannot be read`, { cause: error });
  }
  try {
    // Strip a UTF-8 byte order mark, which some Windows editors add.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    // The parser message can echo file content; it is deliberately not included.
    throw nexusError("VALIDATION", `${CONFIG_FILE_NAME} is not valid JSON`);
  }
}

function parseConfig(raw: unknown): z.output<typeof ConfigFileSchema> {
  const result = ConfigFileSchema.safeParse(raw ?? {});
  if (!result.success) {
    const details = result.error.issues.map(describeIssue).join("; ");
    throw nexusError("VALIDATION", `${CONFIG_FILE_NAME}: ${details}`);
  }
  return result.data;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.map(String).join(".") || "(root)";
  if (issue.code === "unrecognized_keys") {
    return `${where}: unrecognized key ${issue.keys.map((key) => `"${key}"`).join(", ")}`;
  }
  return `${where}: ${issue.message}`;
}

function buildAgent(
  root: string,
  name: string,
  input: AgentFileParsed,
  allowedProviders: readonly string[],
): AgentDefinition {
  const key = `agents.${name}`;
  const provider = providerOf(input.model);
  if (!allowedProviders.includes(provider)) {
    throw nexusError(
      "PROVIDER_NOT_ALLOWED",
      `${key}.model: provider "${provider}" is not allowed (allowed: ${allowedProviders.join(", ")})`,
    );
  }

  const from = input.from === undefined ? undefined : checkFrom(root, key, input.from);
  const agent: AgentDefinition = {
    name,
    opencodeId: `nexus-${name}`,
    description: input.description ?? "",
    model: input.model,
    systemPrompt: input.systemPrompt ?? "",
    permissions: input.permissions,
    canWrite: input.canWrite,
    steps: input.steps,
    timeoutMs: input.timeoutMs,
    maxConcurrency: input.maxConcurrency,
    source: from === undefined ? "config" : "claude-agents",
  };
  if (from !== undefined) agent.from = from;
  return agent;
}

function providerOf(model: string): string {
  const match = MODEL_PATTERN.exec(model);
  // The schema already validated the format, so the match always succeeds.
  return match?.[1] ?? "";
}

/** Returns the normalized workspace-relative path of a `from` file. The file itself is not read here. */
function checkFrom(root: string, key: string, from: string): string {
  let relative: string;
  try {
    relative = resolveWorkspacePath(root, from);
  } catch (error) {
    if (error instanceof NexusError) {
      throw new NexusError({ ...error.info, message: `${key}.from: ${error.info.message}` }, { cause: error });
    }
    throw error;
  }
  const prefix = `${AGENTS_DIR}/`;
  const comparable = IS_WINDOWS ? relative.toLowerCase() : relative;
  const inAgentsDir = comparable.startsWith(prefix.toLowerCase()) && comparable.length > prefix.length;
  if (!inAgentsDir || !comparable.endsWith(".md")) {
    throw nexusError("VALIDATION", `${key}.from: must be a .md file inside ${AGENTS_DIR}/`);
  }
  return relative;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
