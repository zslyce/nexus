/**
 * `OpenCodeGateway` over `@opencode/client` 2.4.2 (docs/04-opencode-api.md). The only Nexus code that
 * talks to OpenCode: the rest of the system sees the port in `src/contracts/gateway.ts`.
 */
import type { OpenCodeClient, SessionCreateInput, SessionInfo, ModelInfo as OpenCodeModel } from "@opencode/client";
import type { Endpoint, EnsureOptions } from "@opencode/client/service";
import { NexusError, type ErrorInfo, type Logger } from "../contracts/common.ts";
import type {
  CreateSessionInput,
  ModelInfo,
  OpenCodeGateway,
  RawOpenCodeEvent,
  ServerStatus,
  SessionOutput,
  SessionSnapshot,
} from "../contracts/gateway.ts";
import type { FileChange } from "../contracts/tasks.ts";
import { redactString } from "../utils/redact.ts";
import { Connection, type Discover } from "./connection.ts";
import {
  declaredTag,
  isNotFound,
  isOpenCodeError,
  isTransientStatus,
  isTransportError,
  translateError,
  unavailable,
} from "./errors.ts";
import { ServerManager, defaultServiceCommand } from "./server-manager.ts";

/** Timers used by the silence watchdog and the call deadline. Injected so that tests never wait for real time. */
export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Replaceable parts, used by the unit tests. Defaults are the real implementations. */
export interface GatewaySeams {
  readonly discover: Discover;
  readonly ensure: (options: EnsureOptions) => Promise<Endpoint>;
  readonly readRegisteredPid: (file: string) => Promise<number | undefined>;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly scheduler: Scheduler;
  readonly sleep: (ms: number) => Promise<void>;
  readonly platform: NodeJS.Platform;
  readonly comspec: string | undefined;
}

export interface OpenCodeGatewayOptions {
  readonly logger: Logger;
  /** `connect()` starts a service only when none is registered. */
  readonly autoStart: boolean;
  /** Registration file. Default: OpenCode's own (XDG state directory). Tests use an isolated file. */
  readonly registrationFile?: string;
  /** Command that starts a service. Default: `defaultServiceCommand` for the platform. */
  readonly command?: readonly string[];
  /** Extra environment for a started service (used to isolate it in tests). */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Maximum silence on the event stream, keepalive frames included. OpenCode sends keepalives about every
   * 15 s (observed); the default allows three missed ones.
   */
  readonly silenceTimeoutMs?: number;
  /** Deadline for one request. When it passes, the request is aborted and the call fails transiently. */
  readonly callTimeoutMs?: number;
  /**
   * `listModels` retries while the catalog is empty or has no model of one of these providers. OpenCode warms
   * its catalog up after the service starts: observed, the first queries returned 0 models, then a partial list
   * without `opencode-go`, then the full list (about 2 s). The daemon passes `opencode.allowedProviders`.
   */
  readonly requiredProviders?: readonly string[];
  readonly modelListAttempts?: number;
  readonly modelListRetryDelayMs?: number;
  readonly seams?: Partial<GatewaySeams>;
}

const DEFAULT_SILENCE_TIMEOUT_MS = 45_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL_LIST_ATTEMPTS = 6;
const DEFAULT_MODEL_LIST_RETRY_DELAY_MS = 500;
/** Upper bound for pagination, so that a misbehaving server cannot loop forever. */
const MAX_PAGES = 100;

/** Second argument of every client call: the signal that the deadline uses to abort the request. */
interface CallOptions {
  readonly signal: AbortSignal;
}

const systemScheduler: Scheduler = {
  setTimeout(callback, ms) {
    const handle = globalThis.setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as NodeJS.Timeout);
  },
};

const systemSleep = (ms: number): Promise<void> => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

/** Mandatory session rules come from the caller (`CreateSessionInput.permissions`); the gateway adds none. */
export function createOpenCodeGateway(options: OpenCodeGatewayOptions): OpenCodeGateway {
  return new OpenCodeHttpGateway(options);
}

class OpenCodeHttpGateway implements OpenCodeGateway {
  readonly #logger: Logger;
  readonly #autoStart: boolean;
  readonly #connection: Connection;
  readonly #manager: ServerManager;
  readonly #scheduler: Scheduler;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #silenceTimeoutMs: number;
  readonly #callTimeoutMs: number;
  readonly #requiredProviders: readonly string[];
  readonly #modelListAttempts: number;
  readonly #modelListRetryDelayMs: number;
  #connecting: Promise<ServerStatus> | undefined;

