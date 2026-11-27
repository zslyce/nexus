# Security and isolation

## Mandatory session rules

Defined once as `MANDATORY_SESSION_RULES` in `src/contracts/security.ts`, sent with every `createSession` after any other session rule, restrictive only (see [04](04-opencode-api.md#permissions-v)):

```json
[
  { "action": "external_directory", "resource": "*", "effect": "deny" },
  { "action": "subagent", "resource": "*", "effect": "deny" },
  { "action": "question", "resource": "*", "effect": "deny" },
  { "action": "read", "resource": "*.env", "effect": "deny" },
  { "action": "read", "resource": "*.env.*", "effect": "deny" },
  { "action": "read", "resource": "*.env.example", "effect": "allow" },
  { "action": "read", "resource": ".nexus/*", "effect": "deny" },
  { "action": "read", "resource": "*/.nexus/*", "effect": "deny" },
  { "action": "edit", "resource": ".nexus/*", "effect": "deny" },
  { "action": "edit", "resource": "*/.nexus/*", "effect": "deny" },
  { "action": "glob", "resource": ".nexus/*", "effect": "deny" },
  { "action": "glob", "resource": "*/.nexus/*", "effect": "deny" }
]
```

The `.env.example` `allow` is the only exception: it reopens the template alone. If the agent did not have `read`, WP-06 must omit it.

The `.nexus` rules stop `read` and `edit` of the daemon token and the task history. They do not stop `grep` (next section), so the token must not live in the workspace (WP-07).

## `grep` bypasses every file deny (confirmed in real runs, 2026-11-26)

The permission resource of `grep` is the search pattern, so no rule can protect a file from it. With the mandatory rules active:

- `read` of `.env` was denied.
- A folder search returned the content of `.env.local` (not gitignored) and, in a folder without git, of `.nexus/daemon.json`.
- A folder search in a git repository skipped the gitignored `.env` and `.nexus/`.
- A search with `path` set to the gitignored `.env` **returned its content**.

`.gitignore` is therefore not a protection. Any agent allowed to `grep` can send secrets of the workspace to the model provider and into its result. Until a decision is taken (see [status](status.md)), do not delegate on workspaces that hold secrets. The only rule that closes this is denying `grep` altogether.

## Agent definitions

Every generated agent file starts with a catch-all `deny`, because OpenCode's base ruleset allows everything. An agent without `canWrite` may `allow` or `ask` only `read`, `glob` and `grep`.

## Controls

| Threat | Control | WP |
|---|---|---|
| Malicious MCP parameters | strict zod, limits on length and item counts | 08 |
| Paths outside the project | `realpath` + containment check; reject `..`, UNC, another drive, links and junctions that escape; case-insensitive comparison on Windows | 01 |
| Unexpected cost | Provider allowlist, upfront validation, `step.started` watch | 06 |
| Credentials in logs or database | Nexus never reads `auth`; the logger and gateway errors are redacted (rule below); no headers or tool content persisted | 01, 02, 04 |
| Data from other sessions | Filter the global stream by own `sessionId` before recording anything | 04, 06 |
| Permission escalation | `reject`/`surface` policy; never `always` or `--auto` | 06 |
| Another local user using the daemon | Per-daemon token; `.nexus/` kept out of git | 07 |
| Duplicate runs | Idempotency key, IDs persisted before calling, single instance | 06, 07 |
| Orphan processes and signals | `SIGINT`/`SIGTERM`/stdin close; shutting the daemon down does **not** interrupt sessions (they are recovered on restart) unless `shutdown --cancel` | 07 |
| Subagent output containing instructions | Delivered to Claude as data | 10 |

## Redaction rule

A key is redacted when one of its words (split on camelCase, `_`, `-`, `.`) is `authorization`, `password`, `passwd`, `secret`, `token`, `key` or `apikey`, or when a one-word key ends with one of them (except `key`). Plural counters (`tokens`, `maxTokens`) stay readable and `idempotencyKey` is exempt. Any other `*Key` name, such as `BatchItem.key`, is logged as `[REDACTED]`. In free text, `Authorization`, `Bearer` and `name=value` secrets are scrubbed, also inside escaped JSON.

## Known limits

- Redaction depends on markers: a bare secret in free text is not detected.
- **R4, observed on Windows (2026-11-26):** the shell tool splits a compound command and evaluates each part, so `npm test && del x` was denied under the developer patterns and nothing ran. A single-quoted `npm test '&del x&echo '` was allowed and did not delete the file: the shell read the quotes as quotes, so it was not `cmd.exe`. Not tested: a machine whose tool shell is `cmd.exe`, subexpressions such as `$(…)`, and PowerShell-only syntax. Shell metacharacter deny rules are not adopted. The patterns still allow arbitrary code through arguments and project scripts (`npm run *`, `node --test --import …`), which an agent with `edit` can write itself.

- OpenCode permissions are not an operating-system sandbox. An agent with `shell` can run whatever its patterns allow, and an `npm test` script is arbitrary project code.
- File locking coordinates Nexus tasks only; it does not stop edits by Claude Code, the user, or `shell` commands.
- Do not delegate over untrusted repositories.
