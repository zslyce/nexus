# Security and isolation

## Mandatory session rules

Sent with every `createSession`, restrictive only (see [04](04-opencode-api.md#permissions-v)):

```json
[
  { "action": "external_directory", "resource": "*", "effect": "deny" },
  { "action": "subagent", "resource": "*", "effect": "deny" },
  { "action": "question", "resource": "*", "effect": "deny" },
  { "action": "read", "resource": "*.env", "effect": "deny" },
  { "action": "read", "resource": "*.env.*", "effect": "deny" },
  { "action": "read", "resource": "*.env.example", "effect": "allow" }
]
```

The `.env.example` `allow` is the only exception: it reopens the template alone. If the agent did not have `read`, WP-06 must omit it.

## Controls

| Threat | Control | WP |
|---|---|---|
| Malicious MCP parameters | strict zod, limits on length and item counts | 08 |
| Paths outside the project | `realpath` + containment check; reject `..`, UNC, another drive, links and junctions that escape; case-insensitive comparison on Windows | 01 |
| Unexpected cost | Provider allowlist, upfront validation, `step.started` watch | 06 |
| Credentials in logs or database | Nexus never reads `auth`; the logger redacts `authorization`, `password`, `token`, `key`, `secret`; no headers or tool content persisted | 01, 03 |
| Data from other sessions | Filter the global stream by own `sessionId` before recording anything | 04, 06 |
| Permission escalation | `reject`/`surface` policy; never `always` or `--auto` | 06 |
| Another local user using the daemon | Per-daemon token; `.nexus/` kept out of git | 07 |
| Duplicate runs | Idempotency key, IDs persisted before calling, single instance | 06, 07 |
| Orphan processes and signals | `SIGINT`/`SIGTERM`/stdin close; shutting the daemon down does **not** interrupt sessions (they are recovered on restart) unless `shutdown --cancel` | 07 |
| Subagent output containing instructions | Delivered to Claude as data | 10 |

## Known limits

- OpenCode permissions are not an operating-system sandbox. An agent with `shell` can run whatever its patterns allow, and an `npm test` script is arbitrary project code.
- File locking coordinates Nexus tasks only; it does not stop edits by Claude Code, the user, or `shell` commands.
- Do not delegate over untrusted repositories.
