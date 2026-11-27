# Nexus

Local bridge between Claude Code (orchestrator) and OpenCode Go (execution): MCP + daemon + dashboard. Documentation in `docs/`; start with `docs/status.md` and `docs/08-orchestration.md`.

## Language
- Everything written in this repository is in **English**: documentation, skills, agent prompts, code, comments, user-facing messages, test names, file names, commit messages and subagent reports.
- **Chat replies to the user are in Spanish.** That is the only place Spanish is used.

## Commands
`npm run typecheck` · `npm test` · `npm run build` · `npm run probe` (read-only OpenCode diagnostics) · `npm run test:integration` (requires `NEXUS_INTEGRATION=1`)

## Code rules
- Node 24, ESM, TypeScript run natively: relative imports with `.ts`, no `enum`, no parameter properties, no TSX.
- Tests with `node:test`. No real waiting in unit tests: inject the clock and test doubles.
- `src/contracts/`, `package.json`, `tsconfig*.json` and `docs/status.md` are modified **only by the orchestrator**. A subagent that needs a change asks for it in its report.
- Each package writes only in the folders listed in `docs/wp/WP-XX.md`.
- Add no dependencies without approval.

## Truthfulness rules
- Do not invent endpoints, events or options: check `docs/04-opencode-api.md`, the OpenAPI file in `tests/fixtures/opencode/` and the installed types. Mark what is unverified.
- Do not claim a test passed if you did not run it.

## Security and cost rules
- Cost first: subagents on haiku with their effort; move up a model only per the "Cost policy" in `docs/08-orchestration.md`.
- `.claude/agents/{explorer,developer,critic}.md` are the reference for the OpenCode agents; do not use them to build Nexus.
- Only `opencode-go/*`, always with an explicit model. Never the `opencode` provider or external APIs.
- Do not touch `~/.config/opencode`, `~/.claude` or credentials. Never print `service.json` or `auth export`.
- Do not stop or restart the user's OpenCode service. Delete only sessions you created, in temporary folders.
- Tests that use inference: only with `NEXUS_INFERENCE=1` and the cheap model named in `docs/07-plan.md`.
