import { createHash } from "node:crypto";

/** Bump when the canonical form changes, so that old keys are not confused with new ones. */
export const IDEMPOTENCY_VERSION = 1;

export interface IdempotencyInput {
  agent: string;
  /** Resolved model string (`provider/model#variant`); `null` or omitted when absent. */
  model?: string | null;
  task: string;
  context?: string | null;
  /** Order and duplicates do not matter. */
  files?: readonly string[];
  /** Task IDs. Batch keys must be resolved to task IDs before calling this. Order and duplicates do not matter. */
  dependsOn?: readonly string[];
}

/**
 * Stable key derived from the request: the same request always gives the same 64-character hex
 * string, in any process and on any platform. Used when the caller does not provide one.
 */
export function deriveIdempotencyKey(input: IdempotencyInput): string {
  const canonical = JSON.stringify({
    v: IDEMPOTENCY_VERSION,
    agent: input.agent,
    model: input.model ?? null,
    task: input.task,
    context: input.context ?? null,
    files: uniqueSorted(input.files),
    dependsOn: uniqueSorted(input.dependsOn),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function uniqueSorted(values: readonly string[] | undefined): string[] {
  return values === undefined ? [] : [...new Set(values)].sort();
}
