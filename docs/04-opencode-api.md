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

`Service.ensure()` starts the service **[U]**. It may *replace* a service of a different version if given a version requirement: do not pass one, and call it only when `discover()` finds nothing. Its default command is `opencode serve --service`; on Windows it probably needs `command` with the path to the `.exe` (R7).

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
3. The first model/provider query for a location may come back empty: retry.
4. Repeating `session.create` with the same `id` returns the original session and ignores the new fields.
5. Repeating `prompt` with the same `id` causes no inference, but does emit another `execution.started`/`succeeded` pair.
6. `session.tool.called` does not include the tool name.
7. The event stream includes **all** of the user's sessions and directories: filter to your own sessions before logging or storing anything.
8. The stream is volatile: a slow consumer breaks it, and whatever happens while disconnected is lost.
9. Aborting the signal with a pending `next()` did not reject it and the socket stayed open; `iterator.return()` with no pending `next()` did close it (R2). Closing must be tested explicitly.
10. In Git Bash, `opencode api get /path` needs `MSYS_NO_PATHCONV=1`.

## Permissions [V]

Rule: `{ action, resource, effect: "allow"|"deny"|"ask" }`; **the last match wins**. Effective order: base rules → agent → session.

Observed base: `* * allow`, `read *.env ask`, `read *.env.* ask`, `read *.env.example allow`.

Consequences:
- An agent with `read * allow` **reopens reading `.env`** (verified: `allow`). Session rules must deny it again.
- A session `allow` rule **overrides** an agent `deny`. Nexus only adds restrictions at session level.
- The built-in `build` agent allows everything, including `external_directory`: do not use it.

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

`model` accepts `provider/model#variant`. v1 keys (`tools`, `prompt`, `permission`, `maxSteps`, `temperature`) are deprecated [D].
