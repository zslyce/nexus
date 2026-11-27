import path from "node:path";
import { redactString } from "../utils/redact.ts";

/** Upper bounds for every string that leaves the normalizer. Nothing else from OpenCode is copied. */
export const LIMITS = {
  text: 300,
  command: 160,
  path: 260,
  identifier: 120,
  items: 5,
} as const;

const ELLIPSIS = "...";

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - ELLIPSIS.length)) + ELLIPSIS;
}

/** Collapses whitespace, removes credentials, then truncates. Redaction runs first so a cut cannot expose a secret. */
export function sanitizeText(value: string, max: number = LIMITS.text): string {
  return truncate(redactString(value.replace(/\s+/g, " ").trim()), max);
}

export function sanitizeCommand(command: string): string {
  return sanitizeText(command, LIMITS.command);
}

/** Win32 rules apply when the workspace has a drive letter or is a UNC path; POSIX rules otherwise. */
function pathLib(workspace: string): typeof path.win32 | typeof path.posix {
  return /^[a-zA-Z]:/.test(workspace) || workspace.startsWith("\\\\") ? path.win32 : path.posix;
}

/**
 * Returns the workspace-relative form of `input` (forward slashes, `.` for the root). Paths outside the
 * workspace are reduced to `[outside-workspace]/<basename>`, so no absolute location is stored.
 * Returns `undefined` when `input` is not a usable path string.
 */
export function workspacePath(workspace: string, input: unknown): string | undefined {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096 || input.includes("\0")) {
    return undefined;
  }
  const lib = pathLib(workspace);
  const root = lib.normalize(workspace);
  const target = lib.isAbsolute(input) ? lib.normalize(input) : lib.join(root, input);
  const relative = lib.relative(root, target);
  if (relative === "") return ".";
  const outside =
    lib.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${lib.sep}`) ||
    (lib === path.win32 && relative.includes(":"));
  if (outside) {
    return `[outside-workspace]/${sanitizeText(lib.basename(input), LIMITS.path)}`;
  }
  return truncate(relative.split(lib.sep).join("/"), LIMITS.path);
}
