import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { RuleConfigManager } from "../src/scanner/rule-config.js";
import { Severity } from "../src/scanner/types.js";

function tmpConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-safe-rules-"));
  return path.join(dir, "rules.json");
}

describe("RuleConfigManager", () => {
  it("starts with an empty config when no file exists", () => {
    const mgr = new RuleConfigManager(tmpConfigPath());
    assert.deepStrictEqual(mgr.getConfiguredRuleIds(), []);
    assert.strictEqual(mgr.isEnabled("x", true), true);
    assert.strictEqual(mgr.getSeverityOverride("x"), undefined);
  });

  it("treats a corrupt config file as empty", () => {
    const file = tmpConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json");
    const mgr = new RuleConfigManager(file);
    assert.deepStrictEqual(mgr.getConfiguredRuleIds(), []);
  });

  it("persists enable/disable overrides", () => {
    const file = tmpConfigPath();
    const mgr = new RuleConfigManager(file);
    mgr.setEnabled("install-script", false);
    assert.strictEqual(mgr.isEnabled("install-script", true), false);

    const reloaded = new RuleConfigManager(file);
    assert.strictEqual(reloaded.isEnabled("install-script", true), false);
  });

  it("persists severity overrides and can clear them", () => {
    const file = tmpConfigPath();
    const mgr = new RuleConfigManager(file);
    mgr.setSeverity("typosquatting", Severity.Critical);
    assert.strictEqual(
      mgr.getSeverityOverride("typosquatting"),
      Severity.Critical,
    );

    mgr.setSeverity("typosquatting", undefined);
    assert.strictEqual(mgr.getSeverityOverride("typosquatting"), undefined);
  });

  it("persists free-form options", () => {
    const file = tmpConfigPath();
    const mgr = new RuleConfigManager(file);
    mgr.setOptions("my-rule", { threshold: 3 });
    assert.deepStrictEqual(mgr.getOptions("my-rule"), { threshold: 3 });

    const reloaded = new RuleConfigManager(file);
    assert.deepStrictEqual(reloaded.getOptions("my-rule"), { threshold: 3 });
  });

  it("returns {} for options of an unconfigured rule", () => {
    const mgr = new RuleConfigManager(tmpConfigPath());
    assert.deepStrictEqual(mgr.getOptions("nope"), {});
  });
});
