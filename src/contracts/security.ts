import type { PermissionRule } from "./common.ts";

/**
 * Session rules sent with every `createSession`, after any other session rule (docs/06). The last
 * match wins, so the order matters. The only `allow` reopens the `.env.example` template: omit it
 * for an agent without `read`.
 *
 * `read` and `edit` send workspace-relative paths, so path rules work for them. `grep` sends the search
 * pattern, so no rule can hide a file from it: real runs returned the content of `.env` and
 * `.nexus/daemon.json` (docs/06).
 */
export const MANDATORY_SESSION_RULES: readonly PermissionRule[] = [
  { action: "external_directory", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "read", resource: ".nexus/*", effect: "deny" },
  { action: "read", resource: "*/.nexus/*", effect: "deny" },
  { action: "edit", resource: ".nexus/*", effect: "deny" },
  { action: "edit", resource: "*/.nexus/*", effect: "deny" },
  { action: "glob", resource: ".nexus/*", effect: "deny" },
  { action: "glob", resource: "*/.nexus/*", effect: "deny" },
];
