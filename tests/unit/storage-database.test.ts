import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NexusError } from "../../src/contracts/common.ts";
import { MEMORY_DATABASE, openDatabase, type Database } from "../../src/storage/database.ts";
import { MIGRATIONS, migrate, readUserVersion } from "../../src/storage/migrations/index.ts";
import { openStore } from "../../src/storage/sqlite-store.ts";
import {
  insertInStatus,
  makeAgent,
  makeDraft,
  makeResult,
  makeTask,
  tempWorkspace,
} from "./storage-fixtures.ts";

const workspace = tempWorkspace();
after(workspace.cleanup);

function pathFor(name: string): string {
  const path = join(workspace.dir, name, "nexus.db");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

/** Pragmas return their value under a column whose name varies (e.g. `timeout` for busy_timeout). */
function pragmaValue(db: Database, name: string): unknown {
  return Object.values(db.get<Record<string, unknown>>(`PRAGMA ${name}`) ?? {})[0];
}

function assertNexusError(error: unknown, code: string, pattern: RegExp): void {
  assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
  assert.equal(error.info.code, code);
  assert.match(error.info.message, pattern);
}

describe("database file", () => {
  test("a new file gets the schema, WAL, foreign keys and incremental auto_vacuum", () => {
    const db = openDatabase(pathFor("fresh"));
    try {
      assert.equal(pragmaValue(db, "journal_mode"), "wal");
      assert.equal(pragmaValue(db, "foreign_keys"), 1);
      assert.equal(pragmaValue(db, "busy_timeout"), 5000);
      assert.equal(pragmaValue(db, "auto_vacuum"), 2);
      assert.equal(readUserVersion(db), MIGRATIONS.length);
      const tables = db
        .all<{ name: string }>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map((row) => row.name);
      assert.deepEqual(tables, [
        "agent_snapshots",
        "attempts",
        "events",
        "results",
        "task_dependencies",
        "tasks",
      ]);
    } finally {
      db.close();
    }
  });

  test("reopening keeps tasks, dependencies, events, results and snapshots", () => {
    const path = pathFor("reopen");
    const agent = makeAgent();
    const parent = makeTask({ id: "tsk_parent", status: "completed", stage: "finalization", finishedAt: 2_000 });
    const child = makeTask({ id: "tsk_child", dependsOn: ["tsk_parent"], status: "queued", queuedAt: 3_000 });
    const first = openStore(path);
    try {
      insertInStatus(first, parent);
      first.insertTask(child, agent);
      first.appendEvent(makeDraft("tsk_child", "evt-1"));
      first.saveResult(makeResult("tsk_parent"));
    } finally {
      first.close();
    }

    const second = openStore(path);
    try {
      assert.deepEqual(second.getTask("tsk_child"), child);
      assert.deepEqual(second.getTask("tsk_parent"), parent);
      assert.equal(second.listEvents({ taskId: "tsk_child" }).length, 1);
      assert.deepEqual(second.getResult("tsk_parent"), makeResult("tsk_parent"));
      assert.deepEqual(second.getAgentSnapshot("tsk_child"), agent);
    } finally {
      second.close();
    }
  });

  test("migrating twice is harmless and leaves the version unchanged", () => {
    const path = pathFor("twice");
    openStore(path).close();
    const again = openDatabase(path);
    try {
      const noop = { from: MIGRATIONS.length, to: MIGRATIONS.length, applied: [] };
      assert.deepEqual(migrate(again, MIGRATIONS), noop);
      assert.deepEqual(migrate(again, MIGRATIONS), noop);
      assert.equal(readUserVersion(again), MIGRATIONS.length);
    } finally {
      again.close();
    }
    const reopened = openStore(path);
    reopened.close();
  });

  test("a database from a newer build is rejected and its bytes are unchanged", () => {
    const path = pathFor("future");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE precious (value TEXT); INSERT INTO precious VALUES ('keep me'); PRAGMA user_version = 99;");
    raw.close();
    const before = readFileSync(path);

    assert.throws(
      () => openStore(path),
      (error: unknown) => {
        assertNexusError(error, "INTERNAL", /newer than this build/);
        return true;
      },
    );
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(`${path}-wal`), false);
  });

  test("a corrupt file raises an explicit error and is left untouched", () => {
    const path = pathFor("corrupt");
    writeFileSync(path, Buffer.from("definitely not sqlite ".repeat(400)));
    const before = readFileSync(path);

    assert.throws(
      () => openStore(path),
      (error: unknown) => {
        assertNexusError(error, "INTERNAL", /not a valid Nexus database or is corrupt/);
        return true;
      },
    );
    assert.deepEqual(readFileSync(path), before);
    assert.equal(existsSync(`${path}-wal`), false);
  });

  test("the parent folder is created when missing", () => {
    const path = join(workspace.dir, "deep", "nested", "nexus.db");
    const store = openStore(path);
    try {
      assert.equal(existsSync(path), true);
    } finally {
      store.close();
    }
  });

  test("an in-memory database works for other modules' tests and is not written to disk", () => {
    const store = openStore(MEMORY_DATABASE);
    try {
      store.insertTask(makeTask({ id: "tsk_mem" }));
      assert.equal(store.getTask("tsk_mem")?.id, "tsk_mem");
    } finally {
      store.close();
    }
  });

  test("a closed store rejects further calls explicitly", () => {
    const store = openStore(pathFor("closed"));
    store.close();
    assert.throws(
      () => store.getTask("tsk_missing"),
      (error: unknown) => {
        assertNexusError(error, "INTERNAL", /closed/);
        return true;
      },
    );
    store.close();
  });
});
