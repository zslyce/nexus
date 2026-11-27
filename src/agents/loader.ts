import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NexusError, type Logger } from "../contracts/index.ts";
import { nexusError, resolveWorkspacePath } from "../utils/index.ts";
import { parseFrontmatter, splitFrontmatter } from "./markdown.ts";

/** Only Claude Code agent files from this folder may be imported (ADR-009). */
export const AGENT_SOURCE_DIRECTORY = ".claude/agents";
/** A prompt file larger than this is rejected before it is read: it would bloat every session. */
export const MAX_AGENT_SOURCE_BYTES = 256 * 1024;

const IS_WINDOWS = process.platform === "win32";

export interface AgentSource {
  /** Frontmatter `description`, trimmed; empty when the file has none. */
  readonly description: string;
  /** Body of the file, trimmed. */
  readonly systemPrompt: string;
  /** Frontmatter keys Nexus ignores (every key except `description`). */
  readonly ignored: readonly string[];
}

/**
 * Reads the `from` file of an agent. Only `description` and the body are used. Keys such as `tools`,
 * `model` or `effort` are ignored on purpose (the OpenCode model and permissions are declared in
 * nexus.config.json) and are reported with a warning. The path is checked here, on each read, against
 * the workspace guard (links and junctions included). The registry reads the file once, when it is built;
 * a later change to the file is not seen until the registry is built again.
 */
export function loadAgentSource(options: {
  readonly workspace: string;
  readonly agent: string;
  readonly from: string;
  readonly logger: Logger;
}): AgentSource {
  const key = `agents.${options.agent}.from`;
  const relative = checkedRelativePath(options.workspace, options.from, key);
  const absolute = join(options.workspace, relative);

  let size: number;
  try {
    size = statSync(absolute).size;
  } catch (error) {
    if (codeOf(error) === "ENOENT") {
      throw nexusError("VALIDATION", `${key}: file not found: ${relative}`, { cause: error });
    }
    throw nexusError("VALIDATION", `${key}: file cannot be read: ${relative}`, { cause: error });
  }
  if (size > MAX_AGENT_SOURCE_BYTES) {
    throw nexusError("VALIDATION", `${key}: file is larger than ${MAX_AGENT_SOURCE_BYTES} bytes: ${relative}`);
  }

  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch (error) {
    throw nexusError("VALIDATION", `${key}: file cannot be read: ${relative}`, { cause: error });
  }

  const parts = splitFrontmatter(raw);
  const fields = parseFrontmatter(parts.frontmatter);
  const rawDescription = fields["description"];
  if (rawDescription !== undefined && typeof rawDescription !== "string") {
    throw nexusError("VALIDATION", `${key}: frontmatter description must be a string`);
  }

  const ignored = Object.keys(fields).filter((name) => name !== "description");
  if (ignored.length > 0) {
    options.logger.warn("fields of the agent file are ignored by Nexus", {
      agent: options.agent,
      file: relative,
      ignored,
    });
  }

  return {
    description: (rawDescription ?? "").trim(),
    systemPrompt: parts.body.trim(),
    ignored,
  };
}

/** Normalized workspace-relative path that must sit directly inside `.claude/agents/` and end in `.md`. */
function checkedRelativePath(workspace: string, from: string, key: string): string {
  let relative: string;
  try {
    relative = resolveWorkspacePath(workspace, from);
  } catch (error) {
    if (error instanceof NexusError) {
      throw new NexusError({ ...error.info, message: `${key}: ${error.info.message}` }, { cause: error });
    }
    throw error;
  }
  const prefix = `${AGENT_SOURCE_DIRECTORY}/`;
  const comparable = IS_WINDOWS ? relative.toLowerCase() : relative;
  const comparablePrefix = IS_WINDOWS ? prefix.toLowerCase() : prefix;
  const inside = comparable.startsWith(comparablePrefix) && comparable.length > comparablePrefix.length;
  if (!inside || !comparable.endsWith(".md") || comparable.slice(comparablePrefix.length).includes("/")) {
    throw nexusError("VALIDATION", `${key}: must be a .md file directly inside ${AGENT_SOURCE_DIRECTORY}/`);
  }
  return relative;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
