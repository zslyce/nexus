/**
 * Translation of `@opencode/client` failures into `NexusError` (see docs/04-opencode-api.md).
 * Only `src/server/**` knows the client's error shapes; the rest of Nexus sees `ErrorInfo` only.
 * Every message is scrubbed of credentials before it leaves this module (it is stored and logged).
 */
import { NexusError, type ErrorCode, type ErrorInfo } from "../contracts/common.ts";
import { redactString } from "../utils/redact.ts";

export { isTransientStatus } from "../utils/errors.ts";

/** `ClientError` from `@opencode/client`. Matched structurally: the class is not exported from the package root. */
interface ClientErrorLike {
  readonly name: "ClientError";
  readonly reason: string;
  readonly cause?: unknown;
}

interface DeclaredMapping {
  readonly code: ErrorCode;
  readonly status: number;
  readonly transient: boolean;
}

/**
 * Errors that OpenCode declares in its OpenAPI document (`_tag` in the body), verified in
 * `tests/fixtures/opencode/openapi-2.4.2.json`. Only these bodies can mean NOT_FOUND.
 */
const DECLARED: Readonly<Record<string, DeclaredMapping>> = {
  UnauthorizedError: { code: "OPENCODE_AUTH", status: 401, transient: false },
  ForbiddenError: { code: "OPENCODE_AUTH", status: 403, transient: false },
  InvalidRequestError: { code: "OPENCODE_API", status: 400, transient: false },
  InvalidCursorError: { code: "OPENCODE_API", status: 400, transient: false },
  ConflictError: { code: "OPENCODE_API", status: 409, transient: false },
  FormAlreadySettledError: { code: "OPENCODE_API", status: 409, transient: false },
  SessionBusyError: { code: "OPENCODE_API", status: 409, transient: true },
  ServiceUnavailableError: { code: "OPENCODE_UNAVAILABLE", status: 503, transient: true },
  UnknownError: { code: "OPENCODE_API", status: 500, transient: true },
};

/** Builds a NexusError whose message is redacted. Every error in this module goes through here. */
export function failure(info: ErrorInfo, cause?: unknown): NexusError {
  const safe: ErrorInfo = { ...info, message: redactString(info.message) };
  return cause === undefined ? new NexusError(safe) : new NexusError(safe, { cause });
}

/** A transport-level failure (no HTTP response): the endpoint may have changed. */
export function isTransportError(error: unknown): boolean {
  return isClientError(error) && error.reason === "Transport";
}

/** A transient `OPENCODE_UNAVAILABLE` error built by Nexus itself (no service registered, stream lost, deadline). */
export function unavailable(message: string, cause?: unknown): NexusError {
  return failure({ code: "OPENCODE_UNAVAILABLE", message, transient: true }, cause);
}

/** Whether the error comes from OpenCode (a client failure or a declared error body), as opposed to Nexus or a bug. */
export function isOpenCodeError(error: unknown): boolean {
  return isClientError(error) || declaredTag(error) !== undefined;
}

/** Whether the error is a `NOT_FOUND` from OpenCode's own declared not-found body (used for idempotent cleanup). */
export function isNotFound(error: unknown): boolean {
  return error instanceof NexusError && error.info.code === "NOT_FOUND";
}

/** Translates any failure from the client into a `NexusError`, prefixing the message with the operation. */
export function translateError(error: unknown, operation: string): NexusError {
  if (error instanceof NexusError) return error;
  if (isClientError(error)) return fromClientError(error, operation);
  const tag = declaredTag(error);
  if (tag !== undefined) return fromDeclared(tag, error, operation);
  if (error instanceof Error && error.name === "AbortError") {
    return failure({ code: "INTERNAL", message: `${operation} was aborted`, transient: false }, error);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return failure({ code: "OPENCODE_API", message: `${operation}: ${detail}`, transient: false }, error);
}

function isClientError(error: unknown): error is ClientErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ClientError" &&
    "reason" in error &&
    typeof error.reason === "string"
  );
}

/** The `_tag` of a declared OpenCode error body, or `undefined`. */
export function declaredTag(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("_tag" in error && typeof error._tag === "string") return error._tag;
  return undefined;
}

function fromDeclared(tag: string, error: unknown, operation: string): NexusError {
  const message = `${operation}: ${errorMessage(error) ?? tag}`;
  if (tag.endsWith("NotFoundError")) {
    return failure({ code: "NOT_FOUND", message, transient: false, status: 404 }, error);
  }
  const mapping = DECLARED[tag];
  if (mapping === undefined) {
    return failure({ code: "OPENCODE_API", message, transient: false }, error);
  }
  return failure({ code: mapping.code, message, transient: mapping.transient, status: mapping.status }, error);
}

function fromClientError(error: ClientErrorLike, operation: string): NexusError {
  if (error.reason === "Transport") {
    return unavailable(`${operation}: OpenCode service is unreachable`, error);
  }
  if (error.reason === "UnexpectedStatus") {
    return fromStatus(statusOf(error), operation, error);
  }
  return failure(
    { code: "OPENCODE_API", message: `${operation}: unexpected OpenCode response (${error.reason})`, transient: false },
    error,
  );
}

function fromStatus(status: number | undefined, operation: string, cause: unknown): NexusError {
  return failure(classifyStatus(status, `${operation}: OpenCode answered HTTP ${status ?? "unknown"}`), cause);
}

/**
 * A status without a declared body is not evidence of "not found": a 404 from a stale or foreign endpoint
 * must not read as a missing session. Only declared not-found bodies map to NOT_FOUND (see `fromDeclared`).
 */
function classifyStatus(status: number | undefined, message: string): ErrorInfo {
  if (status === 401 || status === 403) return { code: "OPENCODE_AUTH", message, transient: false, status };
  if (status === 503) return { code: "OPENCODE_UNAVAILABLE", message, transient: true, status };
  const transient = status === 429 || (status !== undefined && status >= 500);
  return { code: "OPENCODE_API", message, transient, ...(status === undefined ? {} : { status }) };
}

function statusOf(error: ClientErrorLike): number | undefined {
  const cause = error.cause;
  if (typeof cause === "object" && cause !== null && "status" in cause && typeof cause.status === "number") {
    return cause.status;
  }
  return undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return undefined;
}
