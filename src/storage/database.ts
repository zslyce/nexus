import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { NexusError } from "../contracts/common.ts";
import { MIGRATIONS, latestVersion, migrate, readUserVersion, type Migration } from "./migrations/index.ts";

export const MEMORY_DATABASE = ":memory:";
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/** Positional (`?`) values, or named values keyed by `$name`. */
export type SqlParam = SQLInputValue;
export type SqlParams = readonly SqlParam[];

export interface OpenDatabaseOptions {
  busyTimeoutMs?: number;
  /** Defaults to the schema in `./migrations/index.ts`. Tests may pass their own list. */
  migrations?: readonly Migration[];
}

/**
 * Thin wrapper over `node:sqlite` (synchronous, single connection). Owns the transaction
 * depth: the outermost call is `BEGIN IMMEDIATE`, nested calls use savepoints.
 */
export class Database {
  readonly path: string;
  private readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private savepointSequence = 0;
  private closed = false;

  constructor(raw: DatabaseSync, path: string) {
    this.raw = raw;
    this.path = path;
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  exec(sql: string): void {
    this.assertOpen();
    this.raw.exec(sql);
  }

  all<T>(sql: string, params: SqlParams = []): T[] {
    return this.statement(sql).all(...params) as unknown as T[];
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    return this.statement(sql).get(...params) as unknown as T | undefined;
  }

  run(sql: string, params: SqlParams = []): { changes: number; lastInsertRowid: number } {
    const result = this.statement(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  /**
   * Runs `fn` atomically. Nested calls join the outer transaction through a savepoint, so an
   * inner failure rolls back only its own work when the caller catches it. `fn` must be synchronous.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    const outermost = this.depth === 0;
    const savepoint = `nexus_sp_${this.savepointSequence++}`;
    this.depth += 1;
    try {
      this.raw.exec(outermost ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      let result: T;
      try {
        result = fn();
        if (isPromiseLike(result)) {
          throw new NexusError({
            code: "INTERNAL",
            message: "Store transaction callbacks must be synchronous",
            transient: false,
          });
        }
      } catch (error) {
        this.rollback(outermost, savepoint, error);
        throw error;
      }
      this.commit(outermost, savepoint);
      return result;
    } finally {
      this.depth -= 1;
    }
  }

  /**
   * Returns free pages to the file system. Skipped inside a transaction (VACUUM cannot run there).
   * Uses incremental vacuum when the file was created with `auto_vacuum = INCREMENTAL`; otherwise
   * a full VACUUM when more than a quarter of the pages are free.
   */
  reclaimSpace(): void {
    this.assertOpen();
    if (this.inTransaction) return;
    const mode = Number(this.get<{ auto_vacuum: number }>("PRAGMA auto_vacuum")?.auto_vacuum ?? 0);
    if (mode === 2) {
      this.exec("PRAGMA incremental_vacuum");
      return;
    }
    const free = Number(this.get<{ freelist_count: number }>("PRAGMA freelist_count")?.freelist_count ?? 0);
    const pages = Number(this.get<{ page_count: number }>("PRAGMA page_count")?.page_count ?? 0);
    if (free > 0 && free * 4 >= pages) this.exec("VACUUM");
  }

  close(): void {
    if (this.closed) return;
    if (this.inTransaction) {
      throw new NexusError({
        code: "INTERNAL",
        message: "Cannot close the database inside a transaction",
        transient: false,
      });
    }
    this.statements.clear();
    this.raw.close();
    this.closed = true;
  }

  private statement(sql: string): StatementSync {
    this.assertOpen();
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private commit(outermost: boolean, savepoint: string): void {
    try {
      this.raw.exec(outermost ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
    } catch (error) {
      if (outermost) this.tryRollbackAll();
      throw new NexusError({ code: "INTERNAL", message: "Commit failed; nothing was written", transient: false }, { cause: error });
    }
  }

  private rollback(outermost: boolean, savepoint: string, original: unknown): void {
    try {
      if (outermost) {
        this.raw.exec("ROLLBACK");
      } else {
        this.raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
    } catch (rollbackError) {
      throw new NexusError(
        { code: "INTERNAL", message: "Rollback failed; the database may need a restart", transient: false },
        { cause: { original, rollbackError } },
      );
    }
  }

  private tryRollbackAll(): void {
    try {
      if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
    } catch {
      // The commit error is the one worth reporting.
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new NexusError({ code: "INTERNAL", message: "Database is closed", transient: false });
    }
  }
}

/**
 * Opens (creating if needed) a Nexus database file. Order matters for safety:
 * 1. integrity check and schema version, read-only;
 * 2. only then pragmas that write (WAL) and migrations.
 * A corrupt file or a file from a newer build raises an error and is not modified.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  const migrations = options.migrations ?? MIGRATIONS;
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  const inMemory = path === MEMORY_DATABASE;
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });

  let raw: DatabaseSync;
  try {
    raw = new DatabaseSync(path, { timeout: busyTimeoutMs });
  } catch (error) {
    throw new NexusError({ code: "INTERNAL", message: `Cannot open database ${path}`, transient: false }, { cause: error });
  }

  const db = new Database(raw, path);
  try {
    assertIntact(db, path);
    const version = readUserVersion(db);
    const latest = latestVersion(migrations);
    if (version > latest) {
      throw new NexusError({
        code: "INTERNAL",
        message: `Database ${path} has schema version ${version}, newer than this build (${latest}); the file was not modified`,
        transient: false,
      });
    }
    if (version === 0 && isEmpty(db)) {
      // Must precede the WAL switch and any table: after that it only takes effect with a VACUUM.
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    }
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)}`);
    db.exec("PRAGMA synchronous = NORMAL");
    if (!inMemory) db.get("PRAGMA journal_mode = WAL");
    migrate(db, migrations);
    return db;
  } catch (error) {
    closeQuietly(db);
    if (error instanceof NexusError) throw error;
    throw new NexusError({ code: "INTERNAL", message: `Cannot open database ${path}`, transient: false }, { cause: error });
  }
}

function assertIntact(db: Database, path: string): void {
  const corrupt = (cause?: unknown) =>
    new NexusError(
      {
        code: "INTERNAL",
        message: `Database ${path} is not a valid Nexus database or is corrupt; the file was not modified`,
        transient: false,
      },
      cause === undefined ? undefined : { cause },
    );

  let rows: Record<string, unknown>[];
  try {
    rows = db.all<Record<string, unknown>>("PRAGMA quick_check");
  } catch (error) {
    // SQLITE_CORRUPT (11) or SQLITE_NOTADB (26): the file is not a usable database.
    if (isSqliteCorruption(error)) throw corrupt(error);
    throw new NexusError({ code: "INTERNAL", message: `Cannot read database ${path}`, transient: false }, { cause: error });
  }
  const healthy = rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok";
  if (!healthy) throw corrupt();
}

function isSqliteCorruption(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return code === 11 || code === 26;
}

function isEmpty(db: Database): boolean {
  const row = db.get<{ tables: number }>("SELECT COUNT(*) AS tables FROM sqlite_schema WHERE type = 'table'");
  return Number(row?.tables ?? 0) === 0;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function closeQuietly(db: Database): void {
  try {
    db.close();
  } catch {
    // Best effort: the original error is the one to report.
  }
}
