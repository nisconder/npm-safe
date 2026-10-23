import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InstallArgumentError,
  packageManagerOptionKind,
  packageManagerOptionTakesValue,
  parseInstallArguments,
  parseRegistryTarget,
} from "../src/cli/install-arguments.js";

describe("install argument parsing", () => {
  it("consumes gate options and preserves the originating package manager and verb", () => {
    const parsed = parseInstallArguments([
      "--pm", "pnpm", "--verb=add", "--yes", "--dry-run", "--json", "--deep",
      "--dir=project dir", "--threshold", "92", "--save-dev", "@scope/pkg@1.2.3", "pkg@next",
    ]);
    assert.equal(parsed.pm, "pnpm");
    assert.equal(parsed.verb, "add");
    assert.equal(parsed.yes, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.json, true);
    assert.equal(parsed.deep, true);
    assert.equal(parsed.dir, "project dir");
    assert.equal(parsed.threshold, 92);
    assert.deepEqual(parsed.passthrough, ["--save-dev", "@scope/pkg@1.2.3", "pkg@next"]);
    assert.deepEqual(parsed.packageNames, ["@scope/pkg@1.2.3", "pkg@next"]);
    assert.deepEqual(parsed.packageIndexes, [1, 2]);
    assert.deepEqual(parsed.unsupportedTargets, []);
  });

  it("does not misidentify package-manager option values as packages", () => {
    const args = [
      "--registry", "https://registry.npmjs.org/", "--tag=next", "--workspace", "web",
      "-w", "api", "--cache", "C:\\temp\\cache", "--save-dev", "--ignore-scripts=false", "pkg",
    ];
    const parsed = parseInstallArguments(args);
    assert.deepEqual(parsed.passthrough, args);
    assert.deepEqual(parsed.packageNames, ["pkg"]);
    assert.equal(parsed.tag, "next");
    assert.deepEqual(parsed.unsupportedTargets, []);
    const pnpmArgs = ["--filter", "./apps/*", "-Ftools", "--reporter=append-only", "pkg"];
    const pnpm = parseInstallArguments(pnpmArgs, "pnpm");
    assert.deepEqual(pnpm.passthrough, pnpmArgs);
    assert.deepEqual(pnpm.packageNames, ["pkg"]);
    assert.deepEqual(pnpm.unsupportedTargets, []);
  });

  it("supports bundled boolean flags and short attached values", () => {
    const parsed = parseInstallArguments(["-Dg", "-wweb", "--audit=false", "pkg"]);
    assert.deepEqual(parsed.packageNames, ["pkg"]);
    assert.deepEqual(parsed.passthrough, ["-Dg", "-wweb", "--audit=false", "pkg"]);
    assert.deepEqual(parsed.unsupportedTargets, []);
  });

  it("preserves npm's explicit boolean values without scanning them as packages", () => {
    const parsed = parseInstallArguments([
      "--pm=npm", "--", "--ignore-scripts", "true", "--audit", "false", "pkg@^1",
    ]);
    assert.deepEqual(parsed.passthrough, ["--ignore-scripts", "true", "--audit", "false", "pkg@^1"]);
    assert.deepEqual(parsed.packageNames, ["pkg@^1"]);
    assert.deepEqual(parsed.packageIndexes, [4]);
    assert.deepEqual(parsed.unsupportedTargets, []);
  });

  it("still scans a package named true after an explicit npm boolean value", () => {
    const parsed = parseInstallArguments(["--pm=npm", "--", "--ignore-scripts", "true", "true"]);
    assert.deepEqual(parsed.passthrough, ["--ignore-scripts", "true", "true"]);
    assert.deepEqual(parsed.packageNames, ["true"]);
    assert.deepEqual(parsed.packageIndexes, [2]);
    parsed.passthrough[parsed.packageIndexes[0]] = "true@1.0.0";
    assert.deepEqual(parsed.passthrough, ["--ignore-scripts", "true", "true@1.0.0"]);
  });

  it("does not assume npm's explicit boolean value syntax for yarn or pnpm", () => {
    for (const pm of ["yarn", "pnpm"] as const) {
      const parsed = parseInstallArguments([`--pm=${pm}`, "--", "--ignore-scripts", "true", "pkg"]);
      assert.deepEqual(parsed.packageNames, ["true", "pkg"]);
      assert.deepEqual(parsed.packageIndexes, [1, 2]);
    }
  });

  it("supports npm's color always enum and help false without changing package positions", () => {
    const parsed = parseInstallArguments([
      "--pm=npm", "--", "--color", "always", "--no-color", "always", "--color=always", "--help", "false", "pkg",
    ]);
    assert.deepEqual(parsed.passthrough, ["--color", "always", "--no-color", "always", "--color=always", "--help", "false", "pkg"]);
    assert.deepEqual(parsed.packageNames, ["pkg"]);
    assert.deepEqual(parsed.packageIndexes, [7]);
    assert.deepEqual(parsed.unsupportedTargets, []);
  });

  it("uses the first -- to protect package-manager options from the gate", () => {
    const parsed = parseInstallArguments(["-y", "--pm=npm", "--", "--dry-run", "--json", "-D", "--workspace", "pkg", "pkg@1.0.0"]);
    assert.equal(parsed.yes, true);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.json, false);
    assert.deepEqual(parsed.passthrough, ["--dry-run", "--json", "-D", "--workspace", "pkg", "pkg@1.0.0"]);
    assert.deepEqual(parsed.packageNames, ["pkg@1.0.0"]);
    assert.deepEqual(parsed.packageIndexes, [5]);
    assert.deepEqual(parsed.unsupportedTargets, []);
  });

  it("preserves a second -- as the manager's literal positional separator", () => {
    const parsed = parseInstallArguments(["-y", "--", "--", "pkg@1.0.0", "--deep", "--threshold=0"]);
    assert.equal(parsed.yes, true);
    assert.equal(parsed.deep, false);
    assert.equal(parsed.threshold, undefined);
    assert.deepEqual(parsed.passthrough, ["--", "pkg@1.0.0", "--deep", "--threshold=0"]);
    assert.deepEqual(parsed.packageNames, ["pkg@1.0.0"]);
    assert.deepEqual(parsed.packageIndexes, [1]);
    assert.deepEqual(parsed.unsupportedTargets.map((target) => target.spec), ["--deep", "--threshold=0"]);
  });

  it("handles pnpm's -w without swallowing the package and rejects workspace sources", () => {
    const parsed = parseInstallArguments(["--pm=pnpm", "--", "-w", "pkg"]);
    assert.deepEqual(parsed.packageNames, ["pkg"]);
    assert.deepEqual(parsed.packageIndexes, [1]);
    assert.deepEqual(parsed.unsupportedTargets, []);
    const workspace = parseInstallArguments(["--pm=pnpm", "--", "--workspace", "pkg"]);
    assert.deepEqual(workspace.packageNames, ["pkg"]);
    assert.equal(workspace.unsupportedTargets.length, 1);
    assert.deepEqual(parseInstallArguments(["-w", "pkg"], "pnpm").packageNames, ["pkg"]);
  });

  it("rejects missing values before another option can be swallowed", () => {
    for (const option of ["--dir", "--threshold", "--pm", "--verb", "--registry", "--workspace", "-w", "--filter", "--tag"]) {
      assert.throws(() => parseInstallArguments([option]), InstallArgumentError, option);
      assert.throws(() => parseInstallArguments([option, "--yes"]), InstallArgumentError, option);
      assert.throws(() => parseInstallArguments([`${option}=`]), InstallArgumentError, option);
    }
  });

  it("rejects malformed gate values instead of accepting partial integers", () => {
    for (const value of ["NaN", "101", "-1", "85junk", "1.5", "1e2", "Infinity", " "]) {
      assert.throws(() => parseInstallArguments([`--threshold=${value}`]), InstallArgumentError, value);
    }
    for (const value of ["0", "85", "100"]) {
      assert.equal(parseInstallArguments([`--threshold=${value}`]).threshold, Number(value));
    }
    for (const option of ["--yes=false", "--dry-run=true", "--deep=1", "--json=", "--pm=bun", "--verb=exec", "--dir= "]) {
      assert.throws(() => parseInstallArguments([option]), InstallArgumentError, option);
    }
  });

  it("rejects unsupported sources while retaining every original argument", () => {
    const args = [
      "pkg@npm:other@1.0.0", "github:owner/repo", "owner/repo", "git+https://github.com/a/b",
      "https://host/pkg.tgz", "file:../local", "./local", "C:\\local", "pkg.tgz", "workspace:*",
    ];
    const parsed = parseInstallArguments(args);
    assert.deepEqual(parsed.passthrough, args);
    assert.deepEqual(parsed.packageNames, []);
    assert.deepEqual(parsed.unsupportedTargets.map((target) => target.spec), args);
  });

  it("reports custom registries, changed configuration, and unknown options", () => {
    const parsed = parseInstallArguments([
      "--registry=https://private.example/", "--@scope:registry", "https://private.example/",
      "--userconfig", "custom.npmrc", "--unknown-option=value", "pkg",
    ]);
    assert.deepEqual(parsed.packageNames, ["pkg"]);
    assert.equal(parsed.unsupportedTargets.length, 4);
    assert.deepEqual(parseInstallArguments(["--registry=https://registry.npmjs.org", "pkg"]).unsupportedTargets, []);
    assert.equal(parseInstallArguments(["--registry=http://registry.npmjs.org", "pkg"]).unsupportedTargets.length, 1);
  });

  it("cannot hide an npm install target behind a foreign manager's value flag", () => {
    for (const args of [["-F", "pkg"], ["--filter", "pkg"], ["--network-concurrency", "pkg"]]) {
      assert.ok(parseInstallArguments(args, "npm").unsupportedTargets.length > 0);
    }
  });

  it("returns new arrays without mutating the input", () => {
    const args = Object.freeze(["--yes", "pkg"]);
    const first = parseInstallArguments(args);
    first.passthrough.push("other");
    assert.deepEqual(parseInstallArguments(args).passthrough, ["pkg"]);
    assert.deepEqual(args, ["--yes", "pkg"]);
  });
});

