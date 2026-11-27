# Architecture

```
Claude Code ──stdio/MCP──► nexus mcp ─────┐
Terminal ─────────────────► nexus monitor ┤ IPC (BridgeApi, ADR-004)
Terminal ─────────────────► nexus <cli> ──┘
                                          ▼
                              nexus daemon (one per workspace)
                 TaskManager · Scheduler · Locks · Recovery
                 EventNormalizer · EventManager · Store (SQLite)
                 AgentRegistry · ResultBuilder · OpenCodeGateway
                                          │ @opencode/client (HTTP + SSE)
                                          ▼
                       Shared OpenCode service ──► OpenCode Go
```

## Modules and ownership

Each folder has a single owning work package. Dependencies between modules go through `src/contracts/`.

| Folder | Responsibility | Implements | Consumes | WP |
|---|---|---|---|---|
| `src/contracts` | Shared types | — | — | orchestrator |
| `src/config`, `src/utils` | Config loading and validation, redacting logger, errors, safe paths, IDs, backoff | `Logger`, `NexusConfig` | — | 01 |
| `src/server` | Connection, discovery, client adapter | `OpenCodeGateway` | `@opencode/client` | 02 |
| `src/storage` | SQLite, migrations, retention | `Store` | `node:sqlite` | 03 |
| `src/events` | Normalizer and bus (persist → publish) | `EventNormalizer`, `EventBus` | `Store` | 04 |
| `src/agents` | Registry, import and generation | `AgentRegistry` | config | 05 |
| `src/tasks` | States, scheduler, dependencies, locks, retries, timeouts, cancellation, recovery, results | core of `BridgeApi` | gateway, store, normalizer, registry | 06 |
| `src/daemon`, `src/ipc`, `src/cli`, `src/index.ts` | Composition, lifecycle, IPC, CLI | `BridgeApi` server and client | everything | 07 |
| `src/mcp` | MCP tools | — | `BridgeApi` | 08 |
| `src/dashboard` | TUI and headless mode | — | `BridgeApi` | 09 |
| `plugin/` | Manifest, `.mcp.json`, commands | — | — | 10 |

## State machine

```
pending ─deps ok─► queued ─slot+lock─► starting ─execution.started─► running ⇄ waiting
running | waiting ─► completed | failed
pending | queued | starting ─► failed          (failed dependency, validation, non-transient failure)
starting ─transient failure─► queued           (backoff, same IDs; ADR-012a)
running | waiting ─transient failure─► queued  (backoff, attempt +1 and new session; ADR-012b)
any non-terminal state ─cancel─► cancelling ─interruption confirmed─► cancelled
cancelling ─run ended first─► completed | failed
```

- `pending`/`queued` are cancelled directly.
- `cancelling` becomes `cancelled` once OpenCode confirms the session is not active. If `interrupt` fails it stays in `cancelling` and is retried: something still running is never declared cancelled. If the run ended before the interrupt took effect, the task ends with that real outcome.
- Timeout: interrupt and end as `failed` with code `TIMEOUT`.
- Transitions and their `TASK_*` events are written in a single transaction. A result is saved after the task reaches the matching terminal status, in that same transaction.
- The store enforces these rules: terminal states are final; `id`, `agent`, `prompt`, `idempotencyKey` and `createdAt` never change; `promptMessageId` changes only with a higher attempt. The task core changes `sessionId` only with a new attempt. New tasks are `pending` or `queued`, dependencies are inserted first, and at most one active task exists per idempotency key.

## Starting a task

1. Validate agent, allowed and available model, paths, and dependencies (no cycles).
2. Generate `id` (`tsk_` + 20 hex), `sessionId` (`ses_nexus_` + 16 hex), `promptMessageId` (`msg_nexus_` + 16 hex) and persist **before** calling OpenCode. `files` are stored in the canonical form returned by the path guard (resolved through `realpath`), so two aliases of a file cannot bypass the lock.
3. Make sure the SSE subscription is active.
4. `createSession` (idempotent) → `prompt` (idempotent).
5. The prompt includes the task, context, relevant files and, for each dependency, its summary (truncated to 4,000 characters).

## Scheduler

