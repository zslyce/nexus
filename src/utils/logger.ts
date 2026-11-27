import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock, Logger } from "../contracts/index.ts";
import { nexusError } from "./errors.ts";
import { redactString, redactValue } from "./redact.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Receives one JSON line without a trailing newline. Sinks must not write to stdout (MCP protocol). */
export type LogSink = (line: string) => void;

export interface LoggerOptions {
  /** Minimum level emitted. Default `info`. */
  level?: LogLevel;
  /** Default: stderr. */
  sinks?: readonly LogSink[];
  /** Default: system clock. */
  clock?: Clock;
}

/**
 * Structured logger. Each line is `{"time","level","message","data"}`. Everything passes through the
 * redaction in `redact.ts` before reaching a sink. A failing sink never breaks the caller.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const minRank = RANK[options.level ?? "info"];
  const sinks = options.sinks ?? [createStderrSink()];
  const clock: Clock = options.clock ?? { now: () => Date.now() };

  const emit = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    if (RANK[level] < minRank) return;
    const line = formatLine(level, message, data, clock.now());
    for (const sink of sinks) {
      try {
        sink(line);
      } catch {
        // Logging must never make the daemon or the MCP server fail.
      }
    }
  };

  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
  };
}

export function parseLogLevel(value: string): LogLevel {
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw nexusError("VALIDATION", `log level must be one of ${LOG_LEVELS.join(", ")}`);
}

export function createStderrSink(stream: { write(chunk: string): unknown } = process.stderr): LogSink {
  return (line) => {
    stream.write(`${line}\n`);
  };
}

/** Appends each line synchronously, so nothing is lost if the process exits right after logging. */
export function createFileSink(filePath: string): LogSink {
  mkdirSync(dirname(filePath), { recursive: true });
  return (line) => {
    appendFileSync(filePath, `${line}\n`, "utf8");
  };
}

function formatLine(level: LogLevel, message: string, data: Record<string, unknown> | undefined, timestamp: number): string {
  const time = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  try {
    const entry: Record<string, unknown> = { time, level, message: redactString(String(message)) };
    if (data !== undefined) entry.data = redactValue(data);
    return JSON.stringify(entry);
  } catch {
    return JSON.stringify({ time, level, message: "log entry could not be serialized" });
  }
}
