/**
 * SQLite connection manager for @npm-safe/core.
 *
 * Owns a single `better-sqlite3` connection, configures WAL-mode pragmas for
 * safe concurrent reads, and runs the migration list declared in
 * {@link ./schema.ts} on construction. This module is pure connection +
 * migration management — no query helpers, no caching, no business logic.
 *
 * @module store/database
 */

import Database from "better-sqlite3";
import { SCHEMA_SQL, getMigrationList, getInitialMigration } from "./schema.js";

/**
 * Error thrown by {@link DatabaseManager} when the underlying `better-sqlite3`
 * operation fails (open, pragma, migration). Wraps the original error so
 * callers can branch on a single typed error while still inspecting the cause.
 */
export class DatabaseManagerError extends Error {
  /**
   * @param message - Human-readable error message.
   * @param cause - The underlying error, if any.
   */
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DatabaseManagerError";
  }
}

/**
 * Maps a migration file name to the SQL it should execute. Today only the
 * initial migration exists; future migrations add entries here.
 *
 * @param name - Migration file name from {@link getMigrationList}.
 * @returns The SQL string to run for that migration.
 */
function getMigrationSql(name: string): string {
  switch (name) {
    case "001_initial.sql":
      return getInitialMigration();
    default:
      throw new DatabaseManagerError(`Unknown migration: ${name}`);
  }
}

/**
 * Manages the lifecycle of a single SQLite database connection.
 *
 * On construction it opens the database file (creating it if missing),
 * applies WAL-mode and safety pragmas, then runs any unapplied migrations
 * from {@link getMigrationList} inside a transaction. The connection is
 * kept open and accessible via {@link DatabaseManager.getDb} until
 * {@link DatabaseManager.close} is called.
 */
export class DatabaseManager {
  /** Underlying better-sqlite3 connection, or `null` after `close()`. */
  private db: Database.Database | null;

  /**
   * Opens (or creates) the database at `dbPath`, configures pragmas, and
   * runs pending migrations. Throws {@link DatabaseManagerError} on any
   * failure during open, pragma, or migration.
   *
   * @param dbPath - Filesystem path to the SQLite database file.
   */
  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath, { fileMustExist: false });
    } catch (err) {
      throw new DatabaseManagerError(
        `Failed to open database at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    this.applyPragmas();
    this.runMigrations();
  }

  /**
   * Apply the connection-level pragmas: WAL journal mode, a 5s busy timeout,
   * NORMAL synchronous (safe under WAL), and foreign-key enforcement.
   */
  private applyPragmas(): void {
    const pragmas = [
      "journal_mode=WAL",
      "busy_timeout=5000",
      "synchronous=NORMAL",
      "foreign_keys=ON",
    ];
    for (const stmt of pragmas) {
      try {
        this.db!.pragma(stmt);
      } catch (err) {
        throw new DatabaseManagerError(
          `Failed to apply pragma "${stmt}": ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
    }
  }

  /**
   * Run all migrations from {@link getMigrationList} that have not yet been
   * recorded in the `_migrations` table. The `_migrations` tracking table is
   * created idempotently first (it is also part of {@link SCHEMA_SQL}, but
   * we create it here so the very first migration can be recorded even when
   * the schema is empty).
   *
   * Each migration is applied in its own transaction; on success its name is
   * inserted into `_migrations`.
   */
  private runMigrations(): void {
    const db = this.db!;
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT NOT NULL UNIQUE,
          applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    } catch (err) {
      throw new DatabaseManagerError(
        `Failed to create _migrations tracking table: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const selectApplied = db.prepare<string>(
      "SELECT name FROM _migrations WHERE name = ?",
    );

    const insertMigration = db.prepare<string>(
      "INSERT INTO _migrations (name) VALUES (?)",
    );

    const applyOne = (name: string, sql: string): void => {
      const tx = db.transaction(() => {
        db.exec(sql);
        insertMigration.run(name);
      });
      tx();
    };

    for (const name of getMigrationList()) {
      const existing = selectApplied.get(name);
      if (existing !== undefined) {
        continue;
      }
      try {
        applyOne(name, getMigrationSql(name));
      } catch (err) {
        throw new DatabaseManagerError(
          `Failed to apply migration "${name}": ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
    }
  }

  /**
   * Returns the underlying `better-sqlite3` connection. Throws if the
   * connection has been closed.
   *
   * @returns The active better-sqlite3 `Database` instance.
   */
  getDb(): Database.Database {
    if (this.db === null) {
      throw new DatabaseManagerError("Database is not open");
    }
    return this.db;
  }

  /**
   * Closes the database connection. Safe to call multiple times; subsequent
   * calls are no-ops. Throws {@link DatabaseManagerError} if the underlying
   * close fails.
   */
  close(): void {
    if (this.db === null) {
      return;
    }
    try {
      this.db.close();
    } catch (err) {
      throw new DatabaseManagerError(
        `Failed to close database: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      this.db = null;
    }
  }

  /**
   * Whether the database connection is currently open.
   *
   * @returns `true` if the connection has not been closed.
   */
  isOpen(): boolean {
    return this.db !== null;
  }
}