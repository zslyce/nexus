import { parse } from "yaml";
import { nexusError } from "../utils/index.ts";

const FENCE = "---";

export interface SplitMarkdown {
  /** False when the text does not start with a frontmatter block: the whole text is the body. */
  readonly hasFrontmatter: boolean;
  readonly frontmatter: string;
  readonly body: string;
}

/** Removes a UTF-8 byte order mark and converts CRLF and CR line endings to LF. */
export function normalizeText(raw: string): string {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutBom.replace(/\r\n?/g, "\n");
}

/** Separates the leading `---` block from the rest of the file. Throws `VALIDATION` if the block is not closed. */
export function splitFrontmatter(raw: string): SplitMarkdown {
  const text = normalizeText(raw);
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== FENCE) {
    return { hasFrontmatter: false, frontmatter: "", body: text };
  }
  const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === FENCE);
  if (close === -1) {
    throw nexusError("VALIDATION", "frontmatter block is not closed by a line with ---");
  }
  return {
    hasFrontmatter: true,
    frontmatter: lines.slice(1, close).join("\n"),
    body: lines.slice(close + 1).join("\n"),
  };
}

/**
 * Parses the YAML of a frontmatter block into a mapping. Errors never echo the content (it may be
 * long or sensitive); they report only the line number.
 */
export function parseFrontmatter(text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = parse(text);
  } catch (error) {
    const line = yamlLine(error);
    throw nexusError(
      "VALIDATION",
      `frontmatter is not valid YAML${line === undefined ? "" : ` (frontmatter line ${line})`}`,
      { cause: error },
    );
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw nexusError("VALIDATION", "frontmatter must be a YAML mapping");
  }
  return value as Record<string, unknown>;
}

function yamlLine(error: unknown): number | undefined {
  const positions = (error as { linePos?: readonly { line?: unknown }[] } | null)?.linePos;
  const line = positions?.[0]?.line;
  return typeof line === "number" ? line : undefined;
}
