/**
 * Auto-refresh scheduler with rate-limited registry polling.
 *
 * {@link RefreshScheduler} orchestrates periodic re-fetching of npm package
 * metadata and re-running the static analyzer for packages on the user's
 * watchlist or with stale cache entries. It is a pure scheduling +
 * orchestration layer: it contains no GUI integration and no CLI command
 * logic. All registry calls are gated through the injected {@link TokenBucket}
 * so the scheduler respects the configured rate limit, and progress is
 * surfaced via three {@link EventEmitter} events:
 *
 * - `refresh:start`    — emitted before each package refresh begins.
 * - `refresh:complete`— emitted after a package refresh succeeds, carrying
 *   the freshly produced {@link StaticScanReport}.
 * - `refresh:error`   — emitted when a package refresh fails. The scheduler
 *   does **not** throw on per-package failures; it emits the error and
 *   continues with the next package.
 *
 * @module scheduler/refresh-scheduler
 */

import { EventEmitter } from 'node:events';

import type { NpmRegistryClient } from '../registry/client.js';
import type { PackageMetadata } from '../registry/types.js';
import type { CacheManager } from '../store/cache-manager.js';
import type { TokenBucket } from './rate-limiter.js';
import type { StaticAnalyzer } from '../scanner/static-rules.js';
import type { StaticScanReport } from '../scanner/types.js';
import type { LlmScanReport } from '../scanner/types.js';
import type { LlmScanProvider } from '../llm/provider.js';

/**
 * Payload of the `refresh:start` event.
 */
export interface RefreshStartPayload {
  /** Name of the package about to be refreshed. */
  readonly packageName: string;
}

/**
 * Payload of the `refresh:complete` event.
 */
export interface RefreshCompletePayload {
  /** Name of the package that was refreshed. */
  readonly packageName: string;
  /** The static scan report produced during the refresh. */
  readonly report: StaticScanReport;
  readonly llmScan?: LlmScanReport;
}

/**
 * Payload of the `refresh:error` event.
 */
export interface RefreshErrorPayload {
  /** Name of the package whose refresh failed. */
  readonly packageName: string;
  /** The error that caused the refresh to fail. */
  readonly error: unknown;
}

/**
 * Default refresh interval: 1 hour in milliseconds.
 */
const DEFAULT_INTERVAL_MS = 3_600_000;

/**
 * Auto-refresh scheduler that periodically polls the npm registry for
 * updated package metadata, re-caches it, and re-runs the static analyzer.
 *
 * The scheduler is constructed with four collaborators:
 *
 * - {@link NpmRegistryClient} — used to fetch fresh packuments.
 * - {@link CacheManager} — used to read the watchlist/stale set and persist
 *   refreshed metadata + security reports.
 * - {@link TokenBucket} — gates every registry call so the configured rate
 *   limit is respected.
 * - {@link StaticAnalyzer} — re-evaluates the refreshed package's README and
 *   latest version manifest.
 *
 * Call {@link RefreshScheduler.start} to begin the refresh loop and
 * {@link RefreshScheduler.stop} to tear it down.
 *
 * @example
 * ```ts
 * const scheduler = new RefreshScheduler(client, cache, limiter, analyzer);
 * scheduler.on('refresh:complete', ({ packageName, report }) => {
 *   console.log(`${packageName}: score=${report.score}`);
 * });
 * scheduler.start(); // refresh hourly
 * // ... later
 * scheduler.stop();
 * ```
 */
export class RefreshScheduler extends EventEmitter {
  /** Registry client used to fetch fresh packuments. */
  private readonly client: NpmRegistryClient;
  /** Cache manager used to read the watchlist and persist results. */
  private readonly cache: CacheManager;
  /** Rate limiter gating every registry call. */
  private readonly limiter: TokenBucket;
  /** Static analyzer re-run on each refreshed package. */
  private readonly analyzer: StaticAnalyzer;
  /** Optional semantic analyzer for refreshed packages (mutable at runtime). */
  private llmProvider: (() => LlmScanProvider | undefined) | undefined;
  /** Handle to the recurring refresh interval, or `null` when stopped. */
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /**
   * @param client - Registry client for fetching package metadata.
   * @param cache - Cache manager for reading the watchlist and persisting
   *   refreshed metadata + reports.
   * @param limiter - Token bucket rate limiter; one token is consumed per
   *   registry fetch.
   * @param analyzer - Static analyzer re-run on each refreshed package.
   * @param llmProvider - Optional semantic analyzer for refreshed packages, or
   *   a getter that returns the current provider. A getter is preferred when the
   *   provider can be changed at runtime.
   */
  constructor(
    client: NpmRegistryClient,
    cache: CacheManager,
    limiter: TokenBucket,
    analyzer: StaticAnalyzer,
    llmProvider?: LlmScanProvider | (() => LlmScanProvider | undefined),
  ) {
    super();
    this.client = client;
    this.cache = cache;
    this.limiter = limiter;
    this.analyzer = analyzer;
    this.llmProvider = llmProvider
      ? typeof llmProvider === 'function'
        ? llmProvider
        : () => llmProvider
      : undefined;
  }

  /**
   * Replace the LLM provider used during refreshes.
   *
   * Safe to call while the scheduler is running; the next refresh cycle uses
   * the new provider.
   *
   * @param provider - The new provider, or `undefined` to disable LLM scanning.
   */
  setLlmProvider(provider?: LlmScanProvider): void {
    this.llmProvider = provider ? () => provider : undefined;
  }

