import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPackageManagerProcess, windowsShimContent, shimHelperContent, powershellWrapperBlock, bashWrapperBlock } from "../src/cli/install-gate-shell.js";
import { installShellBlock, removeShellBlock, hasShellBlock } from "../src/cli/install-gate.js";

const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function withFixture(action: (directory: string, capture: string, binary: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "npm-safe shell (test)&!-"));
  const capture = path.join(directory, "capture.jsonl");
  const spy = path.join(directory, "spy.cjs");
  writeFileSync(spy, `if (process.env.NPMSAFE_GATE_COMMAND_PREFIX) throw new Error('gate prefix environment leaked'); require('node:fs').appendFileSync(process.env.NPMSAFE_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(37);\n`);
  const binary = path.join(directory, process.platform === "win32" ? "npm.cmd" : "npm");
  const shQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
  writeFileSync(binary, process.platform === "win32"
    ? `@echo off\r\nif exist "${process.execPath}" (\r\n  "${process.execPath}" "${spy}" %*\r\n) else (\r\n  exit /b 1\r\n)\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(spy)} "$@"\n`, { mode: 0o755 });
  try { action(directory, capture, binary); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function captured(file: string): string[][] {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("install gate shell command execution", { skip: process.platform !== "win32" }, () => {
  it("round-trips batch arguments and preserves the command exit code", () => {
    withFixture((directory, capture, binary) => {
      const previousBinary = process.env.NPMSAFE_REAL_NPM;
      const previousCapture = process.env.NPMSAFE_TEST_CAPTURE;
      const previousValue = process.env.NPMSAFE_TEST_VALUE;
      process.env.NPMSAFE_REAL_NPM = binary;
      process.env.NPMSAFE_TEST_CAPTURE = capture;
      process.env.NPMSAFE_TEST_VALUE = "expanded-value";
      const argv = ["install", "package", "space value", "", "say\"hello", "ending\\", "x&echo hacked", "x|echo hacked", "%NPMSAFE_TEST_VALUE%", "!bang!", "(paren)", "a^b", "@scope/pkg@^2.0.0", "--registry=https://example.test/a?b=c&d=e", "tab\tvalue", 'a\\\"&echo value', 'a"b"c', 'x]y[z', '<input>'];
      try {
        assert.equal(runPackageManagerProcess("npm", argv, directory), 37);
        assert.deepEqual(captured(capture), [argv]);
      } finally {
        if (previousBinary === undefined) delete process.env.NPMSAFE_REAL_NPM;
        else process.env.NPMSAFE_REAL_NPM = previousBinary;
        if (previousCapture === undefined) delete process.env.NPMSAFE_TEST_CAPTURE;
        else process.env.NPMSAFE_TEST_CAPTURE = previousCapture;
        if (previousValue === undefined) delete process.env.NPMSAFE_TEST_VALUE;
        else process.env.NPMSAFE_TEST_VALUE = previousValue;
      }
    });
  });

  it("forwards non-install commands through a PATH shim without recursion", () => {
    withFixture((directory, capture) => {
      const home = path.join(directory, "home");
      const shimDir = path.join(home, ".npm-safe", "bin");
      mkdirSync(shimDir, { recursive: true });
      const shim = path.join(shimDir, "npm.cmd");
      writeFileSync(shim, windowsShimContent("npm"));
      writeFileSync(path.join(shimDir, "gate-shim.mjs"), shimHelperContent());
      const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${shim}" run "a b""`], {
        encoding: "utf8", windowsVerbatimArguments: true, cwd: directory,
        env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${shimDir};${directory};${process.env.PATH}`, NPMSAFE_REAL_NPM: "", NPMSAFE_TEST_CAPTURE: capture },
      });
      assert.equal(result.status, 37, result.stderr);
      assert.deepEqual(captured(capture), [["run", "a b"]]);
    });
  });

  it("PowerShell preserves empty arguments, quotes and the native exit code", () => {
    withFixture((directory, capture, binary) => {
      const profile = path.join(directory, "profile.ps1");
      const argv = ["run", "", "a b", "say\"hello", "x&y", "%NPMSAFE_TEST_VALUE%", "@scope/pkg@^1.0.0"];
      const quoted = argv.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(", ");
      writeFileSync(profile, `${powershellWrapperBlock()}\n$npmTestArgs = @(${quoted})\nnpm @npmTestArgs\nexit $LASTEXITCODE\n`);
      const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", profile], {
        encoding: "utf8", cwd: PACKAGE_DIR,
        env: { ...process.env, NPMSAFE_REAL_NPM: binary, NPMSAFE_TEST_CAPTURE: capture, NPMSAFE_TEST_VALUE: "expanded-value" },
      });
      assert.equal(result.status, 37, result.stderr);
      assert.deepEqual(captured(capture), [argv]);
    });
  });

  it("keeps pnpm install, yarn add and bare yarn as one installation each", () => {
    withFixture((directory, capture, binary) => {
      const home = path.join(directory, "home");
      const shimDir = path.join(home, ".npm-safe", "bin");
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(path.join(shimDir, "gate-shim.mjs"), shimHelperContent());
      for (const [pm, original, expected] of [
        ["pnpm", "install", ["install"]],
        ["yarn", 'add "a b" --yes --dry-run', ["add", "a b", "--yes", "--dry-run"]],
        ["yarn", "", ["install"]],
      ] as const) {
        const shim = path.join(shimDir, `${pm}.cmd`);
        writeFileSync(shim, windowsShimContent(pm));
        const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${shim}" ${original}"`], {
          encoding: "utf8", windowsVerbatimArguments: true, cwd: PACKAGE_DIR,
          env: { ...process.env, HOME: home, USERPROFILE: home, [`NPMSAFE_REAL_${pm.toUpperCase()}`]: binary, NPMSAFE_TEST_CAPTURE: capture },
        });
        assert.equal(result.status, 37, `${result.stdout}\n${result.stderr}`);
        assert.deepEqual(captured(capture).at(-1), [...expected]);
      }
      assert.equal(captured(capture).length, 3, "each gated invocation must install exactly once");
    });
  });

  it("PowerShell bare install does not duplicate its first argument", () => {
    withFixture((directory, capture, binary) => {
      const home = path.join(directory, "home");
      mkdirSync(home);
      const profile = path.join(directory, "profile.ps1");
      writeFileSync(profile, `${powershellWrapperBlock()}\nnpm install\nexit $LASTEXITCODE\n`);
      const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", profile], {
        encoding: "utf8", cwd: PACKAGE_DIR,
        env: { ...process.env, HOME: home, USERPROFILE: home, NPMSAFE_REAL_NPM: binary, NPMSAFE_TEST_CAPTURE: capture },
      });
      assert.equal(result.status, 37, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(captured(capture), [["install"]]);
    });
  });

  it("forwards bare npm and pnpm without inventing an install command", () => {
    withFixture((directory, capture, binary) => {
      const home = path.join(directory, "home");
      const shimDir = path.join(home, ".npm-safe", "bin");
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(path.join(shimDir, "gate-shim.mjs"), shimHelperContent());
      for (const pm of ["npm", "pnpm"] as const) {
        const shim = path.join(shimDir, `${pm}.cmd`);
        writeFileSync(shim, windowsShimContent(pm));
        const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${shim}""`], {
          encoding: "utf8", windowsVerbatimArguments: true, cwd: PACKAGE_DIR,
          env: { ...process.env, HOME: home, USERPROFILE: home, [`NPMSAFE_REAL_${pm.toUpperCase()}`]: binary, NPMSAFE_TEST_CAPTURE: capture },
        });
        assert.equal(result.status, 37, result.stderr);
      }
      assert.deepEqual(captured(capture), [[], []]);
    });
  });

  it("gates leading flags and restores their original order before execution", () => {
    withFixture((directory, capture, binary) => {
      const home = path.join(directory, "home");
      const shimDir = path.join(home, ".npm-safe", "bin");
      mkdirSync(shimDir, { recursive: true });
      writeFileSync(path.join(shimDir, "gate-shim.mjs"), shimHelperContent());
      const cases: Array<["npm" | "pnpm" | "yarn", string, string[]]> = [
        ["npm", "--global install package", ["--global", "install", "package"]],
        ["pnpm", "--filter app add package", ["--filter", "app", "add", "package"]],
        ["npm", "--workspace add install package", ["--workspace", "add", "install", "package"]],
        ["npm", "-- install package", ["--", "install", "package"]],
        ["pnpm", "--filter add run install package", ["--filter", "add", "run", "install", "package"]],
        ["yarn", "--help", ["--help"]],
        ["npm", "--silent ci", ["--silent", "ci"]],
        ["npm", "--global isntall package", ["--global", "isntall", "package"]],
        ["npm", "--ignore-scripts true install package", ["--ignore-scripts", "true", "install", "package"]],
        ["npm", "--global false install package", ["--global", "false", "install", "package"]],
        ["npm", "--help false install package", ["--help", "false", "install", "package"]],
        ["npm", "--color always install package", ["--color", "always", "install", "package"]],
      ];
      for (const [pm, command, expected] of cases) {
        const shim = path.join(shimDir, `${pm}.cmd`);
        writeFileSync(shim, windowsShimContent(pm));
        const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${shim}" ${command}"`], {
          encoding: "utf8", windowsVerbatimArguments: true, cwd: PACKAGE_DIR,
          env: { ...process.env, HOME: home, USERPROFILE: home, [`NPMSAFE_REAL_${pm.toUpperCase()}`]: binary, NPMSAFE_TEST_CAPTURE: capture },
        });
        assert.equal(result.status, 37, `${command}\n${result.stdout}\n${result.stderr}`);
        assert.deepEqual(captured(capture).at(-1), expected);
      }
      assert.equal(captured(capture).length, cases.length);
    });
  });

  it("blocks leading-flag installs and ambiguous unknown options before execution", () => {
    withFixture((directory, capture, binary) => {
      const home = path.join(directory, "home");
      const shimDir = path.join(home, ".npm-safe", "bin");
      mkdirSync(shimDir, { recursive: true });
      const env = { ...process.env, HOME: home, USERPROFILE: home, NPMSAFE_REAL_NPM: binary, NPMSAFE_REAL_PNPM: binary, NPMSAFE_TEST_CAPTURE: capture };
      const enabled = spawnSync(process.execPath, ["--import", "tsx", path.join(PACKAGE_DIR, "src", "cli", "cli.ts"), "gate", "enable", "--no-shell"], { cwd: PACKAGE_DIR, env, encoding: "utf8" });
      assert.equal(enabled.status, 0, enabled.stderr);
      writeFileSync(path.join(shimDir, "gate-shim.mjs"), shimHelperContent());
      for (const [pm, command] of [
        ["npm", "--global install file:./unscannable"],
        ["pnpm", "--filter app add file:./unscannable"],
        ["npm", "--silent ci file:./unscannable"],
        ["npm", "isntall file:./unscannable"],
        ["npm", "--unknown=value install package"],
        ["npm", "--unknown value install package"],
        ["npm", "--ignore-scripts true install file:./unscannable"],
        ["npm", "--ignore-scripts false install file:./unscannable"],
        ["npm", "--help false install file:./unscannable"],
        ["npm", "--version false install file:./unscannable"],
        ["npm", "--color always install file:./unscannable"],
      ] as const) {
        const shim = path.join(shimDir, `${pm}.cmd`);
        writeFileSync(shim, windowsShimContent(pm));
        const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${shim}" ${command}"`], {
          encoding: "utf8", windowsVerbatimArguments: true, cwd: PACKAGE_DIR, env,
        });
        assert.equal(result.status, 1, `${command}\n${result.stdout}\n${result.stderr}`);
        assert.ok(/Cannot check|Cannot safely identify/.test(result.stderr), result.stderr);
      }
      assert.equal(existsSync(capture), false, "a rejected command must never reach the package manager");
    });
  });
});

