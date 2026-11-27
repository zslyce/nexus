export type ToolKind = "read" | "write" | "shell" | "other";

/**
 * Tool names are not enumerated by the OpenAPI 2.4.2 file or the installed `@opencode/client`. `read`,
 * `write`, `edit` and `shell` (and their `path` and `command` inputs) were observed in a real run against
 * OpenCode 2.4.2 on 2026-11-26 (docs/04, "Tools").
 */
const KINDS: Readonly<Record<string, ToolKind>> = {
  read: "read",
  edit: "write",
  write: "write",
  shell: "shell",
};

export function classifyTool(name: string): ToolKind {
  const kind = Object.hasOwn(KINDS, name) ? KINDS[name] : undefined;
  return kind ?? "other";
}
