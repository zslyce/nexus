import type { Clock, ErrorInfo, Logger, Usage } from "../contracts/common.ts";
import type { EventType, NexusEventDraft } from "../contracts/events.ts";
import type { RawOpenCodeEvent } from "../contracts/gateway.ts";
import type { EventNormalizer, NormalizedBatch, SessionBinding, TaskSignal } from "../contracts/normalizer.ts";
import type { Stage } from "../contracts/tasks.ts";
import { isTransientStatus } from "../utils/errors.ts";
import { LIMITS, sanitizeCommand, sanitizeText, truncate, workspacePath } from "./sanitize.ts";
import { advanceStage, isValidationCommand } from "./stages.ts";
import { classifyTool } from "./tools.ts";

export interface EventNormalizerOptions {
  /** Absolute workspace path. Payload paths are made relative to it. */
  workspace: string;
  /** `tasks.validationCommandPatterns` from the configuration. */
  validationCommandPatterns: readonly string[];
  logger?: Logger;
  clock?: Clock;
}

type Rec = Record<string, unknown>;
type InterruptReason = Extract<TaskSignal, { kind: "execution_interrupted" }>["reason"];

/** Bounds the per-session maps; an evicted call only loses its label, never a persisted event. */
const MAX_TRACKED_CALLS = 512;

interface CallInfo {
  tool: string;
  /** Workspace-relative path from the input, when the tool has one. */
  path?: string;
  /** Sanitized command, when the tool has one. Never the raw text. */
  command?: string;
}

interface SessionState {
  stage: Stage;
  filesModified: boolean;
  /** callID -> tool name, from `session.tool.input.started`. `session.tool.called` carries no name. */
  names: Map<string, string>;
  /** callID -> what the call touched, from `session.tool.called`. */
  calls: Map<string, CallInfo>;
  /** Workspace-relative paths already reported as FILE_MODIFIED in this attempt. */
  modifiedFiles: Set<string>;
}

/**
 * Builds the drafts for one native event. `event_id` is `<evt_id>:<EVENT_TYPE>[:n]`, where `n` counts
 * repeated types inside the same native event. Ids are unique per event (checked on the fixture), so
 * reprocessing the same event yields the same ids and the store ignores them.
 */
class Collector {
  readonly events: NexusEventDraft[] = [];
  readonly signals: TaskSignal[] = [];
  private readonly counts = new Map<string, number>();
  private readonly base: string | undefined;
  private readonly binding: SessionBinding;
  private readonly timestamp: string;

  constructor(id: unknown, binding: SessionBinding, timestamp: string) {
    this.base = str(id);
    this.binding = binding;
    this.timestamp = timestamp;
  }

  emit(type: EventType, payload: Rec): void {
    // Without a stable native id there is no deterministic key, so nothing is persisted. Signals are still
    // returned for such an event: the task state machine needs them even when the history row is lost.
    if (this.base === undefined) return;
    const count = this.counts.get(type) ?? 0;
    this.counts.set(type, count + 1);
    const suffix = count === 0 ? "" : `:${count}`;
    this.events.push({
      event_id: `${this.base}:${type}${suffix}`,
      task_id: this.binding.taskId,
      session_id: this.binding.sessionId,
      agent: this.binding.agent,
      event_type: type,
      timestamp: this.timestamp,
      payload,
    });
  }

  signal(signal: TaskSignal): void {
    this.signals.push(signal);
  }
}

interface Context {
  collector: Collector;
  state: SessionState;
  data: Rec;
  workspace: string;
  validationPatterns: readonly string[];
}

/**
 * Translates native OpenCode events into Nexus drafts and task signals (docs/03, "Events" and "Stages").
 * Pure apart from its in-memory per-session state; it never throws and never performs I/O.
 */
class Normalizer implements EventNormalizer {
  private readonly sessions = new Map<string, SessionState>();
  private readonly workspace: string;
  private readonly validationPatterns: readonly string[];
  private readonly logger: Logger | undefined;
  private readonly clock: Clock;