  /** Resolve the current LLM provider. */
  private getLlmProvider(): LlmScanProvider | undefined {
    return this.llmProvider?.();
  }

  /**
   * Start the periodic refresh loop.
   *
   * Immediately kicks off a background {@link RefreshScheduler.refreshWatchlist}
   * call (without awaiting it), then schedules the same call to repeat every
   * `intervalMs` milliseconds. Safe to call multiple times; calling while
   * already running clears the previous interval before starting a new one.
   *
   * @param intervalMs - Milliseconds between refresh cycles. Defaults to
   *   {@link DEFAULT_INTERVAL_MS} (1 hour).
   */
  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    // Avoid double-starting: clear any existing interval first.
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Kick off the first cycle immediately in the background.
    void this.refreshWatchlist();

    this.intervalId = setInterval(() => {
      void this.refreshWatchlist();
    }, intervalMs);
  }

  /**
   * Stop the periodic refresh loop.
   *
   * Clears the recurring interval. Any in-flight refresh that is already
   * executing continues to completion; this method only prevents future
   * cycles from being scheduled. Safe to call when not running.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Refresh a single package: fetch its latest metadata from the registry,
   * persist it to the cache, re-run the static analyzer against the latest
   * version's README and manifest, and persist the resulting report.
   *
   * One token is consumed from the rate limiter before the registry fetch,
   * so concurrent callers are naturally throttled. Per-package failures are
   * surfaced via the `refresh:error` event rather than thrown — the promise
   * resolves normally after emitting the error so a failing package does not
   * abort a batch.
   *
   * @param name - Fully-qualified package name (scope included when scoped).
   * @returns `true` when the refresh succeeds, or `false` after emitting
   *   `refresh:error`. Never rejects for per-package refresh failures.
   */
  async refreshPackage(name: string): Promise<boolean> {
    this.emit('refresh:start', { packageName: name } satisfies RefreshStartPayload);

    try {
      // Gate the registry call through the rate limiter.
      await this.limiter.consume(1);

      const meta: PackageMetadata = await this.client.getPackageMetadata(name);

      // Persist the fresh packument before doing anything else so the
      // cache is updated even if analysis fails downstream.
      await this.cache.setPackage(meta);

      // Derive a package.json-like object from the latest version manifest
      // for the static analyzer. The analyzer reads `name`, `version`,
      // `scripts`, `browser`, and `publishConfig.registry`; the manifest
      // carries `name`/`version`/`scripts` directly, and any extra fields
      // present on the registry payload (e.g. `browser`, `publishConfig`)
      // are passed through via the spread.
      const latestVersion = meta['dist-tags'].latest;
      const manifest = meta.versions[latestVersion];
      const packageJson: Record<string, unknown> | undefined = manifest
        ? ({ ...manifest } as unknown as Record<string, unknown>)
        : undefined;

      const readme = meta.readme ?? '';
      const report = this.analyzer.analyze(readme, packageJson);

      await this.cache.setSecurityReport(report);
      const llmProvider = this.getLlmProvider();
      const llmScan = llmProvider
        ? await this.scanWithLlm(meta, latestVersion)
        : undefined;

      this.emit(
        'refresh:complete',
        { packageName: name, report, llmScan } satisfies RefreshCompletePayload,
      );
      return true;
    } catch (error) {
      // Per-package failures are reported, not thrown, so a batch refresh
      // continues with the remaining packages.
      this.emit(
        'refresh:error',
        { packageName: name, error } satisfies RefreshErrorPayload,
      );
      return false;
    }
  }

  private async scanWithLlm(
  meta: PackageMetadata,
  version: string,
  ): Promise<LlmScanReport> {
  const provider = this.getLlmProvider();
  if (!provider) {
    return { enabled: false, reason: 'LLM provider is not configured.' };
  }
  try {
    const manifest = meta.versions[version];
    const report = await provider.scan({
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

  /**
   * Refresh every package whose cached metadata has passed its TTL.
   *
   * Packages are processed sequentially (one after another) so the rate
   * limiter is respected and the registry is not hammered in bursts. Each
   * package's outcome is surfaced via the `refresh:complete` / `refresh:error`
   * events emitted by {@link RefreshScheduler.refreshPackage}.
   *
   * @returns `true` when every stale package refresh succeeds, otherwise
   *   `false` after all stale packages have been attempted.
   */
  async refreshAll(): Promise<boolean> {
    const stale = await this.cache.getStalePackages();
    let allSucceeded = true;
    for (const name of stale) {
      const succeeded = await this.refreshPackage(name);
      allSucceeded = allSucceeded && succeeded;
    }
    return allSucceeded;
  }

  /**
   * Refresh every package on the user's watchlist.
   *
   * Watched packages are processed sequentially so the rate limiter is
   * respected. Each package's outcome is surfaced via the
   * `refresh:complete` / `refresh:error` events emitted by
   * {@link RefreshScheduler.refreshPackage}.
   *
   * @returns Resolves once all watched packages have been attempted.
   */
  private async refreshWatchlist(): Promise<void> {
    const watchlist = await this.cache.getWatchlist();
    for (const name of watchlist) {
      await this.refreshPackage(name);
    }
  }
}