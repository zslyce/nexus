import { STAGES, type Stage } from "../contracts/tasks.ts";

/** Returns the later of the two stages: a stage never moves back within an attempt. */
export function advanceStage(current: Stage, candidate: Stage): Stage {
  return STAGES.indexOf(candidate) > STAGES.indexOf(current) ? candidate : current;
}

/** Shell metacharacters that chain, background or redirect a command. Such commands are never validation. */
const CHAINING = /[;&|`<>]|\$\(/;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * True when `command` is a configured validation command, alone or with arguments (`npm test -- x`).
 * This classifies stages only; it is not a security control (see R4 in docs/01-assessment.md).
 */
export function isValidationCommand(command: string, patterns: readonly string[]): boolean {
  const normalized = collapse(command);
  if (normalized === "" || CHAINING.test(normalized)) return false;
  return patterns.some((pattern) => {
    const prefix = collapse(pattern);
    return prefix !== "" && (normalized === prefix || normalized.startsWith(`${prefix} `));
  });
}