A task is eligible when its dependencies are `completed`, there is a global and per-agent slot, `notBefore` has passed, and it can take its lock. FIFO by creation order; a blocked task does not stall later eligible ones.

**Write lock** (agents with `canWrite`): the scope is the task's `files`; without `files`, the whole workspace. Two scopes conflict if they share a path, one contains the other, or either is global. Readers are not locked. Limit: `shell` can touch files outside the declared scope (see [06](06-security.md)).

## Events

Only the TaskManager emits `TASK_*`. The normalizer translates native events:

| OpenCode | Nexus events | Signal |
|---|---|---|
| `session.execution.started` | `AGENT_STARTED` | `execution_started` |
| `session.step.started` | — | `model_used`, `stage: analysis` |
| `session.reasoning.started` | `AGENT_THINKING` | `activity` |
| `session.tool.input.started` | — (remember `id`→`name`) | |
| `session.tool.called` | `AGENT_TOOL_STARTED` | `activity`, `stage` |
| `session.tool.success` | `AGENT_TOOL_COMPLETED` + `FILE_READ` / `FILE_MODIFIED` / `COMMAND_EXECUTED` | `file_modified` |
| `session.tool.failed` | `AGENT_TOOL_COMPLETED {ok:false}`, `WARNING` | |
| `session.step.ended` | `FILE_MODIFIED` for each of `files` not emitted yet | `stage: finalization` if `finish = stop` |
| `session.step.failed` (≠ `aborted`) | `ERROR` | |
| `session.retry.scheduled` | `WARNING` | `activity` |
| `permission.asked`, `form.created` | `AGENT_WAITING` | `permission_asked`, `form_asked` |
| `permission.replied`, `form.replied`, `form.cancelled` | — | `permission_resolved` |
| `session.usage.updated` | — | `usage` (cumulative) |
| `session.execution.succeeded` | `AGENT_FINISHED` | `execution_succeeded` |
| `session.execution.failed` | `ERROR` | `execution_failed` |
| `session.execution.interrupted` | `AGENT_FINISHED` | `execution_interrupted` (`reason` only if recognised) |
| `*.delta`, anything else | dropped (not persisted) | |

The caller routes each native event with `sessionIdOf` and drops sessions it does not own; the normalizer also ignores any session other than the bound one. It calls `forget` when an attempt ends and, after a restart, `restore` with the stored stage. Signals are returned even when an event cannot be persisted (no native id). The bus persists first and delivers asynchronously, after the current synchronous work.

## History

`prune` never deletes non-terminal tasks, their direct or transitive dependencies, or their events, and never deletes a task that a kept task depends on.

## Stages (no percentages)

| Stage | Evidence |
|---|---|
| `initialization` | task `starting`, no steps yet |
| `analysis` | first `step.started` |
| `execution` | first modifying tool (`edit`/write, or a non-validation `shell`) |
| `validation` | `shell` matching `validationCommandPatterns` **after** files were modified |
| `finalization` | step with `finish = stop` |

Monotonic within an attempt. A read-only agent goes from `analysis` to `finalization`. Progress within a stage is indeterminate.

## Completion

On `execution_succeeded`: `getOutput` + `getDiff` → `TaskResult` → `completed`. If the prompt is not recorded as delivered or there is no assistant output, the task is `failed`. Rejected permissions are listed in `errors` even if the task completes.

## Recovery and reconnection

The SSE stream is volatile. When the daemon starts and after every reconnection (exponential backoff), for each non-terminal task:

| Situation | Action |
|---|---|
| `pending`/`queued` | schedule again |
| Session active | keep listening; rebuild usage from `getSession` |
| Idle with `outcome` and prompt delivered | finalize with that outcome |
| Idle without `outcome` or prompt not delivered | resend with the same `messageId` |
| Session missing and task was `starting` | create again (same ID) |
| Session missing and task had already run | `failed`, `ORPHANED_SESSION`; do not rerun |
| Task was `cancelling` | interrupt and confirm |

Workspace sessions with an unknown `metadata.nexusTaskId` are reported as orphaned in `serverStatus().warnings`; they are not deleted.

Reconciliation never depends on missed events or on `session.log` (R6).
