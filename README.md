# Nexus — Claude Code ↔ OpenCode Go bridge

**Status: base modules ready (wave 1); the bridge does not run yet.** See [docs/status.md](docs/status.md).

## Requirements
Node ≥ 24, OpenCode 2.4.2 signed in to OpenCode Go, Claude Code 2.1.331 or later.

## Check the environment

```powershell
npm install
npm run typecheck
npm test
npm run probe
```

## Continue the implementation

Open a Claude Code session in this folder and run `/nexus-wave 2`.

## Documentation

| Document | Contents |
|---|---|
| [01 Assessment](docs/01-assessment.md) | Environment, mismatches, risks |
| [02 Decisions](docs/02-decisions.md) | ADRs |
| [03 Architecture](docs/03-architecture.md) | Modules, states, events, recovery |
| [04 OpenCode API](docs/04-opencode-api.md) | Verified reference and pitfalls |
| [05 Interfaces](docs/05-interfaces.md) | MCP, IPC, CLI, dashboard, plugin |
| [06 Security](docs/06-security.md) | Controls and limits |
| [07 Plan](docs/07-plan.md) | Waves, tests, acceptance |
| [08 Orchestration](docs/08-orchestration.md) | Working with subagents |
