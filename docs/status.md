# Status

Updated by the orchestrator only.

| WP | Title | Wave | State | Notes |
|---|---|---|---|---|
| — | Foundation and documentation | 0 | done | typecheck and 4 fixture tests passing; agents created, low-cost models, git initialized |
| 01 | Config and utilities | 1 | done | |
| 02 | OpenCode gateway | 1 | done | R2 and R7 closed; accepted `ensure()` risk in ADR-001 |
| 03 | Storage | 1 | done | |
| 04 | Events | 1 | done | R3 closed by a real run |
| 05 | Agent registry | 1 | done | R4 observed; developer patterns unchanged |
| 06 | Task core | 2 | pending | R6; notes from wave 1 in the package |
| 07 | Daemon, IPC and CLI | 3 | pending | R1; decide where the daemon token lives |
| 08 | MCP server | 3 | pending | ADR-005 |
| 09 | Dashboard | 3 | pending | |
| 10 | Plugin and installation | 4 | pending | R8, ADR-010 |
| 11 | Integration tests | 4 | pending | R1, R5 |
| 12 | Review and README | 5 | pending | |

## Wave 1 gate (2026-11-26): passed

Run by the orchestrator after the review fixes:

- `npm run typecheck` and `npm run build`: pass.
- `npm test`: 365 tests, 364 pass, 1 skipped (file symlinks need privileges on this Windows host).
- Integration without inference (`server-gateway`, `server-subscribe`, `agents-permissions`): 16 of 16 pass against the shared service.
- `server-startup.test.ts` was run by the WP-02 subagent (2 of 2), not by the orchestrator.

`nexus-reviewer` reviewed WP-01 to WP-04 and WP-05 separately. One fix round per package; the fixes were not reviewed again by `nexus-reviewer`. No package needed a larger model.

## Inference probe (2026-11-26, authorized by the user)

Four prompts to `opencode-go/deepseek-v4.1-flash#low` in two temporary folders (three for R3 and R4, one for `grep` against `.env`); all four sessions and both folders were removed. Verified against the service: prompt, permission reply, `getOutput`, `getDiff`, session removal and the normalizer on real events. Results in docs/04 ("Tools") and docs/06.

## Open items

| Item | Blocks |
|---|---|
| `grep` returns the content of `.env` and `.nexus/` files despite the `read` deny (confirmed): decide whether agents keep `grep` | any use on workspaces with secrets |
| The daemon token must live outside the workspace | WP-07 |
| Rejecting a permission ends the run; `getDiff` came back empty | WP-06 |
| Shell behaviour when the tool shell is `cmd.exe`, and `$(…)` | developer agent on other machines |
| Interrupt against a real run, and R5 (hidden agents) | WP-11 |
| `tests/integration/server-gateway.test.ts` keeps its own copy of the mandatory session rules | WP-11 |
