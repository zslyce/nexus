---
name: nexus-wave
description: Orchestrates a Nexus implementation wave with subagents, verifies it and reviews it.
argument-hint: "[wave number 1-5]"
disable-model-invocation: true
model: haiku
effort: medium
---
Orchestrate Nexus wave $ARGUMENTS. The user authorizes launching the subagents in `.claude/agents/` for it.

Talk to the user in Spanish. Everything written to the repository is in English.

1. Read `docs/status.md`, `docs/07-plan.md` and `docs/08-orchestration.md`. If the previous wave is not closed, say so and stop.
2. Tell the user which packages you will launch, with which subagent and why.
3. Launch at most 3 at a time, respecting the order within the wave. In wave 1, start with WP-01, WP-02 and WP-03.
4. Follow the "Cost policy" in `docs/08-orchestration.md`: do not pass `model` or `effort` when launching subagents beyond what it states.
5. Follow the "Cycle per wave" in `docs/08-orchestration.md`: verify yourself, resolve contract and dependency requests, run `nexus-reviewer` and send the findings back (at most 2 rounds).
6. Update `docs/status.md` and any documentation affected by the findings.
7. Close with: packages finished, verification run, what is not verified and the next step. Do not start the following wave.
