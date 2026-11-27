# Orchestrating the implementation with subagents

The main Claude plans, launches subagents, verifies and decides. It does not implement packages beyond minor integration.

## Subagents (`.claude/agents/`)

| Subagent | Model | Effort | Packages |
|---|---|---|---|
| `nexus-core` | haiku | high | 01, 03, 05, 06 (launch 06 with effort `xhigh`) |
| `nexus-opencode` | haiku | high | 02, 04 |
| `nexus-interface` | haiku | medium | 07, 08, 10 |
| `nexus-dashboard` | haiku | low | 09 |
| `nexus-qa` | haiku | medium | 11 |
| `nexus-reviewer` | haiku | high | review of each wave, 12 |

The `/nexus-wave` skill uses haiku with effort medium. That setting applies to the turn in which it is invoked; later turns use the session model (to make them cheaper: `/model haiku`).

## Cost policy

1. Haiku by default, with the effort in the table.
2. A package that misses the gate on the first round goes back to the same subagent with the concrete failures.
3. If it still fails after 2 rounds, relaunch **only that package** with `model: sonnet` and effort `medium`, telling the user why before doing it.
4. Never opus or fable without the user's permission.
5. The gate is not relaxed because a cheap model was used: `typecheck`, tests and all acceptance criteria.

## Two kinds of agents in `.claude/agents/`

- `nexus-*`: Claude Code subagents that **build** Nexus.
- `explorer`, `developer`, `critic`: reference for the agents Nexus **will run in OpenCode** (shared prompt; model and permissions in `nexus.config.json`). Do not use them to build Nexus.

Claude Code loads agents when a session starts: restart the session if they do not show up.

## Cycle per wave (`/nexus-wave <n>`)

1. Read `status.md`; confirm the previous wave is closed.
2. Launch one subagent per package with this prompt:
   > Implement `docs/wp/WP-XX.md`. Follow `CLAUDE.md`. Report using the report format.
3. When it finishes, the orchestrator runs `npm run typecheck` and `npm test` itself; it does not rely on the report.
4. Resolve requests to change contracts or dependencies (only the orchestrator touches those files) and notify whoever is affected.
5. `nexus-reviewer` reviews the wave against the packages and `06-security.md`.
6. Send findings back to the same subagent (SendMessage), following the cost policy.
7. Update `status.md`.

## Isolation

Each package writes only in its own folders and in `tests/**/<module>*`. The git repository allows reviewing each wave with `git diff`; one commit per closed wave is advisable (with the user's permission). Worktrees require a first commit.

## Report format

```
WP-XX: done | partial | blocked
Files: ...
Verification: commands run and a short summary of their output
Not verified: ...
Requests to the orchestrator: contracts, dependencies, decisions
Findings that change the documentation: ...
```
