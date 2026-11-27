# OpenCode 2.4.2 API (verified reference)

Source of truth: `tests/fixtures/opencode/openapi-2.4.2.json` and the types in `node_modules/@opencode/client/dist/promise/generated/`. If the web documentation disagrees, what is installed wins. Use nothing that is absent from those sources.

## Connection [V]

```ts
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";

const endpoint = await Service.discover();            // starts nothing
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
await client.server.info();                            // { version, pid, urls, ... }
```

Observed errors: `{ _tag: "SessionNotFoundError" }`, `{ _tag: "UnauthorizedError" }`, and for network failures `{ name: "ClientError", reason: "Transport" }` (no `_tag`).

`Service.ensure()` starts the service **[V, Windows, isolated registration]**. It may *replace* a service of a different version if given a version requirement: do not pass one, and call it only when `discover()` finds nothing.

- Its default command `opencode serve --service` fails on Windows with an npm install: `opencode` is a `.cmd` shim and spawning it without a shell gives `ENOENT`. Nexus uses `cmd.exe /d /c opencode serve --service --port 0` (without `cmd.exe` elsewhere, unverified).
- Without `--port` the service binds a fixed port (28894 observed); a second instance exits with code 1.
- On failure `ensure()` may report only the exit code.
- It terminates a registered service after three consecutive probe timeouts (read in the client source, not exercised; see ADR-001).
- `discover()` treats a 401 from `/api/info` as "not registered", so an authentication problem at connect looks like an unavailable service.
- `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` on the child isolate an instance; it has no providers.

## Operations

| Purpose | Client | HTTP |
|---|---|---|
| Info | `server.info()` | `GET /api/info` |
| Providers / models | `provider.list`, `model.list`, `model.default` `({location:{directory}})` | `GET /api/provider`, `/api/model` |
| Agents | `agent.list({location})` | `GET /api/agent` |
| Create session [V] | `session.create({id, location, agent, model, title, metadata, permissions})` | `POST /api/session` |
| Send [V] | `session.prompt({sessionID, id, text, files?, delivery?, resume?})` | `POST …/prompt` |
| Wait [V] | `session.wait({sessionID})` (experimental) | `POST /api/experimental/session/:id/wait` |
| Active [V] | `session.active()` → object keyed by sessionID | `GET /api/session/active` |
| State [V] | `session.get({sessionID})` → `outcome`, `cost`, `tokens`, `time` | `GET /api/session/:id` |
| List [V] | `session.list({directory})` | `GET /api/session` |
| Messages [V] | `message.list({sessionID, order, type?})` | `GET …/message` |
| Per-turn diff | `session.diff({sessionID})` → `{file, patch, additions, deletions, status}[]` | `GET …/diff` |
| Interrupt [V] | `session.interrupt({sessionID})` → `{interrupted}` | `POST …/interrupt` |
| Cancel queued input | `session.inbox.cancel` | `DELETE …/inbox/:inboxID` |
| Delete [V] | `session.remove({sessionID})` (includes children) | `DELETE /api/session/:id` |
| Permissions [V `create` only] | `permission.create/list/get/reply({sessionID, requestID, decision})` | `…/permission` |
| Forms | `session.form.cancel` | `DELETE …/form/:formID` |
| Events [V] | `event.subscribe()` | `GET /api/event` (SSE) |

Session responses arrive unwrapped (`session.create` returns the session); `model.list`, `agent.list`, `message.list` return `{ data, ... }`.

## Events [V]

Shape: `{ id, type, created, location?, durable?: { aggregateID, seq }, data }`. The first one is `server.connected`.

Real sequence of a run with one tool call:

```
session.created → session.inbox.enqueued → session.execution.started → session.instructions.updated
→ session.inbox.delivered → session.step.started → session.step.first-token
→ session.tool.input.started → session.tool.input.ended → session.tool.called → session.step.streamed
→ session.tool.success → session.step.ended → session.usage.updated
→ session.step.started → … session.text.started → session.text.delta → session.text.ended
→ session.step.ended → session.usage.updated → session.execution.succeeded
```

Cancelled: `… session.step.failed (error.type="aborted") → session.execution.interrupted (reason="user")`.

## Pitfalls

