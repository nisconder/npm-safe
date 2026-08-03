import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { TelemetryManager } from "../src/telemetry/telemetry.js";

describe("TelemetryManager", () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "npm-safe-telemetry-"));
    file = path.join(tmpDir, "telemetry.json");
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("is disabled by default", () => {
    const manager = new TelemetryManager(file);
    assert.strictEqual(manager.isEnabled(), false);
    assert.deepStrictEqual(manager.getState().counts, {});
  });

  it("does not record events while disabled", () => {
    const manager = new TelemetryManager(file);
    manager.record({ event: "check", timestamp: new Date().toISOString(), packageCount: 3 });
    assert.deepStrictEqual(manager.getState().counts, {});
    assert.strictEqual(manager.getState().totalPackagesScanned, 0);
  });

  it("records and aggregates events when enabled", () => {
    const manager = new TelemetryManager(file);
    manager.enable();
    manager.record({
      event: "check",
      timestamp: "2026-08-03T00:00:00.000Z",
      packageCount: 3,
      durationMs: 120,
      levels: { safe: 2, suspicious: 1 },
    });
    manager.record({
      event: "ci",
      timestamp: "2026-08-03T00:01:00.000Z",
      packageCount: 8,
      levels: { safe: 7, dangerous: 1 },
    });

    const state = manager.getState();
    assert.strictEqual(state.enabled, true);
    assert.strictEqual(state.counts.check, 1);
    assert.strictEqual(state.counts.ci, 1);
    assert.strictEqual(state.totalPackagesScanned, 11);
    assert.deepStrictEqual(state.levelTotals, { safe: 9, suspicious: 1, dangerous: 1 });
    assert.strictEqual(state.recentEvents.length, 2);
  });

  it("counts errors and keeps a capped rolling window", () => {
    const manager = new TelemetryManager(file);
    manager.enable();
    for (let i = 0; i < 250; i++) {
      manager.record({
        event: "check",
        timestamp: new Date().toISOString(),
        packageCount: 1,
        error: i % 2 === 0 ? "boom" : undefined,
      });
    }
    const state = manager.getState();
    assert.strictEqual(state.totalErrors, 125);
    assert.strictEqual(state.recentEvents.length, 200);
    assert.strictEqual(state.counts.check, 250);
  });

  it("persists state across instances", () => {
    const first = new TelemetryManager(file);
    first.enable();
    first.record({ event: "check", timestamp: "2026-08-03T00:00:00.000Z", packageCount: 2 });

    const second = new TelemetryManager(file);
    assert.strictEqual(second.isEnabled(), true);
    assert.strictEqual(second.getState().totalPackagesScanned, 2);
  });

  it("disables while keeping existing data", () => {
    const manager = new TelemetryManager(file);
    manager.enable();
    manager.record({ event: "check", timestamp: "2026-08-03T00:00:00.000Z", packageCount: 1 });
    manager.disable();
    assert.strictEqual(manager.isEnabled(), false);
    assert.strictEqual(manager.getState().totalPackagesScanned, 1);
  });

  it("resets counters but keeps the enabled flag", () => {
    const manager = new TelemetryManager(file);
    manager.enable();
    manager.record({ event: "check", timestamp: "2026-08-03T00:00:00.000Z", packageCount: 1 });
    manager.reset();
    const state = manager.getState();
    assert.strictEqual(state.enabled, true);
    assert.strictEqual(state.totalPackagesScanned, 0);
    assert.deepStrictEqual(state.counts, {});
    assert.strictEqual(state.recentEvents.length, 0);
  });

  it("treats a corrupt file as empty", () => {
    writeFileSync(file, "not json");
    const manager = new TelemetryManager(file);
    assert.strictEqual(manager.isEnabled(), false);
  });
});
