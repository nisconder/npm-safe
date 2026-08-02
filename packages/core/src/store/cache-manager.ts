/**
 * Cache read/write layer for @npm-safe/core.
 *
 * {@link CacheManager} sits on top of a {@link DatabaseManager} connection and
 * provides typed accessors for the cached npm metadata, security scan reports,
 * watchlist, and key-value settings tables. It owns the TTL policy for the
 * `packages` table: every {@link CacheManager.setPackage} call stamps the row
 * with an expiry timestamp (`ttl_until`) computed as `now + cacheTtlMs`, and
 * {@link CacheManager.getPackage} refuses to return rows whose TTL has
 * elapsed. Scheduling of refreshes is intentionally out of scope — that is
 * the job of the refresh-scheduler; this module only reads and writes.
 *
 * All methods return `Promise`s for API consistency and future async backing
 * stores, even though the underlying `better-sqlite3` calls are synchronous.
 *
 * @module store/cache-manager
 */

import Database from "better-sqlite3";
import { DatabaseManager } from "./database.js";
import type { PackageMetadata, PackageRepository } from "../registry/types.js";
import {
  SecurityLevel,
  type LlmScanReport,
  type StaticScanReport,
  type ScanFinding,
} from "../scanner/types.js";

/**
 * Default cache time-to-live for package metadata: 1 hour in milliseconds.
 */
export const DEFAULT_CACHE_TTL_MS = 3_600_000;

/**
 * Options accepted by the {@link CacheManager} constructor.
 */
export interface CacheManagerOptions {
  /**
   * Time-to-live for cached package metadata, in milliseconds. A row fetched
   * via {@link CacheManager.getPackage} is considered stale once `ttl_until`
   * is in the past. Sub-second TTLs (e.g. `500`) are supported and stored
   * with millisecond precision. Defaults to {@link DEFAULT_CACHE_TTL_MS}
   * (1 hour).
   */
  readonly cacheTtlMs?: number;
}

/**
 * Row shape returned by `SELECT * FROM packages` queries in this module.
 */
interface PackageRow {
  readonly name: string;
  readonly latest_version: string;
  readonly description: string;
  readonly homepage: string;
  readonly repository: string;
  readonly registry_data: string;
  readonly cached_at: string;
  readonly ttl_until: string;
}

/**
 * Row shape returned by `SELECT * FROM security_reports` queries in this module.
 */
interface SecurityReportRow {
  readonly id: number;
  readonly package_name: string;
  readonly version: string;
  readonly scan_type: string;
  readonly overall_score: number;
  readonly findings_json: string;
  readonly summary: string;
  readonly scanned_at: string;
}

/**
 * Row shape for the `watchlist` and `settings` single-column selects.
 */
interface NameRow {
  readonly package_name: string;
}
interface KeyValueRow {
  readonly key: string;
  readonly value: string;
}

/**
 * Derives a {@link SecurityLevel} from a numeric static-scan score using the
 * same thresholds as the static analyzer: `>=80` Safe, `>=50` Suspicious,
 * `>=20` Dangerous, otherwise Unknown. The `security_reports` table persists
 * only the numeric score (not the enum), so the level is reconstructed on
 * read to satisfy the {@link StaticScanReport} shape.
 *
 * @param score - Numeric score from 0 to 100 (higher is safer).
 * @returns The security level matching the score band.
 */
function scoreToLevel(score: number): SecurityLevel {
  if (score >= 80) return SecurityLevel.Safe;
  if (score >= 50) return SecurityLevel.Suspicious;
  if (score >= 20) return SecurityLevel.Dangerous;
  return SecurityLevel.Unknown;
}

/**
 * Normalizes a {@link PackageRepository} value to a plain string for storage
 * in the `packages.repository` TEXT column. Structured descriptors are
 * rendered as `type:url`; shorthand strings are stored verbatim.
 *
 * @param repo - The repository descriptor from registry metadata.
 * @returns A string representation suitable for storage.
 */
function repositoryToString(repo: PackageRepository | undefined): string {
  if (repo === undefined) return "";
  if (typeof repo === "string") return repo;
  return `${repo.type}:${repo.url}`;
}

/**
 * Cache read/write manager backed by a {@link DatabaseManager} connection.
 *
 * The manager is stateless beyond the TTL configuration and the injected
 * database handle, so it is safe to construct one per request or to share a
 * long-lived instance. All public methods are async-returning for API
 * consistency; the underlying `better-sqlite3` calls are synchronous.
 */
export class CacheManager {
  /** Underlying better-sqlite3 connection accessor. */
  private readonly db: Database.Database;
  /** Cache TTL in milliseconds applied to newly written package rows. */
  private readonly cacheTtlMs: number;

