/**
 * SQLite DDL schema and migration helpers for @npm-safe/core.
 *
 * This module is a pure SQL-string + types module. It MUST NOT import or
 * execute better-sqlite3; consumers (e.g. the store layer) are responsible
 * for running the SQL through `Database#prepare().run()`.
 */

/**
 * Full DDL for the core database. Contains 6 application tables plus the
 * `_migrations` bookkeeping table used by the migration runner.
 *
 * Tables:
 *  1. packages          - cached npm package metadata
 *  2. package_versions  - per-version info
 *  3. security_reports  - scan results (static + llm)
 *  4. watchlist         - user-tracked packages
 *  5. settings          - key-value configuration
 *  6. translations      - cached translation results
 *  7. _migrations       - migration tracking (internal)
 */
export const SCHEMA_SQL = `
-- 1. packages table - cached npm package metadata
CREATE TABLE IF NOT EXISTS packages (
  name                TEXT PRIMARY KEY,
  latest_version      TEXT NOT NULL,
  description         TEXT DEFAULT '',
  homepage            TEXT DEFAULT '',
  repository          TEXT DEFAULT '',
  registry_data       TEXT DEFAULT '{}',  -- JSON blob of raw registry response
  cached_at           TEXT NOT NULL DEFAULT (datetime('now')),
  ttl_until           TEXT NOT NULL       -- cache expiry timestamp
);

-- 2. package_versions table - version info
CREATE TABLE IF NOT EXISTS package_versions (
  package_name  TEXT NOT NULL REFERENCES packages(name) ON DELETE CASCADE,
  version       TEXT NOT NULL,
  publish_time  TEXT,
  has_readme    INTEGER NOT NULL DEFAULT 0,
  integrity     TEXT,
  PRIMARY KEY (package_name, version)
);

-- 3. security_reports table - scan results
CREATE TABLE IF NOT EXISTS security_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  package_name  TEXT NOT NULL REFERENCES packages(name) ON DELETE CASCADE,
  version       TEXT NOT NULL,
  scan_type     TEXT NOT NULL CHECK(scan_type IN ('static', 'llm')),
  overall_score INTEGER NOT NULL CHECK(overall_score >= 0 AND overall_score <= 100),
  findings_json TEXT DEFAULT '[]',   -- JSON array of ScanFinding objects
  summary       TEXT DEFAULT '',
  scanned_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(package_name, version, scan_type)
);

-- 4. watchlist table - user-tracked packages
CREATE TABLE IF NOT EXISTS watchlist (
  package_name  TEXT PRIMARY KEY REFERENCES packages(name) ON DELETE CASCADE,
  added_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5. settings table - key-value configuration
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 6. translations table - cached translations
CREATE TABLE IF NOT EXISTS translations (
  source_hash     TEXT PRIMARY KEY,
  source_text     TEXT NOT NULL,
  target_lang     TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  provider        TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_translations_lang ON translations(target_lang);

-- 7. _migrations table - migration tracking
CREATE TABLE IF NOT EXISTS _migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Returns ordered list of migration file names to apply.
 *
 * Migrations are applied in order; each name must be unique. The initial
 * migration (`001_initial.sql`) is expected to create every table in
 * {@link SCHEMA_SQL} via {@link getInitialMigration}.
 */
export function getMigrationList(): string[] {
  return [
    '001_initial.sql',
    '002_check_history.sql',
  ];
}

/**
 * Returns the SQL for the `check_history` migration: a table recording every
 * check performed by the CLI or the desktop extension so the GUI can load
 * history straight from the shared database.
 */
export function getCheckHistoryMigration(): string {
  return `
-- 8. check_history table - persistent check history
CREATE TABLE IF NOT EXISTS check_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  package_name  TEXT NOT NULL,
  level         TEXT NOT NULL,
  score         INTEGER NOT NULL CHECK(score >= 0 AND score <= 100),
  timestamp     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_check_history_timestamp ON check_history(timestamp DESC);
`;
}

/**
 * Returns the SQL for the initial migration. This is the same DDL as
 * {@link SCHEMA_SQL}, wrapped for the migration system so the runner can
 * record it under the `001_initial.sql` name.
 */
export function getInitialMigration(): string {
  return SCHEMA_SQL;
}