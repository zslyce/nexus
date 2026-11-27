import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexusError } from "../../src/contracts/index.ts";
import { resolveWorkspacePath } from "../../src/utils/index.ts";

const WIN = process.platform === "win32";
const LINK_TYPE = WIN ? "junction" : "dir";

const cleanups: Array<() => void> = [];
after(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

/**
 * Creates `<base>/ws` with `src/index.ts`, a sibling `<base>/outside` directory and a sibling
 * `<base>/ws-evil` (same prefix as the workspace). Links are removed explicitly before deleting the
 * temporary tree, so cleanup never follows them.
 */
function setup(): { ws: string; outside: string; base: string; link: (name: string, target: string) => void } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "nexus-paths-")));
  const ws = join(base, "ws");
  const outside = join(base, "outside");
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(outside);
  mkdirSync(join(base, "ws-evil"));
  writeFileSync(join(ws, "src", "index.ts"), "export {};");
  writeFileSync(join(outside, "secret.txt"), "secret");
  const links: string[] = [];
  const link = (name: string, target: string): void => {
    const path = join(ws, name);
    symlinkSync(target, path, LINK_TYPE);
    links.push(path);
  };
  cleanups.push(() => {
    for (const path of links) {
      try {
        unlinkSync(path);
      } catch {
        rmdirSync(path);
      }
    }
    rmSync(base, { recursive: true, force: true });
  });
  return { ws, outside, base, link };
}

function expectCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
    assert.equal(error.info.code, code);
    return true;
  });
}

const expectOutside = (run: () => unknown): void => expectCode(run, "PATH_OUTSIDE_WORKSPACE");

test("relative paths inside the workspace are returned normalized", () => {
  const { ws } = setup();
  assert.equal(resolveWorkspacePath(ws, "src/index.ts"), "src/index.ts");
  assert.equal(resolveWorkspacePath(ws, "./src//index.ts"), "src/index.ts");
  assert.equal(resolveWorkspacePath(ws, "src/../src/index.ts"), "src/index.ts");
  assert.equal(resolveWorkspacePath(ws, "."), ".");
});

test("a file that does not exist yet is accepted inside the workspace", () => {
  const { ws } = setup();
  assert.equal(resolveWorkspacePath(ws, "src/new/feature.ts"), "src/new/feature.ts");
});

test("parent segments that escape the workspace are rejected", () => {
  const { ws } = setup();
  expectOutside(() => resolveWorkspacePath(ws, ".."));
  expectOutside(() => resolveWorkspacePath(ws, "../outside/secret.txt"));
  expectOutside(() => resolveWorkspacePath(ws, "src/../../outside/secret.txt"));
  expectOutside(() => resolveWorkspacePath(ws, "src/../../ws-evil/x.ts"));
});

test("an absolute path outside the workspace is rejected", () => {
  const { ws, outside } = setup();
  expectOutside(() => resolveWorkspacePath(ws, join(outside, "secret.txt")));
});

test("an absolute path inside the workspace is returned relative", () => {
  const { ws } = setup();
  assert.equal(resolveWorkspacePath(ws, join(ws, "src", "index.ts")), "src/index.ts");
});

test("a sibling directory that shares the workspace name prefix is outside", () => {
  const { ws, base } = setup();
  expectOutside(() => resolveWorkspacePath(ws, join(base, "ws-evil", "x.ts")));
  expectOutside(() => resolveWorkspacePath(ws, "../ws-evil/x.ts"));
});

test("empty input and NUL bytes are VALIDATION errors", () => {
  const { ws } = setup();
  expectCode(() => resolveWorkspacePath(ws, ""), "VALIDATION");
  expectCode(() => resolveWorkspacePath(ws, "src/\0index.ts"), "VALIDATION");
});

test("a workspace that does not exist is NOT_FOUND", () => {
  expectCode(() => resolveWorkspacePath(join(tmpdir(), "nexus-missing-" + Date.now()), "a.ts"), "NOT_FOUND");
});

test("a link inside the workspace that points outside is rejected, even for a path through it", () => {
  const { ws, outside, link } = setup();
  link("escape", outside);
  expectOutside(() => resolveWorkspacePath(ws, "escape"));
  expectOutside(() => resolveWorkspacePath(ws, "escape/secret.txt"));
  expectOutside(() => resolveWorkspacePath(ws, "escape/not-yet/created.ts"));
});

test("a link inside the workspace that points inside is returned with its canonical path", () => {
  const { ws, link } = setup();
  link("alias", join(ws, "src"));
  assert.equal(resolveWorkspacePath(ws, "alias/index.ts"), "src/index.ts");
  assert.equal(resolveWorkspacePath(ws, "alias/new.ts"), "src/new.ts");
});

test("a dangling link is rejected because its target cannot be verified", () => {
  const { ws, base, link } = setup();
  link("dangling", join(base, "missing-target"));
  expectOutside(() => resolveWorkspacePath(ws, "dangling/file.ts"));
});

test("on Windows, paths are compared case-insensitively and the canonical casing is returned", {
  skip: !WIN && "Windows only",
}, () => {
  const { ws } = setup();
  assert.equal(resolveWorkspacePath(ws, "SRC\\INDEX.TS"), "src/index.ts");
  assert.equal(resolveWorkspacePath(ws.toUpperCase(), "src/index.ts"), "src/index.ts");
  assert.equal(resolveWorkspacePath(ws, join(ws.toLowerCase(), "src", "index.ts")), "src/index.ts");
});

test("on Windows, UNC paths are rejected", { skip: !WIN && "Windows only" }, () => {
  const { ws } = setup();
  expectOutside(() => resolveWorkspacePath(ws, "\\\\server\\share\\file.txt"));
  expectOutside(() => resolveWorkspacePath(ws, "//server/share/file.txt"));
});

test("on Windows, a path on another drive is rejected", { skip: !WIN && "Windows only" }, () => {
  const { ws } = setup();
  const currentDrive = ws.slice(0, 1).toUpperCase();
  const otherDrive = currentDrive === "Z" ? "Y" : "Z";
  expectOutside(() => resolveWorkspacePath(ws, `${otherDrive}:\\data\\file.txt`));
});

test("on Windows, drive-relative and rooted-without-drive paths are rejected", { skip: !WIN && "Windows only" }, () => {
  const { ws } = setup();
  expectOutside(() => resolveWorkspacePath(ws, "C:secret.txt"));
  expectOutside(() => resolveWorkspacePath(ws, "\\Windows\\win.ini"));
  expectOutside(() => resolveWorkspacePath(ws, "/Windows/win.ini"));
});

test("on Windows, alternate data streams (colons in names) are rejected", { skip: !WIN && "Windows only" }, () => {
  const { ws } = setup();
  expectOutside(() => resolveWorkspacePath(ws, "src\\index.ts:stream"));
});

test("on Windows, an absolute path with a drive letter inside the workspace is accepted", { skip: !WIN && "Windows only" }, () => {
  const { ws } = setup();
  assert.equal(resolveWorkspacePath(ws, join(ws, "src", "index.ts")), "src/index.ts");
});

test("a path below a regular file is classified without an unexpected error", () => {
  const { ws } = setup();
  writeFileSync(join(ws, "plain.txt"), "x");
  // A path below a regular file cannot exist; it is still inside the workspace, so it is returned.
  assert.equal(resolveWorkspacePath(ws, "plain.txt/child.ts"), "plain.txt/child.ts");
});
