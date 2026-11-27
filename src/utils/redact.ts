import { NexusError } from "../contracts/index.ts";

export const REDACTED = "[REDACTED]";

/**
 * A key is sensitive when one of its words (split on camelCase and on `_`, `-`, `.`) is a sensitive
 * word, for example `token`, `tokenValue`, `apiKeyId` or `token_value`. A single-word key may also
 * end with a sensitive word (`accesstoken`). Plural counters such as `tokens`, `maxTokens` or
 * `totalTokens` are not sensitive. `idempotencyKey` is exempt: it is a hash, not a credential.
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  "authorization",
  "password",
  "passwd",
  "secret",
  "token",
  "key",
  "apikey",
]);
const SENSITIVE_SUFFIXES = ["authorization", "password", "passwd", "secret", "token", "apikey"] as const;
const EXEMPT_KEYS: ReadonlySet<string> = new Set(["idempotencykey"]);

const MAX_DEPTH = 8;

/**
 * Optional escaping around a quote, so that JSON embedded in a string (`{\"token\":\"abc\"}`) is
 * matched like plain JSON. The value class excludes backslashes and closing brackets for the same reason.
 */
const ESCAPED_QUOTE = String.raw`(?:\\*["'])?`;
const VALUE = String.raw`[^\s"',;&\\}\]]+`;

/**
 * Order matters. The `Authorization` rule runs first so that its scheme (`Bearer`, `Basic`, ...) is
 * consumed together with the credential. A bare `Basic` word is not matched: it is common in prose.
 */
const STRING_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [
    new RegExp(String.raw`(authorization${ESCAPED_QUOTE}\s*[:=]\s*${ESCAPED_QUOTE})(?:(?:bearer|basic|digest|token)\s+)?${VALUE}`, "gi"),
    `$1${REDACTED}`,
  ],
  [/\b(Bearer)\s+\S+/gi, `$1 ${REDACTED}`],
  [
    new RegExp(
      String.raw`((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)${ESCAPED_QUOTE}\s*[:=]\s*${ESCAPED_QUOTE})${VALUE}`,
      "gi",
    ),
    `$1${REDACTED}`,
  ],
];

export function isSensitiveKey(key: string): boolean {
  const words = wordsOf(key);
  if (EXEMPT_KEYS.has(words.join(""))) return false;
  if (words.some((word) => SENSITIVE_WORDS.has(word))) return true;
  return words.length === 1 && SENSITIVE_SUFFIXES.some((suffix) => words[0]?.endsWith(suffix) === true && words[0] !== suffix);
}

function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** Removes `Authorization` header credentials, bare `Bearer` tokens and `key=value` secrets from free text. */
export function redactString(text: string): string {
  let result = text;
  for (const [pattern, replacement] of STRING_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Returns a copy of `value` safe to serialize: sensitive keys are replaced at any depth, strings are
 * scrubbed, errors keep only name and message (plus the NexusError info). Circular references and
 * excessive depth are cut instead of throwing.
 */
export function redactValue(value: unknown): unknown {
  return walk(value, 0, new Set<object>());
}

function walk(value: unknown, depth: number, ancestors: Set<object>): unknown {
  switch (typeof value) {
    case "string":
      return redactString(value);
    case "bigint":
      return value.toString();
    case "symbol":
      return value.toString();
    case "function":
      return "[Function]";
    case "object":
      break;
    default:
      return value;
  }
  if (value === null) return null;
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (ancestors.has(value)) return "[Circular]";

  ancestors.add(value);
  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    }
    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        name: value.name,
        message: redactString(value.message),
      };
      if (value instanceof NexusError) {
        out.info = walk(value.info, depth + 1, ancestors);
      }
      return out;
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1, ancestors));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : walk(item, depth + 1, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}
