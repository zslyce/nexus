import { NexusError, type ErrorCode, type ErrorInfo } from "../contracts/index.ts";
import { redactString } from "./redact.ts";

/** Node and undici error codes that mean the connection failed or timed out at the transport level. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const MAX_CAUSE_DEPTH = 5;

/** HTTP statuses that are worth retrying: 429 and 5xx. */
export function isTransientStatus(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

export interface NexusErrorOptions {
  /** Overrides the default: transient for `OPENCODE_UNAVAILABLE` and for 429/5xx statuses. */
  transient?: boolean;
  status?: number;
  cause?: unknown;
}

export function nexusError(code: ErrorCode, message: string, options: NexusErrorOptions = {}): NexusError {
  const transient = options.transient ?? (code === "OPENCODE_UNAVAILABLE" || isTransientStatus(options.status));
  const info: ErrorInfo = { code, message, transient };
  if (options.status !== undefined) info.status = options.status;
  return options.cause === undefined
    ? new NexusError(info)
    : new NexusError(info, { cause: options.cause });
}

/**
 * Maps any thrown value to an `ErrorInfo`. Only transient errors are retried: transport failures and
 * HTTP 429/5xx. Timeouts, cancellations, authentication failures and other 4xx are not transient.
 * The message is scrubbed of credentials before it is stored or logged.
 */
export function classifyError(error: unknown): ErrorInfo {
  if (error instanceof NexusError) return { ...error.info };

  const message = redactString(messageOf(error));
  const status = statusOf(error);
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return { code: "OPENCODE_AUTH", message, transient: false, status };
    }
    return { code: "OPENCODE_API", message, transient: isTransientStatus(status), status };
  }
  if (hasNetworkCode(error)) {
    return { code: "OPENCODE_UNAVAILABLE", message, transient: true };
  }
  const name = nameOf(error);
  if (name === "AbortError") return { code: "INTERRUPTED", message, transient: false };
  if (name === "TimeoutError") return { code: "TIMEOUT", message, transient: false };
  return { code: "INTERNAL", message, transient: false };
}

export function isTransientError(error: unknown): boolean {
  return classifyError(error).transient;
}

function messageOf(error: unknown): string {
  let raw: string;
  if (error instanceof Error) {
    raw = error.message;
  } else if (typeof error === "string") {
    raw = error;
  } else if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    raw = (error as { message: string }).message;
  } else {
    raw = String(error);
  }
  return raw.length > 0 ? raw : "Unknown error";
}

function nameOf(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidates: unknown[] = [
    (error as { status?: unknown }).status,
    (error as { statusCode?: unknown }).statusCode,
    (error as { response?: { status?: unknown } }).response?.status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) {
      return candidate;
    }
  }
  return undefined;
}

function hasNetworkCode(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
