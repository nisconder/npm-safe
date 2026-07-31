/**
 * Unified composition layer for @npm-safe/core.
 *
 * {@link NpmSafeEngine} combines the database, cache, registry client, rate
 * limiter, static analyzer, and refresh scheduler into a single facade that
 * exposes the full public API of the engine.
 *
 * @module index
 */

import { DatabaseManager } from './store/database.js';
import { CacheManager } from './store/cache-manager.js';
import { NpmRegistryClient } from './registry/client.js';
import { NpmRegistryError } from './registry/types.js';
import type { PackageMetadata, PackageRepository, SearchResult } from './registry/types.js';
import { TokenBucket } from './scheduler/rate-limiter.js';
import { StaticAnalyzer } from './scanner/static-rules.js';
import { RefreshScheduler } from './scheduler/refresh-scheduler.js';
import { SecurityLevel } from './scanner/types.js';
import type { StaticScanReport } from './scanner/types.js';

// ============================================================================
// Exported types
// ============================================================================

/**
 * Options accepted by the {@link NpmSafeEngine} constructor.
 */
export interface NpmSafeEngineOptions {
  /**
   * Filesystem path to the SQLite database file.
   * @default './npm-safe.db'
   */
  readonly dbPath?: string;

  /**
   * Base URL of the npm registry.
   * @default 'https://registry.npmjs.org'
   */
  readonly registryUrl?: string;

  /**
   * Token bucket refill rate (tokens per second).
   * @default 5
   */
  readonly rateLimit?: number;

  /**
   * Maximum burst size for the token bucket.
   * @default 10
   */
  readonly rateLimitBurst?: number;

  /**
   * Cache TTL for package metadata in milliseconds.
   * @default 3600000 (1 hour)
   */
  readonly cacheTtlMs?: number;

  /**
   * HTTP proxy URL used for registry requests (e.g.
   * `http://127.0.0.1:7897`). When omitted, the conventional environment
   * variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`) are consulted.
   */
  readonly proxy?: string;
}

/**
 * Result of a {@link NpmSafeEngine.checkPackage} call.
 */
export interface CheckResult {
  /** Name of the checked package. */
  readonly packageName: string;

  /** Whether the package exists on the registry. */
  readonly exists: boolean;

  /** The latest available version, or an empty string when `exists` is `false`. */
  readonly latestVersion: string;

  /** Security assessment of the package. */
  readonly security: {
    /** Overall security level derived from the combined scan. */
    readonly overallLevel: SecurityLevel;
    /** Numeric security score (0–100, higher is safer). */
    readonly overallScore: number;
    /** Full static scan report, or `null` if one is not available. */
    readonly staticScan: StaticScanReport | null;
  };

  /**
   * Basic registry metadata, or `null` when the package does not exist.
   */
  readonly registryInfo: {
    /** Human-readable description of the package. */
    readonly description: string;
    /** URL to the package's homepage. */
    readonly homepage: string;
    /** Repository descriptor as a string (e.g. `"github:user/repo"`). */
    readonly repository: string;
  } | null;

  /**
   * ISO-8601 timestamp of when this result was last cached, or `null` when
   * the exact cached-at time is not known (e.g. served from an earlier cache
   * hit whose timestamp was not recorded).
   */
  readonly cachedAt: string | null;
}

// ============================================================================
// Engine
// ============================================================================

/**
 * Unified facade that composes every @npm-safe/core module into a single
 * public API surface.
 *
 * Construct an instance with optional {@link NpmSafeEngineOptions}, then use
 * its methods to check, search, watch, refresh, and configure npm packages.
 *
 * @example
 * ```ts
 * const engine = new NpmSafeEngine({ dbPath: './my-cache.db' });
 * const result = await engine.checkPackage('lodash');
 * console.log(result.security.overallLevel);
 * await engine.close();
 * ```
 */
export class NpmSafeEngine {
  /** Database connection manager. */
  private readonly database: DatabaseManager;
  /** Cache read/write layer. */
  private readonly cache: CacheManager;
  /** HTTP client for the npm registry. */
  private readonly client: NpmRegistryClient;
  /** Token bucket rate limiter. */
  private readonly limiter: TokenBucket;
  /** Static analysis engine. */
  private readonly analyzer: StaticAnalyzer;
  /** Auto-refresh scheduler. */
  private readonly scheduler: RefreshScheduler;