describe("package-manager option classification", () => {
  it("distinguishes a known value from an actual following command", () => {
    assert.equal(packageManagerOptionKind("--registry", "npm"), "value");
    assert.equal(packageManagerOptionKind("--registry=https://registry.npmjs.org/", "npm"), "value");
    assert.equal(packageManagerOptionKind("--filter", "pnpm"), "value");
    assert.equal(packageManagerOptionKind("--filter", "npm"), "unknown");
    assert.equal(packageManagerOptionKind("--unknown-config", "npm"), "unknown");
    assert.equal(packageManagerOptionKind("install", "npm"), "unknown");
    assert.equal(packageManagerOptionKind("--save-dev", "npm"), "boolean");
    assert.equal(packageManagerOptionKind("--no-audit", "npm"), "boolean");
    assert.equal(packageManagerOptionKind("-Dg", "npm"), "boolean");
  });

  it("preserves manager-specific workspace and directory meanings", () => {
    assert.equal(packageManagerOptionTakesValue("-w", "npm"), true);
    assert.equal(packageManagerOptionKind("-w", "pnpm"), "boolean");
    assert.equal(packageManagerOptionKind("--workspace", "pnpm"), "boolean");
    assert.equal(packageManagerOptionKind("-w", "yarn"), "unknown");
    assert.equal(packageManagerOptionTakesValue("--cwd", "yarn"), true);
    assert.equal(packageManagerOptionTakesValue("-C", "pnpm"), true);
    assert.equal(packageManagerOptionKind("-C", "npm"), "unknown");
  });
});

describe("registry install targets", () => {
  it("accepts plain registry names, versions, ranges, and dist-tags", () => {
    assert.deepEqual(parseRegistryTarget("pkg"), { name: "pkg" });
    assert.deepEqual(parseRegistryTarget("@scope/pkg"), { name: "@scope/pkg" });
    assert.deepEqual(parseRegistryTarget("pkg@1.2.3-beta.1+build"), { name: "pkg", version: "1.2.3-beta.1+build" });
    assert.deepEqual(parseRegistryTarget("@scope/pkg@next"), { name: "@scope/pkg", version: "next" });
    for (const range of ["^1.2.3", "~1.2.3", "1", "*", ">=1.0.0", "v1", "1.2.3 || 2.0.0"]) {
      assert.deepEqual(parseRegistryTarget(`pkg@${range}`), { name: "pkg", version: range });
    }
  });

  it("does not quietly normalize invalid or unsupported inputs", () => {
    for (const spec of ["", " pkg", "pkg ", "pkg@", "pkg@01.2.3", "@scope", "Pkg", "alias@npm:pkg", "pkg@bad tag"]) {
      assert.throws(() => parseRegistryTarget(spec), InstallArgumentError, spec);
    }
  });
});
