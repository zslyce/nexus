import { readFileSync } from "node:fs";
import type { Clock, Logger } from "../../src/contracts/common.ts";
import type { NexusEventDraft } from "../../src/contracts/events.ts";
import type { RawOpenCodeEvent } from "../../src/contracts/gateway.ts";
import type { SessionBinding } from "../../src/contracts/normalizer.ts";
import type { Task } from "../../src/contracts/tasks.ts";

/** Workspace the fixture ran in (`location.directory` of its events). */
export const WORKSPACE = "C:\\workspace";

/** Defaults of `tasks.validationCommandPatterns` in `nexus.config.json`. */
export const VALIDATION_PATTERNS: readonly string[] = [
  "npm test",
  "npm run typecheck",
  "npm run build",
  "node --test",
  "tsc",
  "pytest",
  "go test",
  "cargo test",
];

/** The fixture holds two sessions: one completed run (and a second run), and one cancelled run. */
export const SESSION_COMPLETED = "ses_de51dae21ffel5eValadWTpxGX";
export const SESSION_CANCELLED = "ses_de51d8bbeffeQTw5igcc64MpDQ";

export const FIXED_CLOCK: Clock = { now: () => 1_795_747_369_000 };

export function loadFixture(): RawOpenCodeEvent[] {
  const url = new URL("../fixtures/opencode/events.two-sessions.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as RawOpenCodeEvent[];
}

export function binding(taskId: string, sessionId: string, agent = "nexus-probe"): SessionBinding {
  return { taskId, sessionId, agent };
}

let counter = 0;

/** Builds a native event with a unique id unless one is given. */
export function rawEvent(
  type: string,
  data: Record<string, unknown>,
  options: { id?: string; created?: number } = {},
): RawOpenCodeEvent {
  counter += 1;
  return {
    id: options.id ?? `evt_test${String(counter).padStart(8, "0")}`,
    type,
    created: options.created ?? 1_795_747_369_000 + counter,
    data,
  };
}

export function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => {
      warnings.push(message);
    },
    error: () => undefined,
  };
}

export function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `title ${id}`,
    prompt: "prompt",
    files: [],
    agent: "nexus-probe",
    model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    status: "pending",
    stage: "initialization",
    dependsOn: [],
    attempt: 1,
    maxAttempts: 2,
    timeoutMs: 60_000,
    sessionId: `ses_nexus_${id.slice(-16).padEnd(16, "0")}`,
    promptMessageId: `msg_nexus_${id.slice(-16).padEnd(16, "0")}`,
    idempotencyKey: `key-${id}`,
    createdAt: 1,
    ...overrides,
  };
}

/** A draft for store-level tests; `event_id` is chosen by the caller. */
export function draft(
  taskId: string,
  sessionId: string,
  eventId: string,
  eventType: NexusEventDraft["event_type"] = "AGENT_STARTED",
  payload: Record<string, unknown> = {},
): NexusEventDraft {
  return {
    event_id: eventId,
    task_id: taskId,
    session_id: sessionId,
    agent: "nexus-probe",
    event_type: eventType,
    timestamp: "2026-11-26T00:00:00.000Z",
    payload,
  };
}