  /**
   * @param options - Optional configuration overrides; see
   *   {@link NpmSafeEngineOptions} for available options.
   */
  constructor(options?: NpmSafeEngineOptions) {
    this.database = new DatabaseManager(options?.dbPath ?? './npm-safe.db');
    this.cache = new CacheManager(this.database, {
      cacheTtlMs: options?.cacheTtlMs,
    });
    this.client = new NpmRegistryClient({
      baseUrl: options?.registryUrl,
      proxy: options?.proxy,
    });
    this.limiter = new TokenBucket(
      options?.rateLimit ?? 5,
      options?.rateLimitBurst ?? 10,
    );
    this.analyzer = new StaticAnalyzer();
    this.scheduler = new RefreshScheduler(
      this.client,
      this.cache,
      this.limiter,
      this.analyzer,
    );
  }

  // --------------------------------------------------------------------------
  // Package checking & searching
  // --------------------------------------------------------------------------

  /**
   * Check a package by name, returning cached data if still fresh, or fetching
   * from the registry, running static analysis, and caching the result.
   *
   * When the package does not exist on the registry (HTTP 404) the returned
   * {@link CheckResult.exists} is `false` and the security / registry info
   * fields are empty. All other errors (network failure, timeout, …) are
   * rethrown so the caller can handle them appropriately.
   *
   * @param name - Fully-qualified package name (scope included when scoped).
   * @returns A promise that resolves to the check result.
   */
  async checkPackage(name: string): Promise<CheckResult> {
    // 1. Try the cache first.
    const cached = await this.cache.getPackage(name);
    if (cached !== null) {
      const latestVersion = cached['dist-tags'].latest;
      const staticScan = await this.cache.getSecurityReport(
        name,
        latestVersion,
      );

      return this.buildCheckResult(
        name,
        true,
        latestVersion,
        staticScan ?? null,
        {
          description: cached.description ?? '',
          homepage: cached.homepage ?? '',
          repository: repositoryToString(cached.repository),
        },
        null, // cachedAt unknown when serving from cache
      );
    }

    // 2. Cache miss or stale — fetch from the registry.
    try {
      const meta = await this.client.getPackageMetadata(name);
      const latestVersion = meta['dist-tags'].latest;

      // Persist the fresh metadata before running analysis so the cache is
      // updated even if analysis fails downstream.
      await this.cache.setPackage(meta);

      // Derive a package.json-like object from the latest version manifest
      // for the static analyzer. The spread + double-cast is needed because
      // AbbreviatedVersion is a readonly interface, not a plain object.
      const manifest = meta.versions[latestVersion];
      const packageJson: Record<string, unknown> | undefined = manifest
        ? ({ ...manifest } as unknown as Record<string, unknown>)
        : undefined;

      const readme = meta.readme ?? '';
      const report = this.analyzer.analyze(readme, packageJson);

      await this.cache.setSecurityReport(report);

      return this.buildCheckResult(
        name,
        true,
        latestVersion,
        report,
        {
          description: meta.description ?? '',
          homepage: meta.homepage ?? '',
          repository: repositoryToString(meta.repository),
        },
        new Date().toISOString(),
      );
    } catch (err) {
      // A 404 from the registry means the package simply does not exist —
      // return a graceful "not found" result instead of throwing.
      if (err instanceof NpmRegistryError && err.statusCode === 404) {
        return this.buildCheckResult(
          name,
          false,
          '',
          null,
          null,
          null,
        );
      }
      throw err;
    }
  }

  /**
   * Search the npm registry for packages matching a text query.
   *
   * @param query - Free-text search query.
   * @param size - Maximum number of results to return. Defaults to `20`.
   * @returns An array of search-result hits, ordered by relevance.
   */
  async searchPackages(query: string, size?: number): Promise<SearchResult[]> {
    return this.client.searchPackages(query, size);
  }

  // --------------------------------------------------------------------------
  // Watchlist
  // --------------------------------------------------------------------------

  /**
   * Returns the list of package names currently on the watchlist.
   *
   * @returns All watched package names, in insertion order.
   */
  async getWatchlist(): Promise<string[]> {
    return this.cache.getWatchlist();
  }

