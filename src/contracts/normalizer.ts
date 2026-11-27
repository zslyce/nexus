import type { ErrorInfo, Usage } from "./common.ts";
import type { NexusEventDraft } from "./events.ts";
import type { RawOpenCodeEvent } from "./gateway.ts";
import type { Stage } from "./tasks.ts";

export interface SessionBinding {
  taskId: string;
  sessionId: string;
  agent: string;
}

/** Signals drive the state machine. `events` are for history and display. */
export type TaskSignal =
  | { kind: "execution_started" }
  | { kind: "execution_succeeded" }
  | { kind: "execution_failed"; error: ErrorInfo }
  | { kind: "execution_interrupted"; reason: "user" | "shutdown" | "superseded" | "inactivity" }
  | { kind: "permission_asked"; requestId: string; action: string; resources: string[] }
  | { kind: "form_asked"; formId: string }
  | { kind: "permission_resolved" }
  | { kind: "stage"; stage: Stage }
  | { kind: "activity"; text: string }
  | { kind: "usage"; usage: Usage }
  | { kind: "model_used"; providerID: string; modelID: string }
  | { kind: "file_modified"; path: string };

export interface NormalizedBatch {
  events: NexusEventDraft[];
  signals: TaskSignal[];
}

/** Keeps per-session state (e.g. callID → tool name). No I/O. */
export interface EventNormalizer {
  normalize(raw: RawOpenCodeEvent, binding: SessionBinding): NormalizedBatch;
  forget(sessionId: string): void;
}
