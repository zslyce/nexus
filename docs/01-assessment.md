# Environment assessment (Phase 1)

Date: 2026-11-26. Marks: **[V]** verified on this machine, **[D]** official documentation only, **[U]** unverified.

## Environment

| Component | State [V] |
|---|---|
| OS | Windows 11 Pro; PowerShell and Git Bash |
| Claude Code | 2.1.331 |
| OpenCode | 2.4.2 (`@opencode/cli`, global npm install) |
| Node / npm | 24.20.0 / 11.19.0 (no pnpm or bun) |
| Project | `d:\Dev\nexus` was empty and had no git (repository initialized afterwards) |
| OpenCode service | Running on `127.0.0.1` (port assigned at startup), Basic auth |
| OpenCode credentials | One, "OpenCode Personal"; covers `opencode` (Zen) and `opencode-go` |
| `opencode-go` models | 31 enabled (`npm run probe` lists them) |
| OpenCode config | `~/.config/opencode/opencode.jsonc` only has `$schema`; there is a `package.json` with `@opencode-ai/plugin` 1.18.25 (v1 leftover, left untouched) |
| MCP in OpenCode | None |
| MCP in Claude Code | `unity-mcp` (global, tool fetch timed out) and `claude.ai Claude Docs`; no project `.mcp.json` |
| Claude Code hooks | `Notification`, `Stop`, `SubagentStop` → `~/.claude/notify.js` |
| Plugins / skills | `codex` plugin (disabled); skills `archify`, `caveman`, `find-skills` |
| `.claude/agents/` agents | **None** in the project, in `~/.claude`, or in any project under `d:\Dev` |

## Mismatches with the brief

| # | The brief assumes | Reality | Resolution |
|---|---|---|---|
| 1 | Custom agents exist in `.claude/agents/` | None found | Created in `.claude/agents/` and linked from `nexus.config.json` (ADR-009) |
| 2 | SDK and API as in the classic documentation | OpenCode v2: `@opencode/*` packages, `/api/*` routes. `@opencode-ai/sdk` is v1 | `@opencode/client` 2.4.2 (ADR-001) |
| 3 | An abort endpoint | There is no `abort`; it is `session.interrupt` [V] | See [04](04-opencode-api.md) |
| 4 | Plugin at `.claude/plugins/opencode-bridge/plugin.json` | The manifest goes in `<plugin>/.claude-plugin/plugin.json` [D] | Plugin in `plugin/` |
| 5 | An `/agents` command | Collides with Claude Code's built-in command; the built-in wins [D] | `/nexus:agents` |
| 6 | TUI dashboard inside the Claude Code flow | A Claude Code command cannot host an interactive TUI, least of all in the VS Code extension | `nexus monitor` in a separate terminal; `/monitor` gives a snapshot and the command to run |
| 7 | The MCP server runs the tasks | Claude Code closes the MCP server when the session ends and on Windows ends its process tree [D] | Separate daemon (ADR-002) |
| 8 | Costs are available | OpenCode reported `cost: 0` for `opencode-go` sessions [V]; catalog list prices are not the actual charge | Show tokens and the *reported* cost; compute nothing |
| 9 | Choosing a model can be optional | The server's default model belongs to `opencode` (Zen, pay per use) [V] | Always send an explicit model and enforce a provider allowlist (ADR-008) |

## What was tested against the real server

With temporary scripts, in a temporary folder, with a read-only agent:

- Discovery and authentication through `Service.discover()`; `401` without credentials.
- Listing providers, models and agents; hot loading of a `.opencode/agents/*.md` agent.
- Permission rule evaluation (no inference).
- Session creation with a caller-supplied ID (repeating it returns the existing one) and deletion.
- 5 minimal prompts to `opencode-go/deepseek-v4.1-flash` (uses subscription quota, reported cost 0): file read, SSE events, resend with the same `messageId` (no second inference) and interruption (`outcome: interrupted`).
- Then 1 prompt per default model (`mimo-v2.6-flash`, `deepseek-v4.1-flash#high`, `gpt-6-luna#medium`): all three succeeded using tools.
- Test sessions were deleted; none remained in that folder.

Not tested: `ask` permissions end to end, forms, `edit`/`shell` tools, SSE reconnection, or starting the service when none is running.

## Saved evidence

`tests/fixtures/opencode/`: the server 2.4.2 OpenAPI specification, 42 real events (one completed run and one cancelled run) and their messages, with personal paths replaced.

## Open risks

| ID | Risk | Closed by |
|---|---|---|
| R1 | On Windows, a daemon launched from the MCP server might die with its process tree | WP-07 / WP-11 |
| R2 | Aborting the signal did not reliably close the event stream (the socket stayed open) | WP-02 |
| R3 | `resource` format of the `edit`/`shell` actions and exact names of the write tools | WP-04 / WP-05 |
| R4 | `shell` patterns with `*` might allow chained commands | WP-05 (mandatory test) |
| R5 | Hidden agents (title, compaction) might use a model outside `opencode-go` | WP-11 |
| R6 | `session.log` only returned `log.synced` for a session with no runs: replay unconfirmed | WP-06 (do not depend on it) |
| R7 | Auto-start on Windows: the default command is `opencode` (a `.cmd`) | WP-02 |
| R8 | Plugin distribution: the install cache copies only the plugin folder | WP-10 |