  /**
   * @param database - The {@link DatabaseManager} supplying the connection.
   * @param options - Optional configuration; see {@link CacheManagerOptions}.
   */
  constructor(database: DatabaseManager, options?: CacheManagerOptions) {
    this.db = database.getDb();
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Returns cached package metadata for `name` if the row is still fresh
   * (i.e. `ttl_until >= now`). Returns `null` when the row is missing or
   * stale; callers are expected to re-fetch from the registry and call
   * {@link CacheManager.setPackage} to refresh the cache.
   *
   * @param name - Fully-qualified package name (scope included when scoped).
   * @returns The cached {@link PackageMetadata}, or `null` if absent/stale.
   */
  async getPackage(name: string): Promise<PackageMetadata | null> {
    const row = this.db
      .prepare<[string]>(
        "SELECT name, latest_version, description, homepage, repository, registry_data, cached_at, ttl_until FROM packages WHERE name = ? AND ttl_until >= strftime('%Y-%m-%d %H:%M:%f', 'now')",
      )
      .get(name) as PackageRow | undefined;
    if (row === undefined) return null;
    try {
      const parsed = JSON.parse(row.registry_data) as PackageMetadata;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Upserts a package metadata row, stamping it with a fresh TTL computed as
   * `now + cacheTtlMs`. The full packument is serialized into the
   * `registry_data` JSON column; the scalar columns (`latest_version`,
   * `description`, `homepage`, `repository`) are denormalized for cheap
   * listing queries.
   *
   * @param meta - The packument returned by the npm registry.
   */
  async setPackage(meta: PackageMetadata): Promise<void> {
    const latest = meta["dist-tags"].latest;
    const description = meta.description ?? "";
    const homepage = meta.homepage ?? "";
    const repository = repositoryToString(meta.repository);
    const registryData = JSON.stringify(meta);
    // Fractional (sub-second) TTLs are supported: `datetime('now', ...)` would
    // truncate fractional seconds to whole seconds, so the expiry is stamped
    // via `strftime('%Y-%m-%d %H:%M:%f', ...)` which preserves milliseconds.
    // The value is a number derived from configuration, not user input, so
    // interpolating it into the SQL string is safe.
    const ttlSeconds = this.cacheTtlMs / 1000;
    this.db
      .prepare<[string, string, string, string, string, string]>(
        `INSERT INTO packages (name, latest_version, description, homepage, repository, registry_data, cached_at, ttl_until)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), strftime('%Y-%m-%d %H:%M:%f', 'now', '+${ttlSeconds} seconds'))
         ON CONFLICT(name) DO UPDATE SET
           latest_version = excluded.latest_version,
           description    = excluded.description,
           homepage        = excluded.homepage,
           repository      = excluded.repository,
           registry_data   = excluded.registry_data,
           cached_at       = datetime('now'),
           ttl_until       = strftime('%Y-%m-%d %H:%M:%f', 'now', '+${ttlSeconds} seconds')`,
      )
      .run(meta.name, latest, description, homepage, repository, registryData);
  }

  /**
   * Returns the most recent static security report for `pkg`@`version`, or
   * `null` if none is cached. The {@link SecurityLevel} is reconstructed from
   * the persisted numeric score because the `security_reports` table stores
   * only the score, not the enum.
   *
   * @param pkg - Fully-qualified package name.
   * @param version - Semver version string.
   * @returns The cached {@link StaticScanReport}, or `null` if absent.
   */
  async getSecurityReport(
    pkg: string,
    version: string,
  ): Promise<StaticScanReport | null> {
    const row = this.db
      .prepare<[string, string]>(
        "SELECT id, package_name, version, scan_type, overall_score, findings_json, summary, scanned_at FROM security_reports WHERE package_name = ? AND version = ? AND scan_type = 'static'",
      )
      .get(pkg, version) as SecurityReportRow | undefined;
    if (row === undefined) return null;
    let findings: readonly ScanFinding[] = [];
    try {
      const parsed = JSON.parse(row.findings_json) as unknown;
      if (Array.isArray(parsed)) {
        findings = parsed as readonly ScanFinding[];
      }
    } catch {
      findings = [];
    }
    return {
      packageName: row.package_name,
      version: row.version,
      overallLevel: scoreToLevel(row.overall_score),
      score: row.overall_score,
      findings,
      scannedAt: row.scanned_at,
    };
  }

  /**
   * Upserts a static security report into the `security_reports` table. The
   * findings array is serialized to JSON in the `findings_json` column; the
   * numeric score is stored in `overall_score`. The row is keyed by
   * `(package_name, version, scan_type)` via the table's UNIQUE constraint.
   *
   * @param report - The static scan report to persist.
   */
  async setSecurityReport(report: StaticScanReport): Promise<void> {
    const findingsJson = JSON.stringify(report.findings);
    this.db
      .prepare<[string, string, number, string, string]>(
        `INSERT INTO security_reports (package_name, version, scan_type, overall_score, findings_json, summary, scanned_at)
         VALUES (?, ?, 'static', ?, ?, '', ?)
         ON CONFLICT(package_name, version, scan_type) DO UPDATE SET
           overall_score = excluded.overall_score,
           findings_json  = excluded.findings_json,
           scanned_at     = excluded.scanned_at`,
      )
      .run(
        report.packageName,
        report.version,
        report.score,
        findingsJson,
        report.scannedAt,
      );
  }

  async getLlmScanReport(pkg: string, version: string): Promise<LlmScanReport | null> {
    const row = this.db
      .prepare<[string, string]>(
        "SELECT findings_json, summary, scanned_at FROM security_reports WHERE package_name = ? AND version = ? AND scan_type = 'llm'",
      )
      .get(pkg, version) as Pick<SecurityReportRow, "findings_json" | "summary" | "scanned_at"> | undefined;
    if (!row) return null;
    let findings: readonly ScanFinding[] = [];
    try {
      const parsed = JSON.parse(row.findings_json) as unknown;
      if (Array.isArray(parsed)) findings = parsed as readonly ScanFinding[];
    } catch {
      findings = [];
    }
    let details: {
      enabled?: boolean;
      summary?: string;
      functionalMatch?: boolean;
      suspiciousScore?: number;
      reason?: string;
    } = {};
    try {
      const parsed = JSON.parse(row.summary) as unknown;
      if (parsed && typeof parsed === "object") {
        details = parsed as typeof details;
      }
    } catch {
      details = { reason: row.summary };
    }
    return {
      enabled: details.enabled ?? false,
      reason: details.reason,
      summary: details.summary,
      functionalMatch: details.functionalMatch,
      suspiciousScore: details.suspiciousScore,
      findings,
      scannedAt: row.scanned_at,
    };
  }

  async setLlmScanReport(
    packageName: string,
    version: string,
    report: LlmScanReport,
  ): Promise<void> {
    const summary = JSON.stringify({
      enabled: report.enabled,
      summary: report.summary,
      reason: report.reason,
      functionalMatch: report.functionalMatch,
      suspiciousScore: report.suspiciousScore,
    });
    this.db
      .prepare<[string, string, number, string, string, string]>(
        `INSERT INTO security_reports (package_name, version, scan_type, overall_score, findings_json, summary, scanned_at)
         VALUES (?, ?, 'llm', ?, ?, ?, ?)
         ON CONFLICT(package_name, version, scan_type) DO UPDATE SET
           overall_score = excluded.overall_score,
           findings_json = excluded.findings_json,
           summary = excluded.summary,
           scanned_at = excluded.scanned_at`,
      )
      .run(
        packageName,
        version,
        report.suspiciousScore ?? 0,
        JSON.stringify(report.findings ?? []),
        summary,
        report.scannedAt ?? new Date().toISOString(),
      );
  }

  /**
   * Returns the list of package names currently on the user's watchlist.
   *
   * @returns All watched package names, in insertion order.
   */
  async getWatchlist(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT package_name FROM watchlist ORDER BY added_at ASC")
      .all() as NameRow[];
    return rows.map((r) => r.package_name);
  }

  /**
   * Adds `name` to the watchlist. Idempotent: inserting a name that is
   * already watched is a no-op (INSERT OR IGNORE).
   *
   * @param name - Fully-qualified package name to watch.
   */
  async addToWatchlist(name: string): Promise<void> {
    this.db
      .prepare<[string]>("INSERT OR IGNORE INTO watchlist (package_name) VALUES (?)")
      .run(name);
  }

  /**
   * Removes `name` from the watchlist. No-op if the name was not watched.
   *
   * @param name - Fully-qualified package name to stop watching.
   */
  async removeFromWatchlist(name: string): Promise<void> {
    this.db
      .prepare<[string]>("DELETE FROM watchlist WHERE package_name = ?")
      .run(name);
  }

  /**
   * Returns the value stored under `key` in the settings table, or `null`
   * if the key is unset.
   *
   * @param key - Settings key.
   * @returns The stored value, or `null` if absent.
   */
  async getSetting(key: string): Promise<string | null> {
    const row = this.db
      .prepare<[string]>("SELECT key, value FROM settings WHERE key = ?")
      .get(key) as KeyValueRow | undefined;
    if (row === undefined) return null;
    return row.value;
  }

  /**
   * Upserts `value` under `key` in the settings table (INSERT OR REPLACE).
   *
   * @param key - Settings key.
   * @param value - Settings value to persist.
   */
  async setSetting(key: string, value: string): Promise<void> {
    this.db
      .prepare<[string, string]>(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      )
      .run(key, value);
  }

  /**
   * Returns the names of all cached package rows whose TTL has elapsed
   * (`ttl_until < now`). These are candidates for an incremental refresh by
   * the refresh-scheduler.
   *
   * @returns Package names with expired cache entries.
   */
  async getStalePackages(): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT name FROM packages WHERE ttl_until < strftime('%Y-%m-%d %H:%M:%f', 'now')")
      .all() as ReadonlyArray<{ readonly name: string }>;
    return rows.map((r) => r.name);
  }
}