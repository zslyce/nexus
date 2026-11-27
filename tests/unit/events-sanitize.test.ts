import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, sanitizeCommand, sanitizeText, truncate, workspacePath } from "../../src/events/index.ts";
import { WORKSPACE } from "./events-fixtures.ts";

test("truncate keeps short values and marks cut ones", () => {
  assert.equal(truncate("short", 10), "short");
  const cut = truncate("x".repeat(50), 10);
  assert.equal(cut.length, 10);
  assert.ok(cut.endsWith("..."));
});

test("sanitizeText collapses whitespace, redacts credentials and then truncates", () => {
  const text = sanitizeText("deploy\n\n  --token=SAMPLE-TOKEN-1234   now", LIMITS.text);
  assert.equal(text, "deploy --token=[REDACTED] now");
  assert.ok(!text.includes("SAMPLE-TOKEN-1234"));
});

test("sanitizeCommand shortens long commands and never keeps the raw secret", () => {
  const long = `npm run build -- ${"flag ".repeat(80)} --password=SAMPLE-PASSWORD-hunter`;
  const sanitized = sanitizeCommand(long);
  assert.ok(sanitized.length <= LIMITS.command);
  assert.ok(sanitized.endsWith("..."));
  assert.ok(!sanitized.includes("SAMPLE-PASSWORD-hunter"));
});

test("workspacePath makes paths relative with forward slashes", () => {
  assert.equal(workspacePath(WORKSPACE, "C:\\workspace\\src\\a.ts"), "src/a.ts");
  assert.equal(workspacePath(WORKSPACE, "c:\\WORKSPACE\\notes.txt"), "notes.txt");
  assert.equal(workspacePath(WORKSPACE, "src\\b.ts"), "src/b.ts");
  assert.equal(workspacePath(WORKSPACE, "C:\\workspace"), ".");
});

test("workspacePath reduces outside paths to their basename", () => {
  assert.equal(workspacePath(WORKSPACE, "D:\\elsewhere\\secret-notes.txt"), "[outside-workspace]/secret-notes.txt");
  assert.equal(workspacePath(WORKSPACE, "..\\..\\etc\\passwd"), "[outside-workspace]/passwd");
  // Drive-relative input is refused as a location; only its basename is kept.
  assert.equal(workspacePath(WORKSPACE, "C:foo.txt"), "[outside-workspace]/foo.txt");
});

test("workspacePath rejects values that are not usable paths", () => {
  assert.equal(workspacePath(WORKSPACE, undefined), undefined);
  assert.equal(workspacePath(WORKSPACE, ""), undefined);
  assert.equal(workspacePath(WORKSPACE, 42), undefined);
  assert.equal(workspacePath(WORKSPACE, "a\0b"), undefined);
});

test("workspacePath handles POSIX workspaces", () => {
  assert.equal(workspacePath("/home/user/project", "/home/user/project/src/a.ts"), "src/a.ts");
  assert.equal(workspacePath("/home/user/project", "/etc/hosts"), "[outside-workspace]/hosts");
});