  constructor(options: OpenCodeGatewayOptions) {
    const seams = options.seams ?? {};
    const platform = seams.platform ?? process.platform;
    this.#logger = options.logger;
    this.#autoStart = options.autoStart;
    this.#connection = new Connection({
      registrationFile: options.registrationFile,
      logger: options.logger,
      ...(seams.discover === undefined ? {} : { discover: seams.discover }),
    });
    this.#manager = new ServerManager({
      registrationFile: options.registrationFile,
      command: options.command ?? defaultServiceCommand(platform, seams.comspec ?? process.env["ComSpec"]),
      env: options.env,
      logger: options.logger,
      ...(seams.ensure === undefined ? {} : { ensure: seams.ensure }),
      ...(seams.readRegisteredPid === undefined ? {} : { readRegisteredPid: seams.readRegisteredPid }),
      ...(seams.isProcessAlive === undefined ? {} : { isProcessAlive: seams.isProcessAlive }),
    });
    this.#scheduler = seams.scheduler ?? systemScheduler;
    this.#sleep = seams.sleep ?? systemSleep;
    this.#silenceTimeoutMs = options.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
    this.#callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.#requiredProviders = options.requiredProviders ?? [];
    this.#modelListAttempts = options.modelListAttempts ?? DEFAULT_MODEL_LIST_ATTEMPTS;
    this.#modelListRetryDelayMs = options.modelListRetryDelayMs ?? DEFAULT_MODEL_LIST_RETRY_DELAY_MS;
  }

  /** Concurrent calls share one connect: a second caller must not start a second service. */
  connect(): Promise<ServerStatus> {
    this.#connecting ??= this.#connectOnce().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connectOnce(): Promise<ServerStatus> {
    const found = await this.#connection.find();
    if (found !== undefined) {
      this.#connection.adopt(found);
      return this.status();
    }
    if (!this.#autoStart) {
      return { connected: false, error: unavailable("No OpenCode service is registered and autoStart is off").info };
    }
    try {
      this.#connection.adopt(await this.#manager.start());
    } catch (error) {
      return { connected: false, error: translateError(error, "connect").info };
    }
    return this.status();
  }

  async status(): Promise<ServerStatus> {
    try {
      const info = await this.#call("server.info", (client, options) => client.server.info(options));
      this.#logger.debug("OpenCode service is reachable", { version: info.version });
      return { connected: true, url: this.#connection.url, version: info.version };
    } catch (error) {
      return { connected: false, url: this.#connection.url, error: translateError(error, "status").info };
    }
  }

  async listModels(directory: string): Promise<ModelInfo[]> {
    for (let attempt = 1; ; attempt++) {
      const response = await this.#call("model.list", (client, options) =>
        client.model.list({ location: { directory } }, options),
      );
      const missing = this.#requiredProviders.filter(
        (providerID) => !response.data.some((model) => model.providerID === providerID),
      );
      if ((response.data.length > 0 && missing.length === 0) || attempt >= this.#modelListAttempts) {
        return response.data.map(toModelInfo);
      }
      this.#logger.warn("OpenCode model catalog is incomplete; retrying", { attempt, models: response.data.length, missing });
      await this.#sleep(this.#modelListRetryDelayMs * attempt);
    }
  }

  async listAgentIds(directory: string): Promise<string[]> {
    const response = await this.#call("agent.list", (client, options) =>
      client.agent.list({ location: { directory } }, options),
    );
    return response.data.map((agent) => agent.id);
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    // Repeating the same `id` returns the original session and ignores these fields (docs/04, pitfall 4).
    const model = input.model.variant === undefined
      ? { id: input.model.id, providerID: input.model.providerID }
      : { id: input.model.id, providerID: input.model.providerID, variant: input.model.variant };
    await this.#call("session.create", (client, options) =>
      client.session.create(
        {
          id: input.id,
          title: input.title,
          agent: input.agent,
          model,
          location: { directory: input.directory },
          metadata: input.metadata as NonNullable<SessionCreateInput["metadata"]>,
          permissions: input.permissions,
        },
        options,
      ),
    );
  }

  async prompt(input: { sessionId: string; messageId: string; text: string }): Promise<void> {
    await this.#call("session.prompt", (client, options) =>
      client.session.prompt({ sessionID: input.sessionId, id: input.messageId, text: input.text }, options),
    );
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const response = await this.#call("session.interrupt", (client, options) =>
      client.session.interrupt({ sessionID: sessionId }, options),
    );
    return response.interrupted;
  }

  async getSession(sessionId: string): Promise<SessionSnapshot | null> {
    try {
      return await this.#call("session.get", async (client, options) => {
        const session = await client.session.get({ sessionID: sessionId }, options);
        const active = await client.session.active(options);
        return toSnapshot(session, Object.hasOwn(active, sessionId));
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listSessions(directory: string): Promise<SessionSnapshot[]> {
    return this.#call("session.list", async (client, options) => {
      const active = await client.session.active(options);
      const sessions: SessionInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await client.session.list({ directory, cursor }, options);
        sessions.push(...response.data);
        cursor = response.cursor.next ?? undefined;
        if (cursor === undefined) break;
      }
      return sessions.map((session) => toSnapshot(session, Object.hasOwn(active, session.id)));
    });
  }

  /**
   * Last assistant text after the prompt. Walks the messages newest first and stops at the prompt, so it
   * reads only what came after it. `promptDelivered` is false while the message is still queued in the inbox.
   */
  async getOutput(sessionId: string, promptMessageId: string): Promise<SessionOutput> {
    return this.#call("session.message.list", async (client, options) => {
      let found = false;
      let newest: MessageLike | undefined;
      let lastAssistant: MessageLike | undefined;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES && !found; page++) {
        const response = await client.message.list(
          { sessionID: sessionId, order: cursor === undefined ? "desc" : undefined, cursor },
          options,
        );
        for (const message of response.data) {
          if (message.id === promptMessageId) {
            found = true;
            break;
          }
          newest ??= message;
          lastAssistant ??= message.type === "assistant" ? message : undefined;
        }
        cursor = response.cursor.next ?? undefined;
        if (cursor === undefined) break;
      }
      if (!found) return { text: "", promptDelivered: false };
      const text = (lastAssistant?.content ?? [])
        .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
        .join("");
      const error = newest?.type === "idle" ? outputError(newest) : undefined;
      return error === undefined ? { text, promptDelivered: true } : { text, promptDelivered: true, error };
    });
  }

  async getDiff(sessionId: string): Promise<FileChange[]> {
    const diffs = await this.#call("session.diff", (client, options) =>
      client.session.diff({ sessionID: sessionId }, options),
    );
    return diffs.map((diff) => ({
      path: diff.file,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
    }));
  }

  /** Idempotent: a session that is already gone counts as removed. */
  async removeSession(sessionId: string): Promise<void> {
    try {
      await this.#call("session.remove", (client, options) => client.session.remove({ sessionID: sessionId }, options));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    decision: "once" | "reject",
    message?: string,
  ): Promise<void> {
    await this.#call("permission.reply", (client, options) =>
      client.permission.reply({ sessionID: sessionId, requestID: requestId, decision, message }, options),
    );
  }

  /** Idempotent: a form that is gone or already settled counts as cancelled. */
  async cancelForm(sessionId: string, formId: string): Promise<void> {
    try {
      await this.#call("session.form.cancel", (client, options) =>
        client.session.form.cancel({ sessionID: sessionId, formID: formId }, options),
      );
    } catch (error) {
      // Only the declared "already settled" body counts as done: SessionBusyError is also a 409 and is not.
      const settled = error instanceof NexusError && declaredTag(error.cause) === "FormAlreadySettledError";
      if (!isNotFound(error) && !settled) throw error;
    }
  }

  /**
   * Global stream. Closing `signal`, or calling `return()`, ends the iteration and closes the socket.
   * Throws a transient `OPENCODE_UNAVAILABLE` when the connection drops, goes silent or ends by itself.
   */
  async *subscribe(signal: AbortSignal): AsyncGenerator<RawOpenCodeEvent> {
    if (signal.aborted) return;
    const client = await this.#connection.client();
    // Discovery is awaited: an abort during it must not leave a listener on a signal that already fired.
    if (signal.aborted) return;
    const stream = new AbortController();
    const stopStream = (): void => stream.abort();
    signal.addEventListener("abort", stopStream, { once: true });

    let silent = false;
    let finished = false;
    let watchdog: unknown;
    const arm = (): void => {
      if (finished) return; // no late activity may leave a timer behind
      if (watchdog !== undefined) this.#scheduler.clearTimeout(watchdog);
      watchdog = this.#scheduler.setTimeout(() => {
        silent = true;
        stream.abort();
      }, this.#silenceTimeoutMs);
    };

    arm();
    const iterator = client.event.subscribe({ signal: stream.signal, onActivity: arm })[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        arm();
        // The client yields its own event union; the contract type is the same data, widened.
        yield next.value as RawOpenCodeEvent;
      }
    } catch (error) {
      if (signal.aborted) return;
      throw this.#streamError(error, silent ? this.#silenceTimeoutMs : undefined);
    } finally {
      finished = true;
      if (watchdog !== undefined) this.#scheduler.clearTimeout(watchdog);
      signal.removeEventListener("abort", stopStream);
      stream.abort();
    }
    if (signal.aborted) return;
    throw this.#streamError(undefined, silent ? this.#silenceTimeoutMs : undefined);
  }

  /**
   * Runs one request against the current endpoint. A deadline (injected scheduler) aborts the request and
   * fails the call transiently. The endpoint is dropped after a timeout, a transport failure or an auth error.
   */
  async #call<T>(operation: string, run: (client: OpenCodeClient, options: CallOptions) => Promise<T>): Promise<T> {
    const client = await this.#connection.client();
    const controller = new AbortController();
    let timer: unknown;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = this.#scheduler.setTimeout(() => {
        controller.abort();
        this.#connection.invalidate();
        reject(unavailable(`${operation}: OpenCode did not answer within ${this.#callTimeoutMs} ms`));
      }, this.#callTimeoutMs);
    });
    try {
      return await Promise.race([run(client, { signal: controller.signal }), deadline]);
    } catch (error) {
      if (error instanceof NexusError) throw error;
      throw this.#failure(operation, error);
    } finally {
      this.#scheduler.clearTimeout(timer);
    }
  }

  #failure(operation: string, error: unknown): NexusError {
    const translated = translateError(error, operation);
    // Rediscover on the next call: the service may have restarted on another port, or the credentials
    // may have changed. A bare 404 is deliberately not a reason: it does not prove the endpoint is gone.
    if (isTransportError(error) || translated.info.code === "OPENCODE_AUTH") this.#connection.invalidate();
    return translated;
  }

  /**
   * Any end of the stream that the caller did not ask for. The endpoint is dropped, so the caller's
   * reconnection rediscovers it. OpenCode errors keep their classification (a 401 is not transient);
   * anything else is a transient loss.
   */
  #streamError(error: unknown, silenceMs: number | undefined): NexusError {
    this.#connection.invalidate();
    if (silenceMs !== undefined) return unavailable(`OpenCode event stream was silent for ${silenceMs} ms`);
    if (error === undefined) return unavailable("OpenCode closed the event stream");
    if (isOpenCodeError(error)) return translateError(error, "event stream");
    return unavailable("OpenCode event stream failed", error);
  }
}

