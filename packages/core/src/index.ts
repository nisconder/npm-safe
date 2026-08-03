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
import { StaticAnalyzer, type RuleDescriptor } from './scanner/static-rules.js';
import type { ScanRule } from './scanner/types.js';
import { RefreshScheduler } from './scheduler/refresh-scheduler.js';
import { SecurityLevel, Severity } from './scanner/types.js';
import type { StaticScanReport } from './scanner/types.js';
import type { LlmScanReport } from './scanner/types.js';
import { RuleConfigManager } from './scanner/rule-config.js';
import { loadRulesFromDirectory } from './scanner/rule-loader.js';
import { createLlmProvider } from './llm/provider.js';
import type { LlmProviderOptions, LlmScanProvider } from './llm/provider.js';
import { LlmConfigManager } from './llm/llm-config.js';
import type { LlmConfig, LlmStatus } from './llm/llm-config.js';

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

  /** Optional LLM security scanner configuration (OpenAI / Gemini / Anthropic). */
  readonly llm?: LlmProviderOptions;

  /**
   * Path to the LLM provider configuration JSON file.
   * @default '~/.npm-safe/llm.json'
   */
  readonly llmConfigPath?: string;

  /**
   * Path to the per-rule configuration JSON file.
   * @default '~/.npm-safe/rules.json'
   */
  readonly rulesConfigPath?: string;

  /**
   * Directory scanned for third-party rule plugin files (`*.mjs` / `*.js`).
   * @default '~/.npm-safe/rules/'
   */
  readonly rulesDir?: string;
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
    /** Optional semantic analysis from the configured LLM provider. */
    readonly llmScan?: LlmScanReport;
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

/**
 * Options accepted by {@link NpmSafeEngine.checkPackages}.
 */
export interface BatchCheckOptions {
  /**
   * Maximum number of concurrent checks. Every check still consumes one
   * token from the rate limiter.
   * @default 5
   */
  readonly concurrency?: number;

  /**
   * Progress callback invoked after each package completes. `done` counts
   * completed packages (both successes and failures); `total` is the input
   * length.
   */
  readonly onProgress?: (
    done: number,
    total: number,
    entry: BatchPackageResult,
  ) => void;
}

/**
 * One entry of the result array returned by
 * {@link NpmSafeEngine.checkPackages}, in input order.
 */
export interface BatchPackageResult {
  /** Input package name. */
  readonly name: string;
  /** Whether the check succeeded. */
  readonly ok: boolean;
  /** The check result when `ok` is `true`. */
  readonly result?: CheckResult;
  /** Error message when `ok` is `false`. */
  readonly error?: string;
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
  /** Per-rule configuration (enabled / severity / options). */
  private readonly ruleConfig: RuleConfigManager;
  /** Auto-refresh scheduler. */
  private readonly scheduler: RefreshScheduler;
  /** LLM provider configuration manager. */
  private readonly llmConfig: LlmConfigManager;
  /** Optional semantic security scanner. */
  private llmProvider?: LlmScanProvider;

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
    this.ruleConfig = new RuleConfigManager(options?.rulesConfigPath);
    this.analyzer = new StaticAnalyzer(undefined, this.ruleConfig);
    this.llmConfig = new LlmConfigManager(options?.llmConfigPath);
    this.llmProvider = options?.llm
      ? createLlmProvider(options.llm)
      : this.llmConfig.createProvider();
    this.scheduler = new RefreshScheduler(
      this.client,
      this.cache,
      this.limiter,
      this.analyzer,
      () => this.llmProvider,
    );
    void this.loadRulePlugins(options?.rulesDir);
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
      const llmScan = this.llmProvider
        ? (await this.cache.getLlmScanReport(name, latestVersion)) ??
          await this.scanWithLlm(cached, latestVersion)
        : undefined;