const BASH = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
describe("POSIX shell wrappers", { skip: !existsSync(BASH) }, () => {
  it("preserves the selected manager, verb, arguments and failing exit status", () => {
    withFixture((directory, capture, binary) => {
      const posixPath = (value: string): string => value.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1");
      const home = path.join(directory, "home");
      mkdirSync(home);
      const script = path.join(directory, "run.sh");
      writeFileSync(script, `${bashWrapperBlock()}\nset -u\npnpm --filter app install '' 'a b' '--yes'\n`);
      const result = spawnSync(BASH, ["--noprofile", "--norc", posixPath(script)], {
        encoding: "utf8", cwd: PACKAGE_DIR,
        env: { ...process.env, HOME: home, USERPROFILE: home, NPMSAFE_REAL_PNPM: binary, NPMSAFE_TEST_CAPTURE: capture },
      });
      assert.equal(result.status, 37, result.stderr);
      assert.deepEqual(captured(capture), [["--filter", "app", "install", "", "a b", "--yes"]]);
    });
  });
});

describe("shell configuration block maintenance", () => {
  it("preserves surrounding CRLF configuration and reports an unchanged block", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "npm-safe-block-"));
    const profile = path.join(directory, "profile.PS1");
    try {
      const original = "# user profile\r\n$env:USER_SETTING = 'preserved'  \r\n";
      writeFileSync(profile, original);
      assert.equal(installShellBlock(profile), "created");
      const installed = readFileSync(profile, "utf8");
      assert.ok(installed.startsWith(original));
      assert.ok(installed.includes("function pnpm"));
      assert.equal(installed.replace(/\r\n/g, "").includes("\n"), false);
      assert.equal(installShellBlock(profile), "existing");
      assert.equal(readFileSync(profile, "utf8"), installed);
      assert.equal(hasShellBlock(profile), true);
      assert.equal(removeShellBlock(profile), true);
      assert.ok(readFileSync(profile, "utf8").startsWith(original));
      assert.equal(hasShellBlock(profile), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not overwrite user content when gate markers are incomplete", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "npm-safe-block-"));
    const profile = path.join(directory, ".bashrc");
    try {
      const original = "# >>> npm-safe gate >>>\n# user content after damaged block\n";
      writeFileSync(profile, original);
      assert.throws(() => installShellBlock(profile), /Incomplete npm-safe gate block/);
      assert.equal(removeShellBlock(profile), false);
      assert.equal(readFileSync(profile, "utf8"), original);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("refreshes duplicated complete blocks without touching surrounding lines", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "npm-safe-block-"));
    const profile = path.join(directory, ".bashrc");
    try {
      const old = "# >>> npm-safe gate >>>\nold() { :; }\n# <<< npm-safe gate <<<";
      writeFileSync(profile, `before\n${old}\nbetween\n${old}\nafter\n`);
      assert.equal(installShellBlock(profile), "updated");
      const content = readFileSync(profile, "utf8");
      assert.equal(content.split("# >>> npm-safe gate >>>").length - 1, 1);
      assert.ok(content.startsWith("before\n"));
      assert.ok(content.includes("between\n"));
      assert.ok(content.endsWith("after\n"));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
