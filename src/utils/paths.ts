import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { NexusError } from "../contracts/index.ts";
import { nexusError } from "./errors.ts";

const IS_WINDOWS = process.platform === "win32";
const lex = IS_WINDOWS ? path.win32 : path.posix;

/** Canonical (realpath) form of an existing workspace directory. */
export function canonicalWorkspace(workspace: string): string {
  let real: string;
  try {
    real = realpathSync.native(workspace);
  } catch (error) {
    throw nexusError("NOT_FOUND", `workspace does not exist or cannot be read: ${workspace}`, { cause: error });
  }
  if (!statSync(real).isDirectory()) {
    throw nexusError("VALIDATION", `workspace is not a directory: ${real}`);
  }
  return real;
}

/**
 * Validates a path supplied by a user or an agent and returns its canonical workspace-relative form
 * (forward slashes, `.` for the workspace root). Throws `PATH_OUTSIDE_WORKSPACE` when the target,
 * after resolving links and junctions, is not inside the workspace.
 *
 * Accepted inputs: relative paths (also through `..` that stays inside), absolute paths inside the
 * workspace, and paths that do not exist yet. Rejected: absolute paths elsewhere, UNC and other drives,
 * drive-relative (`C:foo`), rooted paths without a drive, alternate data streams (`:` in names), and
 * links or junctions whose target is outside. On Windows the comparison is case-insensitive.
 */
export function resolveWorkspacePath(workspace: string, input: string): string {
  validateInput(input);
  const root = canonicalWorkspace(workspace);
  const target = lexicalTarget(root, input);
  assertInside(root, target, input);
  const real = realpathOfNearestAncestor(target, input);
  assertInside(root, real, input);
  const relative = lex.relative(root, real);
  return relative === "" ? "." : relative.split(lex.sep).join("/");
}

function validateInput(input: string): void {
  if (typeof input !== "string" || input.length === 0) {
    throw nexusError("VALIDATION", "path must be a non-empty string");
  }
  if (input.includes("\0")) {
    throw nexusError("VALIDATION", "path contains a NUL byte");
  }
}

function lexicalTarget(root: string, input: string): string {
  if (IS_WINDOWS) {
    if (/^[a-zA-Z]:(?![\\/])/.test(input)) {
      throw outside(input, "drive-relative paths are not allowed");
    }
    if (/^[\\/](?![\\/])/.test(input)) {
      throw outside(input, "rooted paths without a drive are not allowed");
    }
    const withoutDrive = /^[a-zA-Z]:[\\/]/.test(input) ? input.slice(2) : input;
    if (withoutDrive.includes(":")) {
      throw outside(input, "colons are not allowed in paths");
    }
  }
  if (lex.isAbsolute(input)) return lex.normalize(input);
  return lex.join(root, input);
}

function assertInside(root: string, target: string, input: string): void {
  const relative = lex.relative(root, target);
  if (relative === "") return;
  if (lex.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${lex.sep}`)) {
    throw outside(input);
  }
}

/**
 * Resolves links for the longest existing ancestor of `target` and re-appends the missing tail.
 * A dangling link or an unexpected error cannot prove containment, so it fails closed.
 */
function realpathOfNearestAncestor(target: string, input: string): string {
  let current = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length === 0 ? real : lex.join(real, ...tail);
    } catch (error) {
      const code = codeOf(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw outside(input, "cannot be verified");
      }
      if (existsAsLink(current)) {
        throw outside(input, "is a link that cannot be resolved");
      }
      const parent = lex.dirname(current);
      if (parent === current) {
        throw outside(input, "cannot be verified");
      }
      tail.unshift(lex.basename(current));
      current = parent;
    }
  }
}

function existsAsLink(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function outside(input: string, reason?: string): NexusError {
  const suffix = reason === undefined ? "" : `: ${reason}`;
  return nexusError("PATH_OUTSIDE_WORKSPACE", `path "${input}" is outside the workspace${suffix}`);
}
