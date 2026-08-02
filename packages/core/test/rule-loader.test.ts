import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { loadRulesFromDirectory } from "../src/scanner/rule-loader.js";
import { FindingCategory, Severity } from "../src/scanner/types.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "npm-safe-rules-dir-"));
}

function writeRuleFile(dir: string, name: string, body: string): void {
  fs.writeFileSync(path.join(dir, name), body, "utf8");
}

describe("loadRulesFromDirectory", () => {
  it("returns [] when the directory does not exist", async () => {
    const results = await loadRulesFromDirectory(path.join(os.tmpdir(), "no-such-dir"));
    assert.deepStrictEqual(results, []);
  });

  it("loads a single rule exported as `rule`", async () => {
    const dir = tmpDir();
    writeRuleFile(
      dir,
      "one.mjs",
      `export const rule = {
        id: "test-one",
        name: "One",
        description: "d",
        severity: "${Severity.High}",
        category: "${FindingCategory.Informational}",
        enabled: true,
        match: () => [],
      };`,
    );
    const results = await loadRulesFromDirectory(dir);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].rules.length, 1);
    assert.strictEqual(results[0].rules[0].id, "test-one");
  });

  it("loads multiple rules exported as `rules`", async () => {
    const dir = tmpDir();
    writeRuleFile(
      dir,
      "multi.mjs",
      `export const rules = [
        { id: "a", name: "A", description: "d", severity: "low", category: "informational", enabled: true, match: () => [] },
        { id: "b", name: "B", description: "d", severity: "low", category: "informational", enabled: true, match: () => [] },
      ];`,
    );
    const results = await loadRulesFromDirectory(dir);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].rules.length, 2);
  });

  it("loads rules from a `default` export", async () => {
    const dir = tmpDir();
    writeRuleFile(
      dir,
      "default.mjs",
      `export default {
        id: "dflt",
        name: "Default",
        description: "d",
        severity: "medium",
        category: "informational",
        enabled: true,
        match: () => [],
      };`,
    );
    const results = await loadRulesFromDirectory(dir);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].rules[0].id, "dflt");
  });

  it("loads rules from a factory function", async () => {
    const dir = tmpDir();
    writeRuleFile(
      dir,
      "factory.mjs",
      `export const rule = () => ({
        id: "fact",
        name: "Factory",
        description: "d",
        severity: "high",
        category: "informational",
        enabled: true,
        match: () => [],
      });`,
    );
    const results = await loadRulesFromDirectory(dir);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].rules[0].id, "fact");
  });

  it("skips files that do not export rules", async () => {
    const dir = tmpDir();
    writeRuleFile(dir, "empty.mjs", `export const nothing = 42;`);
    writeRuleFile(dir, "broken.mjs", `export const rule = { nope: true };`);
    const results = await loadRulesFromDirectory(dir);
    assert.deepStrictEqual(results, []);
  });

  it("loads files in lexical order", async () => {
    const dir = tmpDir();
    writeRuleFile(dir, "10-late.mjs", `export const rule = { id: "late", name: "L", description: "d", severity: "low", category: "informational", enabled: true, match: () => [] };`);
    writeRuleFile(dir, "01-early.mjs", `export const rule = { id: "early", name: "E", description: "d", severity: "low", category: "informational", enabled: true, match: () => [] };`);
    const results = await loadRulesFromDirectory(dir);
    assert.deepStrictEqual(
      results.map((r) => r.rules[0].id),
      ["early", "late"],
    );
  });
});