      return this.buildCheckResult(
        name,
        true,
        latestVersion,
        staticScan ?? null,
        llmScan,
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
      const llmScan = this.llmProvider
        ? await this.scanWithLlm(meta, latestVersion)
        : undefined;

      return this.buildCheckResult(
        name,
        true,
        latestVersion,
        report,
        llmScan,
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
          undefined,
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

  /**
   * Check many packages in parallel with a shared concurrency cap.
   *
   * Every check consumes one token from the rate limiter, so the batch
   * respects the configured request budget even when running concurrently.
   * Individual failures are isolated: a package that throws (network error,
   * timeout, …) yields a `{ ok: false, error }` entry instead of rejecting
   * the whole batch. Use `checkPackage` when the raw error must propagate.
   *
   * @param names - Package names to check.
   * @param options - Batch options (concurrency, progress callback).
   * @returns One entry per input name, in input order.
   */
  async checkPackages(
    names: readonly string[],
    options?: BatchCheckOptions,
  ): Promise<BatchPackageResult[]> {
    const concurrency = Math.max(
      1,
      Math.min(options?.concurrency ?? 5, names.length || 1),
    );
    const results: BatchPackageResult[] = new Array(names.length);
    let next = 0;
    let done = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= names.length) return;
        const name = names[index];
        try {
          await this.limiter.consume(1);
          const result = await this.checkPackage(name);
          const entry: BatchPackageResult = { name, ok: true, result };
          results[index] = entry;
          done++;
          options?.onProgress?.(done, names.length, entry);
        } catch (error) {
          const entry: BatchPackageResult = {
            name,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
          results[index] = entry;
          done++;
          options?.onProgress?.(done, names.length, entry);
        }
      }
    };

    await Promise.all(
      Array.from({ length: concurrency }, () => worker()),
    );
    return results;
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
   * event and represented by a `false` result rather than thrown, so a
   * failing package does not abort a batch.
   *
   * @param name - Fully-qualified package name to refresh.
   */
  async refreshPackage(name: string): Promise<boolean> {
    return this.scheduler.refreshPackage(name);
  }

  /**
   * Refresh every package whose cached metadata has passed its TTL.
   *
   * Packages are processed sequentially so the rate limiter is respected.
   */
  async refreshAll(): Promise<boolean> {
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
  // Check history
  // --------------------------------------------------------------------------

  /**
   * Record a check into the persistent history database. Used by the CLI and
   * the desktop extension so history is shared across both frontends.
   *
   * @param result - A check result for an existing package.
   */
  async recordCheckHistory(result: CheckResult): Promise<void> {
    if (!result.exists) return;
    await this.recordHistoryEntry({
      packageName: result.packageName,
      level: result.security.overallLevel,
      score: result.security.overallScore,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Append a raw history entry (newest-first, capped at 1000).
   */
  async recordHistoryEntry(entry: {
    readonly packageName: string;
    readonly level: string;
    readonly score: number;
    readonly timestamp: string;
  }): Promise<void> {
    await this.cache.addHistoryEntry(entry);
  }

  /**
   * Return the persistent check history, newest first (capped at 1000).
   */
  async getCheckHistory(limit?: number): Promise<
    ReadonlyArray<{
      readonly packageName: string;
      readonly level: string;
      readonly score: number;
      readonly timestamp: string;
    }>
  > {
    return this.cache.getHistory(limit);
  }

  /**
   * Clear the persistent check history.
   */
  async clearCheckHistory(): Promise<void> {
    return this.cache.clearHistory();
  }

  // --------------------------------------------------------------------------
  // Rule plugin management
  // --------------------------------------------------------------------------

  /**
   * Register a scan rule at runtime. A rule with the same id replaces the
   * existing one.
   *
   * @param rule - The rule to register.
   */
  registerRule(rule: ScanRule): void {
    this.analyzer.registerRule(rule);
  }

  /**
   * Remove a scan rule by id.
   *
   * @param ruleId - Id of the rule to remove.
   * @returns `true` if a rule was removed, `false` if no such rule exists.
   */
  unregisterRule(ruleId: string): boolean {
    return this.analyzer.unregisterRule(ruleId);
  }

  /**
   * Describe every registered rule with its effective status.
   *
   * @returns Rule descriptors in registration order.
   */
  listRules(): RuleDescriptor[] {
    return this.analyzer.listRules();
  }

  /**
   * Enable or disable a rule (persisted in the rules config file).
   *
   * @param ruleId - Id of the rule.
   * @param enabled - Whether the rule should run.
   */
  setRuleEnabled(ruleId: string, enabled: boolean): void {
    this.ruleConfig.setEnabled(ruleId, enabled);
  }

  /**
   * Override a rule's severity (persisted). Pass `undefined` to clear the
   * override and return to the rule's default severity.
   *
   * @param ruleId - Id of the rule.
   * @param severity - Severity override, or `undefined` to clear.
   */
  setRuleSeverity(ruleId: string, severity: Severity | undefined): void {
    this.ruleConfig.setSeverity(ruleId, severity);
  }

  /**
   * Set free-form options for a rule (persisted). Rule implementations can
   * read these via the rule config manager.
   *
   * @param ruleId - Id of the rule.
   * @param options - Free-form options.
   */
  setRuleOptions(ruleId: string, options: Readonly<Record<string, unknown>>): void {
    this.ruleConfig.setOptions(ruleId, options);
  }

  /**
   * Access the rule configuration manager for low-level inspection.
   *
   * @returns The rule configuration manager backing this engine.
   */
  getRuleConfig(): RuleConfigManager {
    return this.ruleConfig;
  }

  /**
   * Load third-party rules from a directory of ES module files.
   *
   * Each `*.mjs` / `*.js` file may export a `rule`, `rules`, or `default`
   * binding holding one or more {@link ScanRule}s. Files that fail to load
   * are skipped.
   *
   * @param dir - Directory to scan. Defaults to `~/.npm-safe/rules/`.
   * @returns The number of rules loaded.
   */
  async loadRulePlugins(dir?: string): Promise<number> {
    const results = await loadRulesFromDirectory(dir);
    let count = 0;
    for (const result of results) {
      for (const rule of result.rules) {
        this.analyzer.registerRule(rule);
        count++;
      }
    }
    return count;
  }

  // --------------------------------------------------------------------------
  // LLM configuration
  // --------------------------------------------------------------------------

  /**
   * Get the raw LLM configuration, including the API key.
   *
   * @returns The current persisted LLM config.
   */
  getLlmConfig(): LlmConfig {
    return this.llmConfig.getConfig();
  }

  /**
   * Get a masked, display-safe view of the LLM status.
   *
   * @returns Status object safe to render in a UI.
   */
  getLlmStatus(): LlmStatus {
    return this.llmConfig.getStatus();
  }

  /**
   * Update the LLM configuration and recreate the provider.
   *
   * The change is persisted immediately. If LLM scanning is disabled or no
   * API key is available, the provider is set to `undefined` so the rest of the
   * engine continues unaffected.
   *
   * @param update - Partial config update. Pass `{ enabled: false }` to disable.
   */
  setLlmConfig(update: Partial<LlmConfig>): void {
    this.llmConfig.setConfig(update);
    this.llmProvider = this.llmConfig.createProvider();
    this.scheduler.setLlmProvider(this.llmProvider);
  }

  /**
   * Test whether the current LLM configuration can connect to its provider.
   *
   * @returns `true` if the provider is enabled, configured, and the test call
   *   succeeds; `false` otherwise.
   */
  async testLlmConnection(): Promise<boolean> {
    return this.llmConfig.testConnection();
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
    llmScan: LlmScanReport | undefined,
    registryInfo: {
      description: string;
      homepage: string;
      repository: string;
    } | null,
    cachedAt: string | null,
  ): CheckResult {
    const overallScore = combineScores(staticScan, llmScan);
    return {
      packageName,
      exists,
      latestVersion,
      security: {
        overallLevel: scoreToSecurityLevel(overallScore),
        overallScore,
        staticScan,
        llmScan,
      },
      registryInfo,
      cachedAt,
    };
  }

  private async scanWithLlm(
    meta: PackageMetadata,
    version: string,
  ): Promise<LlmScanReport> {
    if (!this.llmProvider) {
      return { enabled: false, reason: 'LLM provider is not configured.' };
    }
    const manifest = meta.versions[version];
    try {
      const report = await this.llmProvider.scan({
        packageName: meta.name,
        version,
        description: meta.description ?? '',
        readme: meta.readme ?? '',
        packageJson: manifest ? { ...manifest } as Record<string, unknown> : undefined,
      });
      await this.cache.setLlmScanReport(meta.name, version, report);
      return report;
    } catch (error) {
      const report: LlmScanReport = {
        enabled: false,
        reason: error instanceof Error ? error.message : String(error),
        scannedAt: new Date().toISOString(),
      };
      await this.cache.setLlmScanReport(meta.name, version, report);
      return report;
    }
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

function combineScores(
  staticScan: StaticScanReport | null,
  llmScan: LlmScanReport | undefined,
): number {
  if (!staticScan) return 0;
  if (!llmScan?.enabled) return staticScan.score;
  return Math.round(staticScan.score * 0.6 + (100 - (llmScan.suspiciousScore ?? 0)) * 0.4);
}

function scoreToSecurityLevel(score: number): SecurityLevel {
  if (score >= 80) return SecurityLevel.Safe;
  if (score >= 50) return SecurityLevel.Suspicious;
  if (score >= 20) return SecurityLevel.Dangerous;
  return SecurityLevel.Unknown;
}

export { createLlmProvider, LlmProviderError } from './llm/provider.js';
export type {
  LlmProviderOptions,
  LlmScanInput,
  LlmScanProvider,
} from './llm/provider.js';
export { LlmConfigManager, getDefaultLlmConfigPath } from './llm/llm-config.js';
export type { LlmConfig, LlmStatus } from './llm/llm-config.js';
export { RuleConfigManager } from './scanner/rule-config.js';
export type { RuleConfig, RuleConfigFile, RuleOptions } from './scanner/rule-config.js';
export { loadRulesFromDirectory } from './scanner/rule-loader.js';
export type { LoadedRuleFile, RuleModuleExport } from './scanner/rule-loader.js';
export type { RuleDescriptor } from './scanner/static-rules.js';