1. `model.default` returned an `opencode` (Zen) model. Always send an explicit model.
2. `session.create` accepts nonexistent agents and models: validate first.
3. The first model/provider queries for a location may come back empty, or partial for a few seconds after the service starts (observed: only `opencode` models, no `opencode-go`): retry until the required provider appears.
4. Repeating `session.create` with the same `id` returns the original session and ignores the new fields.
5. Repeating `prompt` with the same `id` causes no inference, but does emit another `execution.started`/`succeeded` pair.
6. `session.tool.called` does not include the tool name.
7. The event stream includes **all** of the user's sessions and directories: filter to your own sessions before logging or storing anything.
8. The stream is volatile: a slow consumer breaks it, and whatever happens while disconnected is lost.
9. R2, resolved: pass the signal in the request options of the client (second argument); aborting resolves a pending read and closes the socket. `return()` on an async generator waits for a pending `next()`, so close by aborting.
10. In Git Bash, `opencode api get /path` needs `MSYS_NO_PATHCONV=1`.

More observations (fixture and schema):

- Native `evt_` ids are unique per event (42 of 42).
- No `durable`: `session.usage.updated`, text and reasoning deltas, `permission.*`, `form.*`, `server.connected`. `durable.seq` is not a complete cursor.
- No `location`: `session.execution.started`/`succeeded`/`interrupted`, `session.usage.updated`. Do not filter by location.
- `form.created` carries the session at `data.form.sessionID`. `permission.asked` names the request `data.id`; `permission.replied` uses `data.requestID`.
- `session.usage.updated` is cumulative and cannot be replayed; `session.step.ended` tokens and cost are per step.
- `session.tool.success` has neither name nor input; its `content` holds the full tool output, and `session.reasoning.ended.text` the reasoning. Never persist either.
- Keepalive activity arrives about every 15 s on an idle stream.
- Only a declared `*NotFoundError` body means "not found"; a bare 404 can come from a stale or foreign endpoint. `SessionBusyError` (409) is transient.
- Schema only: `session.usage.recorded` (source `title`, `compaction`, `generate`; relates to R5) and `session.shell.started`/`ended` (R3).
- `session.tool.progress` is emitted by some tools.

## Tools [V, real run on 2026-11-26]

| Tool | Input observed | Permission action | Permission resource |
|---|---|---|---|
| `read` | `path` (absolute) | `read` | workspace-relative path |
| `grep` | `pattern`, `path` | `grep` | the search pattern |
| `glob` | `pattern`, `path` | `glob` | the file pattern |
| `write` | `path`, `content` | `edit` | workspace-relative path |
| `edit` | `path`, `oldString`, `newString` | `edit` | workspace-relative path |
| `shell` | `command`, `workdir`? | `shell` | one entry per command of a compound line |

- `grep` searches hidden folders: it returned matches from `.nexus/` in a folder without git. In a git repository a folder search skipped gitignored files, but a `path` naming a gitignored file returned its content. `glob **/*` did not list the hidden file.
- A **deny** rule fails the tool (`session.tool.failed`, `permission.rejected`) and the run continues.
- A `permission.reply` with `reject` and no message **ends the run**: tool error `aborted`, `session.step.failed`, then `session.execution.interrupted` with reason `shutdown`; `session.get` showed no `outcome` 1.5 s later. Replying with a message is untested.
- `session.diff` returned an empty list after a `write` and an `edit`, in a folder without git, in the run that ended interrupted. Cause unknown.
- No `session.usage.recorded` event appeared in three short runs; every step reported `opencode-go`.

## Permissions [V]

Rule: `{ action, resource, effect: "allow"|"deny"|"ask" }`; **the last match wins**, and matching ignores letter case (observed for actions). Effective order: base rules → agent → session.

Observed base: `* * allow`, `read *.env ask`, `read *.env.* ask`, `read *.env.example allow`.

Consequences:
- An agent with `read * allow` **reopens reading `.env`** (verified: `allow`). Session rules must deny it again.
- A session `allow` rule **overrides** an agent `deny`. Nexus only adds restrictions at session level.
- The built-in `build` agent allows everything, including `external_directory`: do not use it.
- `permission.create({sessionID, action, resources, agent})` returns `{id, effect}`, needs an existing session and evaluates that agent's rules without inference.
- `agent.list` returns the merged ruleset: base rules, then the agent's rules as one block in order, then OpenCode's `browser` and skill deny rules.

## Agents [V]

File `.opencode/agents/<id>.md`, loaded without restarting:

```yaml
---
description: ...
mode: subagent
steps: 25
permissions:
  - { action: "*", resource: "*", effect: deny }
  - { action: read, resource: "*", effect: allow }
---
System prompt.
```

A new file appears in the catalog within seconds, and a `subagent` agent can be the session agent (creation verified; no run). `model` accepts `provider/model#variant`. v1 keys (`tools`, `prompt`, `permission`, `maxSteps`, `temperature`) are deprecated [D].