  /**
   * Add a package to the watchlist. Idempotent — adding a name that is already
   * watched is a no-op.
   *
   * @param name - Fully-qualified package name to watch.
   */
  async addToWatchlist(name: string): Promise<void> {
    return this.cache.addToWatchlist(name);
  }

  /**
   * Remove a package from the watchlist. No-op if the name was not watched.
   *
   * @param name - Fully-qualified package name to stop watching.
   */
  async removeFromWatchlist(name: string): Promise<void> {
    return this.cache.removeFromWatchlist(name);
  }

  // --------------------------------------------------------------------------
  // Refresh
  // --------------------------------------------------------------------------

  /**
   * Refresh a single package: fetch its latest metadata from the registry,
   * re-run static analysis, and persist the results.
   *
   * Per-package failures are surfaced via the scheduler's `refresh:error`
   * event rather than thrown — the returned promise resolves after emitting
   * the error so a failing package does not abort a batch.
   *
   * @param name - Fully-qualified package name to refresh.
   */
  async refreshPackage(name: string): Promise<void> {
    return this.scheduler.refreshPackage(name);
  }

  /**
   * Refresh every package whose cached metadata has passed its TTL.
   *
   * Packages are processed sequentially so the rate limiter is respected.
   */
  async refreshAll(): Promise<void> {
    return this.scheduler.refreshAll();
  }

  // --------------------------------------------------------------------------
  // Settings
  // --------------------------------------------------------------------------

  /**
   * Retrieve a setting value by key.
   *
   * @param key - Settings key.
   * @returns The stored value, or `null` if the key is unset.
   */
  async getSetting(key: string): Promise<string | null> {
    return this.cache.getSetting(key);
  }

  /**
   * Upsert a setting value by key.
   *
   * @param key - Settings key.
   * @param value - Value to persist.
   */
  async setSetting(key: string, value: string): Promise<void> {
    return this.cache.setSetting(key, value);
  }

  // --------------------------------------------------------------------------
  // Auto-refresh lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start the periodic auto-refresh loop.
   *
   * The first refresh cycle kicks off immediately in the background; subsequent
   * cycles repeat at `intervalMs`. Safe to call multiple times — calling while
   * already running resets the interval.
   *
   * @param intervalMs - Milliseconds between refresh cycles.
   *   Defaults to 1 hour.
   */
  startAutoRefresh(intervalMs?: number): void {
    this.scheduler.start(intervalMs);
  }

  /**
   * Stop the periodic auto-refresh loop.
   *
   * Safe to call when the scheduler is not running. Any in-flight refresh
   * continues to completion.
   */
  stopAutoRefresh(): void {
    this.scheduler.stop();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Release all resources held by the engine.
   *
   * Stops the auto-refresh scheduler, disposes the rate-limiter timer, and
   * closes the database connection. After calling this method the engine
   * instance must not be used for further operations.
   */
  close(): void {
    this.scheduler.stop();
    this.limiter.dispose();
    this.database.close();
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /**
   * Assemble a {@link CheckResult} from its constituent parts.
   */
  private buildCheckResult(
    packageName: string,
    exists: boolean,
    latestVersion: string,
    staticScan: StaticScanReport | null,
    registryInfo: {
      description: string;
      homepage: string;
      repository: string;
    } | null,
    cachedAt: string | null,
  ): CheckResult {
    return {
      packageName,
      exists,
      latestVersion,
      security: {
        overallLevel: staticScan?.overallLevel ?? SecurityLevel.Unknown,
        overallScore: staticScan?.score ?? 0,
        staticScan,
      },
      registryInfo,
      cachedAt,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize a {@link PackageRepository} value to a plain string.
 *
 * Structured descriptors are rendered as `"type:url"`; shorthand strings are
 * returned verbatim; `undefined` produces an empty string.
 *
 * @param repo - Repository descriptor from registry metadata.
 * @returns A string representation suitable for display.
 */
function repositoryToString(repo: PackageRepository | undefined): string {
  if (repo === undefined) return '';
  if (typeof repo === 'string') return repo;
  return `${repo.type}:${repo.url}`;
}
