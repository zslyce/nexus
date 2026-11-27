import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { NexusError } from "../../src/contracts/common.ts";
import { openDatabase, type Database } from "../../src/storage/database.ts";
import {
  MIGRATIONS,
  assertMigrationList,
  latestVersion,
  migrate,
  readUserVersion,
  type Migration,
} from "../../src/storage/migrations/index.ts";
import { tempWorkspace } from "./storage-fixtures.ts";

const workspace = tempWorkspace();
after(workspace.cleanup);

let counter = 0;
function freshPath(): string {
  counter += 1;
  return `${workspace.dir}/migrations-${counter}/nexus.db`;
}

const FIRST: Migration = { version: 1, name: "first", sql: "CREATE TABLE a (id INTEGER PRIMARY KEY);" };
const SECOND: Migration = { version: 2, name: "second", sql: "CREATE TABLE b (id INTEGER PRIMARY KEY);" };
const BROKEN: Migration = {
  version: 2,
  name: "broken",
  sql: "CREATE TABLE b (id INTEGER PRIMARY KEY); SELEC nonsense;",
};

function tableNames(db: Database): string[] {
  return db
    .all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .map((row) => row.name);
}

function expectNexusError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof NexusError, `expected NexusError, got ${String(error)}`);
    assert.equal(error.info.code, "INTERNAL");
    assert.match(error.info.message, pattern);
    return true;
  });
}

describe("migration list", () => {
  test("the shipped schema is a valid, gap-free list", () => {
    assert.doesNotThrow(() => assertMigrationList(MIGRATIONS));
    assert.equal(latestVersion(MIGRATIONS), MIGRATIONS.length);
  });

  test("versions must start at 1 and have no gaps", () => {
    expectNexusError(() => assertMigrationList([SECOND]), /without gaps/);
  });

  test("names must be unique and SQL must not be empty", () => {
    expectNexusError(() => assertMigrationList([FIRST, { version: 2, name: "first", sql: "SELECT 1;" }]), /unique name/);
    expectNexusError(() => assertMigrationList([{ version: 1, name: "empty", sql: "   " }]), /unique name/);
  });
});

describe("applying migrations", () => {
  test("a later migration is applied on top of an older database", () => {
    const db = openDatabase(freshPath(), { migrations: [FIRST] });
    try {
      assert.deepEqual(migrate(db, [FIRST, SECOND]), { from: 1, to: 2, applied: [2] });
      assert.equal(readUserVersion(db), 2);
      assert.deepEqual(tableNames(db), ["a", "b"]);
    } finally {
      db.close();
    }
  });

  test("a failing migration rolls back the whole run, including earlier steps of that run", () => {
    const path = freshPath();
    expectNexusError(() => openDatabase(path, { migrations: [FIRST, BROKEN] }), /Migration 2 \(broken\) failed/);

    const raw = new DatabaseSync(path);
    try {
      assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
      assert.equal(
        (raw.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table'").get() as { n: number }).n,
        0,
      );
    } finally {
      raw.close();
    }
  });

  test("a database newer than the build is refused and its version is not changed", () => {
    const path = freshPath();
    const db = openDatabase(path, { migrations: [FIRST, SECOND] });
    db.exec("PRAGMA user_version = 7");
    db.close();

    expectNexusError(() => openDatabase(path, { migrations: [FIRST, SECOND] }), /newer than this build/);
    expectNexusError(() => openDatabase(path, { migrations: [FIRST] }), /newer than this build/);

    const raw = new DatabaseSync(path);
    try {
      assert.equal((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 7);
    } finally {
      raw.close();
    }
  });

  test("migrate itself refuses a version newer than the list it was given", () => {
    const db = openDatabase(freshPath(), { migrations: [FIRST, SECOND] });
    try {
      db.exec("PRAGMA user_version = 5");
      expectNexusError(() => migrate(db, [FIRST, SECOND]), /newer than this build/);
    } finally {
      db.close();
    }
  });
});
