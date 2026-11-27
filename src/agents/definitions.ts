import { stringify } from "yaml";
import type { AgentDefinition, PermissionRule } from "../contracts/index.ts";
import { nexusError } from "../utils/index.ts";
import { normalizeText, parseFrontmatter, splitFrontmatter } from "./markdown.ts";

/** Same format as `MODEL_PATTERN` in `src/config/schema.ts` (a unit test keeps them equal). */
export const MODEL_FORMAT = /^([^/#\s]+)\/([^#\s]+)(?:#([^#\s]+))?$/;
/** Same format as `AGENT_NAME_PATTERN` in `src/config/schema.ts`: names become file names. */
export const AGENT_NAME_FORMAT = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Workspace-relative directory where OpenCode loads agent definitions. */
export const AGENT_DIRECTORY = ".opencode/agents";
/** Written as the first line inside the frontmatter of every file Nexus generates. */
export const GENERATED_MARKER = "# nexus:generated";
const GENERATED_LINE = `${GENERATED_MARKER} - do not edit; nexus sync rewrites this file from nexus.config.json`;
/** Mode used for every generated agent: they run as subagents of a Nexus task (docs/04, Agents). */
const GENERATED_MODE = "subagent";

/**
 * The first rule of every generated file. OpenCode applies its own base ruleset first (`* * allow`), so
 * an agent without a catch-all deny keeps edit and shell. Rules after it may reopen what it denies.
 */
export const CATCH_ALL_DENY: Readonly<PermissionRule> = Object.freeze({ action: "*", resource: "*", effect: "deny" });

/**
 * The only actions a read-only agent may be granted (allow or ask), matched literally and without regard
 * to letter case: OpenCode matches rules case-insensitively (read in the installed binary). Any other
 * action, and any wildcard in the action, is refused: the check fails closed. The names of the mutating
 * tools (`edit`, `write`, `shell`) were confirmed by a real run (docs/04, "Tools").
 */
export const READ_ONLY_ACTIONS: readonly string[] = ["read", "glob", "grep"];

/**
 * Returns the rules as the generated file carries them: the catch-all deny first, then the declared rules
 * in their order. Idempotent: a list that already starts with the catch-all is not changed.
 */
export function withCatchAllDeny(rules: readonly PermissionRule[]): PermissionRule[] {
  const first = rules[0];
  const hasCatchAll = first !== undefined
    && first.action === CATCH_ALL_DENY.action
    && first.resource === CATCH_ALL_DENY.resource
    && first.effect === CATCH_ALL_DENY.effect;
  const copies = rules.map((rule) => ({ ...rule }));
  return hasCatchAll ? copies : [{ ...CATCH_ALL_DENY }, ...copies];
}

/**
 * Glob with `*` (any text, including spaces and newlines) and `?` (one character). Other characters are
 * literal. Letter case is ignored, as in OpenCode's rule matching.
 */
export function globMatch(pattern: string, value: string): boolean {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else source += char.replace(/[\\^$.|+(){}[\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "siu").test(value);
}

/**
 * Checks one definition and returns warnings. Throws `VALIDATION` or `PROVIDER_NOT_ALLOWED`, naming the
 * key (`agents.<name>.<field>`). A read-only agent (canWrite false) may carry allow or ask rules only for the
 * actions in READ_ONLY_ACTIONS; anything else is refused, whatever its letter case, wildcard or rule order.
 */
export function validateDefinition(agent: AgentDefinition, allowedProviders: readonly string[]): string[] {
  const key = `agents.${agent.name}`;
  if (!AGENT_NAME_FORMAT.test(agent.name)) {
    throw nexusError("VALIDATION", `${key}: use lowercase letters, digits and hyphens (max 64)`);
  }
  if (agent.opencodeId !== `nexus-${agent.name}`) {
    throw nexusError("VALIDATION", `${key}.opencodeId must be nexus-${agent.name}`);
  }
  if (agent.description.trim() === "") {
    throw nexusError("VALIDATION", `${key}.description is empty`);
  }
  if (agent.systemPrompt.trim() === "") {
    throw nexusError("VALIDATION", `${key}.systemPrompt is empty`);
  }
  validateModel(agent.model, allowedProviders, key);
  for (const field of ["steps", "timeoutMs", "maxConcurrency"] as const) {
    const value = agent[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw nexusError("VALIDATION", `${key}.${field} must be a positive integer`);
    }
  }
  agent.permissions.forEach((rule, index) => {
    const where = `${key}.permissions[${index}]`;
    if (rule.action.trim() === "" || rule.resource.trim() === "") {
      throw nexusError("VALIDATION", `${where}: action and resource must not be empty`);
    }
    if (!["allow", "deny", "ask"].includes(rule.effect)) {
      throw nexusError("VALIDATION", `${where}.effect must be allow, deny or ask`);
    }
  });

  const warnings: string[] = [];
  const grants = (action: string): boolean =>
    agent.permissions.some((rule) => rule.effect !== "deny" && globMatch(rule.action, action));
  if (!agent.canWrite) {
    agent.permissions.forEach((rule, index) => {
      if (rule.effect === "deny") return;
      if (!READ_ONLY_ACTIONS.includes(rule.action.toLowerCase())) {
        throw nexusError(
          "VALIDATION",
          `${key}.permissions[${index}]: canWrite is false, so allow or ask may only name ${READ_ONLY_ACTIONS.join(", ")} (action "${rule.action}")`,
        );
      }
    });
  } else if (!grants("edit")) {
    warnings.push(`${key}: canWrite is true but no edit permission is allowed; the agent cannot change files`);
  }
  return warnings;
}

function validateModel(model: string, allowedProviders: readonly string[], key: string): void {
  const match = MODEL_FORMAT.exec(model);
  if (match === null) {
    throw nexusError("VALIDATION", `${key}.model: expected provider/model or provider/model#variant`);
  }
  const provider = match[1] ?? "";
  if (!allowedProviders.includes(provider)) {
    throw nexusError(
      "PROVIDER_NOT_ALLOWED",
      `${key}.model: provider "${provider}" is not allowed (allowed: ${allowedProviders.join(", ")})`,
    );
  }
}

/**
 * The OpenCode agent file for a definition. The frontmatter carries description, mode, model, steps and
 * permissions; the body is the system prompt. Nothing time-dependent is written, so the output is stable.
 */
export function renderAgentFile(agent: AgentDefinition): string {
  const frontmatter = stringify(
    {
      description: agent.description,
      mode: GENERATED_MODE,
      model: agent.model,
      steps: agent.steps,
      permissions: withCatchAllDeny(agent.permissions).map((rule) => ({
        action: rule.action,
        resource: rule.resource,
        effect: rule.effect,
      })),
    },
    { lineWidth: 0 },
  );
  return `---\n${GENERATED_LINE}\n${frontmatter}---\n${agent.systemPrompt.trim()}\n`;
}

/**
 * Parses the text that `renderAgentFile` produced and compares every field with the definition.
 * Throws `INTERNAL` on any difference, so that a serialization problem never reaches OpenCode.
 */
export function verifyRendered(agent: AgentDefinition, text: string): void {
  let problems: string[];
  try {
    const parts = splitFrontmatter(text);
    const fields = parseFrontmatter(parts.frontmatter);
    problems = [];
    if (fields["description"] !== agent.description) problems.push("description");
    if (fields["mode"] !== GENERATED_MODE) problems.push("mode");
    if (fields["model"] !== agent.model) problems.push("model");
    if (fields["steps"] !== agent.steps) problems.push("steps");
    if (!samePermissions(fields["permissions"], withCatchAllDeny(agent.permissions))) problems.push("permissions");
    if (parts.body.trim() !== agent.systemPrompt.trim()) problems.push("system prompt");
  } catch (error) {
    throw nexusError("INTERNAL", `${agent.opencodeId}: generated file cannot be parsed back`, { cause: error });
  }
  if (problems.length > 0) {
    throw nexusError("INTERNAL", `${agent.opencodeId}: generated file does not match its definition (${problems.join(", ")})`);
  }
}

/** True when the file starts with a frontmatter block whose first line is the generated marker. */
export function isGeneratedFile(text: string): boolean {
  const lines = normalizeText(text).split("\n", 3);
  return lines[0]?.trimEnd() === "---" && (lines[1]?.startsWith(GENERATED_MARKER) ?? false);
}

function samePermissions(value: unknown, expected: readonly PermissionRule[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return expected.every((rule, index) => {
    const actual = value[index] as Partial<PermissionRule> | null | undefined;
    return (
      typeof actual === "object" &&
      actual !== null &&
      actual.action === rule.action &&
      actual.resource === rule.resource &&
      actual.effect === rule.effect
    );
  });
}
