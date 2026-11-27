# Technical decisions (ADR)

## ADR-001 · OpenCode client: `@opencode/client` 2.4.2 (pinned)
`fetch`-based Promise entry point, types generated from the server, and `Service.discover()/ensure()`, which resolves URL and credentials without Nexus reading or storing them.
Rejected: `@opencode-ai/sdk` (v1 API); `@opencode/sdk` (hosts an in-process server instead of reusing the shared service); hand-written HTTP (duplicates discovery and types).
Accepted cost: it pulls in `effect` (~60 MB on disk; importing the client took ~50 ms). Only `src/server/**` imports it, so it can be replaced.

## ADR-002 · Local daemon + thin clients
One daemon per workspace owns the database, the scheduler and the single SSE subscription. The MCP server, CLI and dashboard are `BridgeApi` clients.
Reason: tasks survive closing Claude Code and the dashboard, several Claude sessions cannot duplicate runs, and SQLite has a single writer.

## ADR-003 · Persistence with `node:sqlite`
Built into Node 24 (SQLite 3.53), no native dependencies. WAL mode, numbered migrations.

## ADR-004 · IPC: HTTP over a named pipe / Unix socket with a token
`\\.\pipe\nexus-<workspace hash>` on Windows; `.nexus/daemon.sock` on Unix. The pipe name doubles as a single-instance lock (`EADDRINUSE` = a daemon already exists). Random token in `.nexus/daemon.json`. No TCP port is opened.

## ADR-005 · MCP: `@modelcontextprotocol/server` 2.x over stdio, with `zod` 4
Standalone server package, lighter than the monolithic `@modelcontextprotocol/sdk` (Express, Hono, etc.). **[U]** WP-08 confirms compatibility with Claude Code 2.1.331; if it fails, use `@modelcontextprotocol/sdk` and record it here.

## ADR-006 · Dashboard with Ink 8 + React 19
Maintained and widely used. No TSX (`createElement`), so TypeScript runs and is tested without a build step.

## ADR-007 · Node's native TypeScript and `node:test`
No `vitest`, `tsx` or bundler in development. Requires erasable syntax (no `enum`, no parameter properties) and relative imports with the `.ts` extension; `tsc` rewrites them to `.js` at build time.

## ADR-008 · OpenCode Go only
`allowedProviders: ["opencode-go"]`. The daemon validates the model before creating the session (OpenCode accepts nonexistent agents and models at creation), always sends an explicit model and, if `session.step.started` reports another provider, interrupts the task. Nexus makes no inference calls of its own.
`*-free` and `*-contributor*` models are not used by default: they may carry different data-use terms (review them before choosing one).

## ADR-009 · Agents: a single source, generated OpenCode files
`explorer`, `developer` and `critic` live in `.claude/agents/` (created for this project). Each is declared in `nexus.config.json` with `"from"` and inherits `description` and prompt from there. Claude Code-specific fields (`tools`, `model`, `effort`) are not imported: the OpenCode model and permissions are declared in Nexus because the formats are not equivalent. The registry generates `.opencode/agents/nexus-<name>.md` (git-ignored, with a generated marker). It never modifies `.claude/agents/` or global configuration.

Initial models (editable), cost first:

| Agent | OpenCode model | $/M input · output · cache read* | In Claude Code |
|---|---|---|---|
| explorer | `opencode-go/mimo-v2.6-flash` (no variants) | 0.14 · 0.28 · 0.0028 | haiku, low |
| developer | `opencode-go/deepseek-v4.1-flash#high` | 0.15 · 0.60 · 0.003 | haiku, medium |
| critic | `opencode-go/gpt-6-luna#medium` (different family from developer) | 0.10 · 0.50 · 0.01 | haiku, medium |

\* OpenCode catalog as of 2026-11-26; useful to compare quota consumption, it is not a charge. `gpt-6-luna` has a second price tier. All three answered using tools in a minimal test; their quality on real tasks is unmeasured.

## ADR-010 · Plugin distribution — **pending (WP-10)**
Criteria: installable from a local marketplace, no versioned absolute paths, and no dependency on `node_modules` outside the copied folder. Candidates: (a) build and bundle the server inside `plugin/`; (b) a global `nexus` bin invoked from `.mcp.json` (through `cmd /c` on Windows). For development: `claude --plugin-dir ./plugin`.

## ADR-011 · Permissions: never auto-approve
By default a `permission.asked` is rejected and recorded. With `permissionPolicy: "surface"` the task stays in `waiting` until timeout or cancellation. v1 has no MCP tool to approve permissions and never uses `--auto`.

## ADR-012 · Conservative retries
OpenCode already retries provider errors (`session.retry.scheduled`). Nexus retries with exponential backoff only if: (a) the failure happened before the prompt was admitted (same IDs, idempotent), or (b) the run failed with a transient error (429, 5xx, network) **and modified no files** (new session, attempt +1). Timeouts and cancellations are not retried.

## ADR-013 · Results without extra inference
`summary` comes from the `## Summary` section that the agent prompts ask for; if missing, from the start of the last message.

## ADR-014 · Cost first
Cheapest models and effort matched to difficulty, both for the subagents that build Nexus (haiku, see [08](08-orchestration.md)) and for the ones Nexus runs. Moving up a model requires a demonstrated failure. For the plugin skills, see [05](05-interfaces.md).

## ADR-015 · English only in the repository
Documentation, skills, agent prompts, comments, user-facing messages, test names, file names and commit messages are written in English. Chat with the user is in Spanish.
