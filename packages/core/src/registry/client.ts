/**
 * HTTP client for the npm registry API v2.
 *
 * This module provides {@link NpmRegistryClient}, a thin wrapper around the
 * global `fetch` (available in Node 18+) that adds:
 *
 * - **Timeout**: each request is aborted after 10 seconds via an
 *   `AbortController`.
 * - **Retry with exponential backoff**: failed requests (network errors or
 *   non-2xx responses) are retried up to 3 times with delays of 1s, 2s, and
 *   4s between attempts.
 * - **Compression**: the `Accept-Encoding` header advertises gzip and
 *   deflate support.
 * - **User-Agent**: a customisable UA header is sent on every request.
 * - **Typed errors**: non-success responses and unrecoverable failures are
 *   surfaced as {@link NpmRegistryError} carrying the HTTP status code and
 *   status text.
 *
 * The client intentionally contains **no caching** and **no rate limiting**
 * — those concerns are delegated to dedicated modules layered on top.
 *
 * @module registry/client
 */

import type {
  AbbreviatedVersion,
  PackageMetadata,
  SearchResult,
} from './types.js';
import { NpmRegistryError } from './types.js';
import { ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';

/**
 * Default registry base URL used when no `baseUrl` is supplied to the
 * constructor.
 */
const DEFAULT_BASE_URL = 'https://registry.npmjs.org';

/**
 * Default User-Agent string sent when no `userAgent` is supplied. Includes
 * the package name and a Node version hint so the registry can identify the
 * client.
 */
const DEFAULT_USER_AGENT = '@npm-safe/core (https://npmjs.org)';

/**
 * Per-request timeout in milliseconds. Each fetch attempt is aborted if it
 * does not complete within this window.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Number of attempts made before giving up. The first attempt plus
 * {@link RETRY_BACKOFF_MS}.length - 1 retries equals this value.
 */
const MAX_ATTEMPTS = 3;

/**
 * Exponential backoff delays (in milliseconds) applied between retry
 * attempts. The first attempt is immediate; subsequent attempts wait for the
 * corresponding entry in this array before retrying.
 */
const RETRY_BACKOFF_MS: ReadonlyArray<number> = [1_000, 2_000, 4_000];

/**
 * Resolve a proxy URL from the environment. Conventional proxy variables
 * are checked in a case-insensitive manner. Returns `undefined` when no
 * proxy is configured.
 */
function envProxyUrl(): string | undefined {
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

/**
 * Parse the `NO_PROXY` environment variable into a set of lowercased
 * hostnames (and optional `*` wildcard). Empty entries are ignored.
 */
function parseNoProxy(): ReadonlySet<string> {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * Determine whether a hostname should bypass the configured proxy per the
 * `NO_PROXY` list. Exact matches, suffix matches (`.example.com` covers
 * `api.example.com`), and the `*` wildcard all bypass.
 */
function isNoProxyHost(host: string, noProxy: ReadonlySet<string>): boolean {
  if (noProxy.has('*')) return true;
  for (const entry of noProxy) {
    const normalized = entry.startsWith('.') ? entry.slice(1) : entry;
    if (host === normalized) return true;
    if (host.endsWith(`.${normalized}`)) return true;
  }
  return false;
}

/**
 * Shape of the raw JSON returned by the registry's `GET /-/v1/search`
 * endpoint. The top-level `objects` array contains one entry per hit; each
 * hit has a `package` document, a `score` breakdown, and an internal
 * `searchScore`.
 */
interface SearchResponse {
  readonly objects: ReadonlyArray<{
    readonly package: SearchResult['package'];
    readonly score: SearchResult['score'];
    readonly searchScore?: number;
  }>;
}

/**
 * Sleep for the given number of milliseconds. Resolves once the timer
 * elapses; never rejects.
 *
 * @param ms - Duration to sleep in milliseconds.
 * @returns A promise that resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP client for the npm registry.
 *
 * Construct an instance once and reuse it across calls — the client holds no
 * per-request mutable state beyond the configured base URL and User-Agent.
 * All public methods are async and return parsed, typed JSON payloads.
 *
 * @example
 * ```ts
 * const client = new NpmRegistryClient();
 * const meta = await client.getPackageMetadata('lodash');
 * const manifest = await client.getVersionManifest('lodash', '4.17.21');
 * const hits = await client.searchPackages('security', 10);
 * ```
 */
export class NpmRegistryClient {
  /** Base URL (no trailing slash) prepended to every request path. */
  private readonly baseUrl: string;
  /** User-Agent header value sent on every request. */
  private readonly userAgent: string;
  /** Explicit proxy URL from constructor options (highest priority). */
  private readonly proxyUrl?: string;
  /** Proxy dispatchers keyed by proxy URL, lazily created. */
  private readonly proxyAgents = new Map<string, Dispatcher>();
  /** Hosts that must bypass the proxy. */
  private readonly noProxyHosts: ReadonlySet<string>;

  /**
   * @param options - Optional configuration overriding the defaults.
   * @param options.baseUrl - Registry base URL. Defaults to
   *   `https://registry.npmjs.org`. A trailing slash is stripped.
   * @param options.userAgent - User-Agent header value. Defaults to a
   *   string identifying `@npm-safe/core`.
   * @param options.proxy - Proxy URL (e.g. `http://127.0.0.1:7897`). When
   *   omitted, the conventional environment variables are consulted.
   */
  constructor(options?: {
    readonly baseUrl?: string;
    readonly userAgent?: string;
    readonly proxy?: string;
  }) {
    const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
    // Strip a single trailing slash so callers may pass either form.
    this.baseUrl =
      baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.userAgent = options?.userAgent ?? DEFAULT_USER_AGENT;
    this.proxyUrl = options?.proxy ?? envProxyUrl();
    this.noProxyHosts = parseNoProxy();
  }

  /**
   * Resolve the fetch `dispatcher` to use for a request URL.
   *
   * Returns `undefined` when no proxy is configured or the hostname is in
   * the `NO_PROXY` list; otherwise returns a lazily created
   * {@link Dispatcher} for the active proxy.
   *
   * @param url - Fully-qualified request URL.
   * @returns A proxy dispatcher, or `undefined` to use the default fetch.
   */
  private getDispatcher(url: string): Dispatcher | undefined {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    if (isNoProxyHost(host, this.noProxyHosts)) return undefined;
    const proxy = this.proxyUrl;
    if (!proxy) return undefined;

    let agent = this.proxyAgents.get(proxy);
    if (!agent) {
      agent = new ProxyAgent(proxy);
      this.proxyAgents.set(proxy, agent);
    }
    return agent;
  }

  /**
   * Fetch the full packument (metadata) for a package.
   *
   * Issues `GET {baseUrl}/{name}` and returns the parsed
   * {@link PackageMetadata} document, which includes all published versions,
   * dist-tags, and the readme.
   *
   * @param name - Package name (scoped names include the leading `@`).
   * @returns The full package metadata document.
   * @throws {NpmRegistryError} When the request fails after all retries or
   *   the registry returns a non-2xx status.
   */
  async getPackageMetadata(name: string): Promise<PackageMetadata> {
    return this.request<PackageMetadata>(`${this.baseUrl}/${encodeName(name)}`);
  }

  /**
   * Fetch the abbreviated packument for a single published version.
   *
   * Issues `GET {baseUrl}/{name}/{version}` and returns the parsed
   * {@link AbbreviatedVersion} manifest.
   *
   * @param name - Package name (scoped names include the leading `@`).
   * @param version - Semver version string (e.g. `4.17.21`).
   * @returns The abbreviated version manifest.
   * @throws {NpmRegistryError} When the request fails after all retries or
   *   the registry returns a non-2xx status.
   */
  async getVersionManifest(
    name: string,
    version: string,
  ): Promise<AbbreviatedVersion> {
    return this.request<AbbreviatedVersion>(
      `${this.baseUrl}/${encodeName(name)}/${encodeURIComponent(version)}`,
    );
  }

  /**
   * Search the registry for packages matching a text query.
   *
   * Issues `GET {baseUrl}/-/v1/search?text={query}&size={size}` and returns
   * the array of {@link SearchResult} hits. The `size` parameter caps the
   * number of results (the registry imposes its own upper bound).
   *
   * @param query - Free-text search query.
   * @param size - Maximum number of results to return. Defaults to 20.
   * @returns An array of search-result hits, ordered by relevance.
   * @throws {NpmRegistryError} When the request fails after all retries or
   *   the registry returns a non-2xx status.
   */
  async searchPackages(
    query: string,
    size: number = 20,
  ): Promise<SearchResult[]> {
    const url = `${this.baseUrl}/-/v1/search?text=${encodeURIComponent(
      query,
    )}&size=${encodeURIComponent(String(size))}`;
    const body = await this.request<SearchResponse>(url);
    // Normalise the raw response into the public SearchResult shape. The
    // registry omits `searchScore` on some responses, so default to the
    // final score when absent.
    return body.objects.map((hit) => ({
      package: hit.package,
      score: hit.score,
      searchScore: hit.searchScore ?? hit.score.final,
    }));
  }

  /**
   * Perform a single HTTP GET against `url` with timeout and retry.
   *
   * The request is retried up to {@link MAX_ATTEMPTS} times with exponential
   * backoff (1s, 2s, 4s). A retry is attempted when:
   *
   * - The fetch rejects (network error, DNS failure, abort due to timeout).
   * - The response status is not in the 2xx range.
   *
   * On the final attempt the underlying error (or a new
   * {@link NpmRegistryError} for non-2xx responses) is rethrown.
   *
   * @typeParam T - Expected shape of the parsed JSON response.
   * @param url - Fully-qualified URL to fetch.
   * @returns The parsed JSON response body typed as `T`.
   * @throws {NpmRegistryError} When all attempts are exhausted or the
   *   registry returns a non-2xx status on the final attempt.
   */
  private async request<T>(url: string): Promise<T> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Back off before every retry (skip on the first attempt).
      if (attempt > 1) {
        await sleep(RETRY_BACKOFF_MS[attempt - 2]!);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      try {
        const dispatcher = this.getDispatcher(url);
        const init: RequestInit = {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            'User-Agent': this.userAgent,
          },
          signal: controller.signal,
        };
        if (dispatcher) {
          // undici's fetch accepts a `dispatcher` option to route the request
          // through a custom agent (e.g. a proxy).
          (init as { dispatcher?: Dispatcher }).dispatcher = dispatcher;
        }

        const response = await fetch(url, init);

        if (!response.ok) {
          const statusText = response.statusText;
          const message = `Registry request to ${url} failed: ${response.status} ${statusText}`;
          const error = new NpmRegistryError(
            message,
            response.status,
            statusText,
          );
          lastError = error;
          // Non-2xx is retryable: continue to the next attempt.
          continue;
        }

        return (await response.json()) as T;
      } catch (error) {
        // An abort triggered by our own timeout is surfaced as an
        // NpmRegistryError so callers see a consistent error type.
        if (error instanceof Error && error.name === 'AbortError') {
          lastError = new NpmRegistryError(
            `Registry request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms.`,
          );
        } else {
          lastError = error;
        }
        // Network/parse errors are retryable: continue to the next attempt.
        continue;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // All attempts exhausted. Rethrow the last captured error, wrapping
    // non-NpmRegistryError values so callers always see a typed error.
    if (lastError instanceof NpmRegistryError) {
      throw lastError;
    }
    if (lastError instanceof Error) {
      throw new NpmRegistryError(
        `Registry request to ${url} failed after ${MAX_ATTEMPTS} attempts: ${lastError.message}`,
      );
    }
    throw new NpmRegistryError(
      `Registry request to ${url} failed after ${MAX_ATTEMPTS} attempts.`,
    );
  }
}

/**
 * Percent-encode a package name for use in a registry URL path segment.
 *
 * Scoped names (`@scope/name`) are encoded so the embedded `/` becomes
 * `%2F`, producing a single path segment. The npm registry accepts both the
 * raw and percent-encoded forms; the encoded form is used here to avoid any
 * ambiguity with path separators.
 *
 * @param name - Package name (scoped names include the leading `@`).
 * @returns The percent-encoded name safe for use in a URL path.
 */
function encodeName(name: string): string {
  return encodeURIComponent(name);
}