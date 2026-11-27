import { NexusError } from "../../contracts/common.ts";
import type { Database } from "../database.ts";

export interface Migration {
  /** 1, 2, 3... with no gaps. Stored in `PRAGMA user_version`. */
  readonly version: number;
  readonly name: string;
  /** Plain SQL, executed inside the migration transaction. */
  readonly sql: string;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: number[];
}

export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
}

export function assertMigrationList(migrations: readonly Migration[]): void {
  let expected = 1;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new NexusError({
        code: "INTERNAL",
        message: `Migration versions must be 1..n without gaps; found ${migration.version} where ${expected} was expected`,
        transient: false,
      });
    }
    if (migration.name.trim() === "" || migration.sql.trim() === "" || names.has(migration.name)) {
      throw new NexusError({
        code: "INTERNAL",
        message: `Migration ${migration.version} needs a unique name and non-empty SQL`,
        transient: false,
      });
    }
    names.add(migration.name);
    expected += 1;
  }
}

export function readUserVersion(db: Database): number {
  const row = db.get<{ user_version: number }>("PRAGMA user_version");
  return Number(row?.user_version ?? 0);
}

/**
 * Applies pending migrations, each one in its own transaction together with the version bump.
 * Safe to run on every start: an up-to-date database is left untouched. The version is read
 * again under the write lock, so two processes migrating at once cannot apply a step twice.
 * A database whose version is newer than this build is rejected without any change.
 */
export function migrate(db: Database, migrations: readonly Migration[]): MigrationResult {
  assertMigrationList(migrations);
  const latest = latestVersion(migrations);
  const initial = readUserVersion(db);
  assertNotFuture(initial, latest);
  if (initial === latest) return { from: initial, to: initial, applied: [] };

  const applied: number[] = [];
  let finalVersion = initial;
  db.transaction(() => {
    const current = readUserVersion(db);
    assertNotFuture(current, latest);
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      try {
        db.exec(migration.sql);
      } catch (error) {
        throw new NexusError(
          {
            code: "INTERNAL",
            message: `Migration ${migration.version} (${migration.name}) failed; its changes were rolled back`,
            transient: false,
          },
          { cause: error },
        );
      }
      db.exec(`PRAGMA user_version = ${migration.version}`);
      applied.push(migration.version);
      finalVersion = migration.version;
    }
  });
  return { from: initial, to: finalVersion, applied };
}

function assertNotFuture(version: number, latest: number): void {
  if (version > latest) {
    throw new NexusError({
      code: "INTERNAL",
      message: `Database schema version ${version} is newer than this build supports (${latest}); the file was not modified`,
      transient: false,
    });
  }
}
