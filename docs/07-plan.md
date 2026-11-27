# Implementation plan

## Waves

| Wave | Packages (parallel) | Exit gate |
|---|---|---|
| 0 | Foundation: documentation, contracts, subagents | done |
| 1 | WP-01 · WP-02 · WP-03 · WP-04 · WP-05 | `typecheck` + `test` + review |
| 2 | WP-06 | same, with a fake gateway |
| 3 | WP-07 · WP-08 · WP-09 | `build` + daemon and MCP startup |
| 4 | WP-10 → WP-11 | real end-to-end |
| 5 | WP-12 | acceptance criteria |

Recommended maximum: 3 subagents at a time. Details for each package in [wp/](wp/); state in [status.md](status.md).

Mapping to the phases of the brief: P1 → wave 0; P2 → WP-02; P3 → WP-05, 06; P4 → WP-04; P5 → WP-08; P6 → WP-09; P7 → WP-03, 06; P8 → WP-07, 10; P9 → WP-11; P10 → WP-12.

## Mandatory test matrix

| # | Test | Unit | Integration (real) |
|---|---|---|---|
| 1 | Connection | 02 | 02 |
| 2 | Existing Go authentication | — | 02 (query) · 11 (inference) |
| 3 | Session creation | 02 | 02 |
| 4 | Model selection | 05, 06 | 11 |
| 5 | Task execution | 06 | 11 |
| 6 | SSE events | 02, 04 | 11 |
| 7 | Normalization | 04 (real fixtures) | 11 |
| 8 | Parallelism | 06 | 11 |
| 9 | Dependencies | 06 | 11 |
| 10 | Cancellation | 06 | 11 |
| 11 | Recovery after restart | 03, 06 | 11 |
| 12 | Connection errors | 02, 06 | 11 |
| 13 | Timeouts | 06 | 11 |
| 14 | Dashboard | 09 | 09 (manual, documented) |
| 15 | MCP tools | 08 | 11 |

Integration tests are skipped without `NEXUS_INTEGRATION=1`; those that consume inference also require `NEXUS_INFERENCE=1`, use `opencode-go/deepseek-v4.1-flash#low`, work in a temporary folder and delete their sessions.

## Acceptance criteria (WP-12 ticks them with evidence)

- [ ] Claude Code delegates tasks to OpenCode
- [ ] OpenCode Go uses the existing authentication
- [ ] Several agents at once
- [ ] Non-blocking status queries
- [ ] Real-time events
- [ ] Dashboard shows correct states
- [ ] Real cancellation
- [ ] Results returned to Claude
- [ ] Sessions and history preserved
- [ ] No inference outside OpenCode Go
- [ ] Existing agents and configuration intact
- [ ] Installation documented
