/**
 * Optional usage telemetry for @npm-safe/core.
 *
 * Telemetry is opt-in (disabled by default). When enabled, command runs and
 * scan outcomes are aggregated into `~/.npm-safe/telemetry.json`:
 * counters per event type, security-level distribution, error counts, and a
 * rolling window of recent events. Nothing is sent anywhere — the data stays
 * local and can be exported or reset via the `npm-safe telemetry` CLI.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A single recorded telemetry event. */
export interface TelemetryEvent {
  /** Event type, e.g. `check`, `ci`, `search`. */
  readonly event: string;
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
  /** Number of packages scanned by this event. */
  readonly packageCount?: number;
  /** Wall-clock duration of the command, in milliseconds. */
  readonly durationMs?: number;
  /** Security-level distribution across scanned packages. */
  readonly levels?: Readonly<Record<string, number>>;
  /** Error message when the event failed. */
  readonly error?: string;
}

/** Shape of the persisted telemetry file. */
export interface TelemetryState {
  /** Whether telemetry collection is enabled. */
  readonly enabled: boolean;
  /** ISO-8601 timestamp of when telemetry was first enabled. */
  readonly since?: string;
  /** Per-event counters. */
  readonly counts: Readonly<Record<string, number>>;
  /** Total packages scanned across all events. */
  readonly totalPackagesScanned: number;
  /** Security-level distribution across all scanned packages. */
  readonly levelTotals: Readonly<Record<string, number>>;
  /** Number of failed events. */
  readonly totalErrors: number;
  /** Rolling window of recent events (newest last, capped). */
  readonly recentEvents: readonly TelemetryEvent[];
}

/** Default location of the telemetry file. */
export function getDefaultTelemetryPath(): string {
  return path.join(os.homedir(), ".npm-safe", "telemetry.json");
}

const MAX_RECENT_EVENTS = 200;

/**
 * Aggregates and persists local usage telemetry. Thread-safe per instance;
 * concurrent instances may race on the file, which is acceptable for a
 * single-user CLI.
 */
export class TelemetryManager {
  private readonly filePath: string;
  private state: TelemetryState;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getDefaultTelemetryPath();
    this.state = this.load();
  }

  private load(): TelemetryState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<TelemetryState>;
      return {
        enabled: parsed.enabled ?? false,
        since: parsed.since,
        counts: parsed.counts ?? {},
        totalPackagesScanned: parsed.totalPackagesScanned ?? 0,
        levelTotals: parsed.levelTotals ?? {},
        totalErrors: parsed.totalErrors ?? 0,
        recentEvents: Array.isArray(parsed.recentEvents) ? parsed.recentEvents.slice(-MAX_RECENT_EVENTS) : [],
      };
    } catch {
      return {
        enabled: false,
        counts: {},
        totalPackagesScanned: 0,
        levelTotals: {},
        totalErrors: 0,
        recentEvents: [],
      };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch {
      // Best-effort persistence; in-memory state remains valid.
    }
  }

  /** Whether telemetry collection is enabled. */
  isEnabled(): boolean {
    return this.state.enabled;
  }

  /** Enable telemetry collection. */
  enable(): void {
    if (!this.state.enabled) {
      this.state = {
        ...this.state,
        enabled: true,
        since: new Date().toISOString(),
      };
      this.save();
    }
  }

  /** Disable telemetry collection (keeps existing data). */
  disable(): void {
    if (this.state.enabled) {
      this.state = { ...this.state, enabled: false };
      this.save();
    }
  }

  /**
   * Record a telemetry event. No-op while telemetry is disabled.
   */
  record(event: TelemetryEvent): void {
    if (!this.state.enabled) return;

    const counts = { ...this.state.counts };
    counts[event.event] = (counts[event.event] ?? 0) + 1;

    const levelTotals = { ...this.state.levelTotals };
    if (event.levels) {
      for (const [level, count] of Object.entries(event.levels)) {
        levelTotals[level] = (levelTotals[level] ?? 0) + count;
      }
    }

    this.state = {
      ...this.state,
      counts,
      totalPackagesScanned: this.state.totalPackagesScanned + (event.packageCount ?? 0),
      levelTotals,
      totalErrors: this.state.totalErrors + (event.error ? 1 : 0),
      recentEvents: [...this.state.recentEvents, event].slice(-MAX_RECENT_EVENTS),
    };
    this.save();
  }

  /** Current aggregated telemetry state. */
  getState(): TelemetryState {
    return this.state;
  }

  /** Clear all collected telemetry data. */
  reset(): void {
    this.state = {
      enabled: this.state.enabled,
      since: this.state.enabled ? new Date().toISOString() : undefined,
      counts: {},
      totalPackagesScanned: 0,
      levelTotals: {},
      totalErrors: 0,
      recentEvents: [],
    };
    this.save();
  }
}