type MessageLike = {
  readonly id: string;
  readonly type: string;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly outcome?: "succeeded" | "failed" | "interrupted";
  readonly error?: { readonly type: string; readonly message: string; readonly status?: number };
};

function toModelInfo(model: OpenCodeModel): ModelInfo {
  return {
    providerID: model.providerID,
    id: model.id,
    name: model.name,
    enabled: model.enabled,
    variants: model.variants.map((variant) => variant.id),
    supportsTools: model.capabilities.tools,
  };
}

function toSnapshot(session: SessionInfo, active: boolean): SessionSnapshot {
  return {
    id: session.id,
    directory: session.location.directory,
    ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
    active,
    metadata: session.metadata as Record<string, unknown>,
    usage: {
      tokens: {
        input: session.tokens.input,
        output: session.tokens.output,
        reasoning: session.tokens.reasoning,
        cacheRead: session.tokens.cache.read,
        cacheWrite: session.tokens.cache.write,
      },
      reportedCost: session.cost,
    },
  };
}

/** Error of the run that ended after the prompt, if it did not succeed. Messages are scrubbed. */
function outputError(idle: MessageLike): ErrorInfo | undefined {
  if (idle.outcome === "interrupted") {
    return { code: "INTERRUPTED", message: "The run was interrupted", transient: false };
  }
  if (idle.outcome !== "failed") return undefined;
  const status = idle.error?.status;
  const message = redactString(
    idle.error === undefined ? "The run failed" : `${idle.error.type}: ${idle.error.message}`,
  );
  return {
    code: "EXECUTION_FAILED",
    message,
    transient: isTransientStatus(status),
    ...(status === undefined ? {} : { status }),
  };
}