  constructor(options: EventNormalizerOptions) {
    this.workspace = options.workspace;
    this.validationPatterns = [...options.validationCommandPatterns];
    this.logger = options.logger;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  normalize(raw: RawOpenCodeEvent, binding: SessionBinding): NormalizedBatch {
    const none: NormalizedBatch = { events: [], signals: [] };
    let type = "unknown";
    try {
      const value: unknown = raw;
      if (!isRecord(value) || typeof value.type !== "string") return none;
      type = value.type;
      // Only the bound session is processed: the global stream carries every session of the user.
      if (sessionIdOf(value) !== binding.sessionId) return none;
      const data = isRecord(value.data) ? value.data : {};
      const collector = new Collector(value.id, binding, isoTimestamp(value.created, this.clock));
      const context: Context = {
        collector,
        state: this.stateFor(binding.sessionId),
        data,
        workspace: this.workspace,
        validationPatterns: this.validationPatterns,
      };
      dispatch(value.type, context);
      return { events: collector.events, signals: collector.signals };
    } catch (error) {
      this.logger?.warn("dropped an OpenCode event that could not be normalized", { type, error });
      return none;
    }
  }

  /**
   * Seeds a session after a restart. The stage and the modified-files flag come from the store, so a task
   * that was `execution` stays there (`advanceStage` never moves it back) and validation is still
   * recognised. Call names and file history are not recoverable and start empty.
   */
  restore(sessionId: string, state: { stage: Stage; filesModified: boolean }): void {
    this.sessions.set(sessionId, {
      stage: state.stage,
      filesModified: state.filesModified,
      names: new Map(),
      calls: new Map(),
      modifiedFiles: new Set(),
    });
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private stateFor(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = {
        stage: "initialization",
        filesModified: false,
        names: new Map(),
        calls: new Map(),
        modifiedFiles: new Set(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }
}

/** Creates the normalizer. One instance serves many sessions; `forget` clears one session's state. */
export function createEventNormalizer(options: EventNormalizerOptions): EventNormalizer {
  return new Normalizer(options);
}

/**
 * Session that a native event belongs to: `data.sessionID`, then `data.form.sessionID`, then the durable
 * aggregate. Returns `undefined` for events without a session (for example `server.connected`).
 */
export function sessionIdOf(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const data = isRecord(raw.data) ? raw.data : undefined;
  const direct = str(data?.sessionID);
  if (direct !== undefined) return direct;
  const form = data !== undefined && isRecord(data.form) ? data.form : undefined;
  const nested = str(form?.sessionID);
  if (nested !== undefined) return nested;
  const durable = isRecord(raw.durable) ? raw.durable : undefined;
  return str(durable?.aggregateID);
}

function dispatch(type: string, ctx: Context): void {
  switch (type) {
    case "session.execution.started":
      return onExecutionStarted(ctx);
    case "session.execution.succeeded":
      return onExecutionSucceeded(ctx);
    case "session.execution.failed":
      return onExecutionFailed(ctx);
    case "session.execution.interrupted":
      return onExecutionInterrupted(ctx);
    case "session.step.started":
      return onStepStarted(ctx);
    case "session.step.ended":
      return onStepEnded(ctx);
    case "session.step.failed":
      return onStepFailed(ctx);
    case "session.reasoning.started":
      return onReasoningStarted(ctx);
    case "session.tool.input.started":
      return onToolInputStarted(ctx);
    case "session.tool.called":
      return onToolCalled(ctx);
    case "session.tool.success":
      return onToolSucceeded(ctx);
    case "session.tool.failed":
      return onToolFailed(ctx);
    case "session.usage.updated":
      return onUsageUpdated(ctx);
    case "session.retry.scheduled":
      return onRetryScheduled(ctx);
    case "permission.asked":
      return onPermissionAsked(ctx);
    case "permission.replied":
      return ctx.collector.signal({ kind: "permission_resolved" });
    case "form.created":
      return onFormCreated(ctx);
    case "form.replied":
    case "form.cancelled":
      // Not in docs/03; a form that is answered or cancelled no longer keeps the task waiting. See the report.
      return ctx.collector.signal({ kind: "permission_resolved" });
    default:
      // Deltas, text, instructions, inbox and any unknown type are not persisted.
      return;
  }
}

function onExecutionStarted(ctx: Context): void {
  ctx.collector.emit("AGENT_STARTED", {});
  ctx.collector.signal({ kind: "execution_started" });
}

function onExecutionSucceeded(ctx: Context): void {
  ctx.collector.emit("AGENT_FINISHED", { outcome: "succeeded" });
  ctx.collector.signal({ kind: "execution_succeeded" });
}

function onExecutionFailed(ctx: Context): void {
  const error = parseError(ctx.data.error, "execution failed");
  ctx.collector.emit("ERROR", { ...error });
  const info: ErrorInfo = {
    code: "EXECUTION_FAILED",
    message: error.message,
    transient: isTransientStatus(error.status),
  };
  if (error.status !== undefined) info.status = error.status;
  ctx.collector.signal({ kind: "execution_failed", error: info });
}

function onExecutionInterrupted(ctx: Context): void {
  const reason = interruptReason(ctx.data.reason);
  const payload: Rec = { outcome: "interrupted" };
  if (reason !== undefined) payload.reason = reason;
  ctx.collector.emit("AGENT_FINISHED", payload);
  // Always signalled, so the task never waits for a finish it will not get. `reason` is simply absent when unknown.
  ctx.collector.signal(reason === undefined ? { kind: "execution_interrupted" } : { kind: "execution_interrupted", reason });
}

function onStepStarted(ctx: Context): void {
  const model = isRecord(ctx.data.model) ? ctx.data.model : undefined;
  const providerID = str(model?.providerID);
  const modelID = str(model?.id);
  if (providerID !== undefined && modelID !== undefined) {
    ctx.collector.signal({ kind: "model_used", providerID, modelID });
  }
  advance(ctx, "analysis");
}

function onStepEnded(ctx: Context): void {
  // `files` is verified in the OpenAPI schema of `session.step.ended`; it is the fallback for file changes.
  for (const file of stringArray(ctx.data.files)) {
    const relative = workspacePath(ctx.workspace, file);
    if (relative !== undefined) recordModified(ctx, relative);
  }
  if (ctx.data.finish === "stop") advance(ctx, "finalization");
}

function onStepFailed(ctx: Context): void {
  const error = isRecord(ctx.data.error) ? ctx.data.error : undefined;
  // An aborted step is a cancellation: `session.execution.interrupted` reports it.
  if (str(error?.type) === "aborted") return;
  ctx.collector.emit("ERROR", { ...parseError(error, "step failed") });
}

function onReasoningStarted(ctx: Context): void {
  ctx.collector.emit("AGENT_THINKING", {});
  ctx.collector.signal({ kind: "activity", text: "thinking" });
}

function onToolInputStarted(ctx: Context): void {
  const callId = str(ctx.data.id);
  const name = toolName(ctx.data.name);
  if (callId !== undefined && name !== undefined) remember(ctx.state.names, callId, name);
}

/** Tool names are echoed into payloads, so they get the same redaction and bound as other text. */
function toolName(value: unknown): string | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const sanitized = sanitizeText(text, LIMITS.identifier);
  return sanitized === "" ? undefined : sanitized;
}

function onToolCalled(ctx: Context): void {
  const callId = str(ctx.data.id);
  const tool = (callId !== undefined ? ctx.state.names.get(callId) : undefined) ?? "unknown";
  if (callId !== undefined) ctx.state.names.delete(callId);

  const input = isRecord(ctx.data.input) ? ctx.data.input : {};
  const info: CallInfo = { tool };
  const relative = workspacePath(ctx.workspace, input.path);
  if (relative !== undefined) info.path = relative;
  // Validation is decided on the raw command (never stored); only the sanitized form is kept.
  const rawCommand = str(input.command);
  if (rawCommand !== undefined) info.command = sanitizeCommand(rawCommand);
  if (callId !== undefined) remember(ctx.state.calls, callId, info);

  const target = info.path ?? info.command;
  const payload: Rec = { tool };
  if (callId !== undefined) payload.callId = truncate(callId, LIMITS.identifier);
  if (target !== undefined) payload.target = target;
  ctx.collector.emit("AGENT_TOOL_STARTED", payload);
  ctx.collector.signal({ kind: "activity", text: truncate(target === undefined ? tool : `${tool} ${target}`, LIMITS.text) });

  switch (classifyTool(tool)) {
    case "write":
      advance(ctx, "execution");
      return;
    case "shell":
      // A non-validation shell command counts as modifying (docs/03). A validation command counts only after edits.
      if (rawCommand === undefined || !isValidationCommand(rawCommand, ctx.validationPatterns)) {
        advance(ctx, "execution");
      } else if (ctx.state.filesModified) {
        advance(ctx, "validation");
      }
      return;
    default:
      return;
  }
}

function onToolSucceeded(ctx: Context): void {
  const callId = str(ctx.data.id);
  const info = takeCall(ctx.state, callId);
  ctx.collector.emit("AGENT_TOOL_COMPLETED", callPayload(info.tool, callId, { ok: true }));
  switch (classifyTool(info.tool)) {
    case "read":
      if (info.path !== undefined) ctx.collector.emit("FILE_READ", { path: info.path });
      return;
    case "write":
      if (info.path !== undefined) recordModified(ctx, info.path);
      return;
    case "shell":
      if (info.command !== undefined) ctx.collector.emit("COMMAND_EXECUTED", { command: info.command });
      return;
    default:
      return;
  }
}

function onToolFailed(ctx: Context): void {
  const callId = str(ctx.data.id);
  const info = takeCall(ctx.state, callId);
  ctx.collector.emit("AGENT_TOOL_COMPLETED", callPayload(info.tool, callId, { ok: false }));
  ctx.collector.emit("WARNING", { message: parseError(ctx.data.error, "tool failed").message, tool: info.tool });
}

function onUsageUpdated(ctx: Context): void {
  const usage = toUsage(ctx.data);
  if (usage !== undefined) ctx.collector.signal({ kind: "usage", usage });
}

function onRetryScheduled(ctx: Context): void {
  const payload: Rec = { message: parseError(ctx.data.error, "retry scheduled").message };
  const attempt = finite(ctx.data.attempt);
  if (attempt !== undefined) payload.attempt = attempt;
  ctx.collector.emit("WARNING", payload);
  ctx.collector.signal({ kind: "activity", text: "retry scheduled" });
}

function onPermissionAsked(ctx: Context): void {
  const requestId = str(ctx.data.id);
  const rawAction = str(ctx.data.action);
  // Incomplete requests cannot be answered, so they are dropped instead of being recorded half-way.
  if (requestId === undefined || rawAction === undefined) return;
  // The request id is opaque and is needed to reply, so it is kept intact. Action and resources are display and
  // policy text: sanitized and bounded in both the stored payload and the signal.
  const action = sanitizeText(rawAction, LIMITS.identifier);
  const resources = stringArray(ctx.data.resources)
    .slice(0, LIMITS.items)
    .map((resource) => sanitizeText(resource, LIMITS.command));
  ctx.collector.emit("AGENT_WAITING", { kind: "permission", requestId, action, resources });
  ctx.collector.signal({ kind: "permission_asked", requestId, action, resources });
}

function onFormCreated(ctx: Context): void {
  const form = isRecord(ctx.data.form) ? ctx.data.form : undefined;
  // Kept intact: the form id is needed to cancel the form.
  const formId = str(form?.id);
  if (formId === undefined) return;
  ctx.collector.emit("AGENT_WAITING", { kind: "form", formId });
  ctx.collector.signal({ kind: "form_asked", formId });
}

/** Moves the stage forward and signals the change. A candidate behind the current stage is ignored. */
function advance(ctx: Context, candidate: Stage): void {
  const next = advanceStage(ctx.state.stage, candidate);
  if (next === ctx.state.stage) return;
  ctx.state.stage = next;
  ctx.collector.signal({ kind: "stage", stage: next });
}

/** Records a file change once per attempt, whether it came from a write tool or from `step.ended.files`. */
function recordModified(ctx: Context, relative: string): void {
  if (ctx.state.modifiedFiles.has(relative)) return;
  ctx.state.modifiedFiles.add(relative);
  ctx.state.filesModified = true;
  ctx.collector.emit("FILE_MODIFIED", { path: relative });
  ctx.collector.signal({ kind: "file_modified", path: relative });
  advance(ctx, "execution");
}

function takeCall(state: SessionState, callId: string | undefined): CallInfo {
  if (callId === undefined) return { tool: "unknown" };
  const info = state.calls.get(callId) ?? { tool: state.names.get(callId) ?? "unknown" };
  state.calls.delete(callId);
  state.names.delete(callId);
  return info;
}

function callPayload(tool: string, callId: string | undefined, extra: Rec): Rec {
  const payload: Rec = { tool, ...extra };
  if (callId !== undefined) payload.callId = truncate(callId, LIMITS.identifier);
  return payload;
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED_CALLS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

interface ParsedError {
  message: string;
  type?: string;
  status?: number;
}

function parseError(value: unknown, fallback: string): ParsedError {
  const record = isRecord(value) ? value : {};
  const message = str(record.message);
  const parsed: ParsedError = { message: message !== undefined ? sanitizeText(message) : fallback };
  const type = str(record.type);
  if (type !== undefined) parsed.type = sanitizeText(type, LIMITS.identifier);
  const status = finite(record.status);
  if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) parsed.status = status;
  return parsed;
}

function toUsage(data: Rec): Usage | undefined {
  const tokens = isRecord(data.tokens) ? data.tokens : undefined;
  const cache = tokens !== undefined && isRecord(tokens.cache) ? tokens.cache : undefined;
  const input = finite(tokens?.input);
  const output = finite(tokens?.output);
  const reasoning = finite(tokens?.reasoning);
  const cacheRead = finite(cache?.read);
  const cacheWrite = finite(cache?.write);
  const reportedCost = finite(data.cost);
  if (
    input === undefined ||
    output === undefined ||
    reasoning === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    reportedCost === undefined
  ) {
    return undefined;
  }
  return { tokens: { input, output, reasoning, cacheRead, cacheWrite }, reportedCost };
}

function interruptReason(value: unknown): InterruptReason | undefined {
  return value === "user" || value === "shutdown" || value === "superseded" || value === "inactivity"
    ? value
    : undefined;
}

function isoTimestamp(created: unknown, clock: Clock): string {
  if (typeof created === "number" && Number.isFinite(created)) {
    const date = new Date(created);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date(clock.now()).toISOString();
}

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
