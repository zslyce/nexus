/**
 * Checks what the fake OpenCode served against the OpenAPI fixture (openapi-2.4.2.json): every request must
 * match a declared operation and every response status must be declared for it. Helper, not a test file.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import type { FakeOpenCode } from "./server-fake-opencode.ts";

interface Operation {
  readonly method: string;
  readonly path: RegExp;
  readonly statuses: ReadonlySet<string>;
}

let operations: Operation[] | undefined;

function loadOperations(): Operation[] {
  if (operations !== undefined) return operations;
  const url = new URL("../../tests/fixtures/opencode/openapi-2.4.2.json", import.meta.url);
  const spec = JSON.parse(readFileSync(url, "utf8")) as {
    paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
  };
  const found: Operation[] = [];
  for (const [template, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      found.push({
        method: method.toUpperCase(),
        path: templateToRegex(template),
        statuses: new Set(Object.keys(operation.responses ?? {})),
      });
    }
  }
  operations = found;
  return found;
}

/** `/api/session/{sessionID}/x` and `/api/fs/read/*` become regular expressions. */
function templateToRegex(template: string): RegExp {
  const source = template
    .split(/(\{[^}]+\}|\*)/)
    .map((part) => {
      if (part === "*") return ".*";
      if (part.startsWith("{") && part.endsWith("}")) return "[^/]+";
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`);
}

export function assertOpenApiConformance(fake: FakeOpenCode): void {
  const failures: string[] = [];
  for (const request of fake.unrouted) {
    failures.push(`${request.method} ${request.path} had no route in the fake`);
  }
  for (const response of fake.responses) {
    const matching = loadOperations().filter(
      (operation) => operation.method === response.method && operation.path.test(response.path),
    );
    if (matching.length === 0) {
      failures.push(`${response.method} ${response.path} is not in openapi-2.4.2.json`);
      continue;
    }
    const declared = matching.some((operation) => operation.statuses.has(String(response.status)));
    if (!declared) {
      failures.push(`${response.method} ${response.path} answered ${response.status}, not declared in openapi-2.4.2.json`);
    }
  }
  assert.deepEqual(failures, [], "the fake must only serve what OpenCode 2.4.2 declares");
}
