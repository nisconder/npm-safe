import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_WINDOWS_PATH_CHARS, planWindowsPath, updateWindowsPath, windowsPathStore, type WindowsPathSnapshot, type WindowsPathScope, type WindowsPathStore } from "../src/cli/windows-path.js";

const shim = "C:\\Users\\fixture\\.npm-safe\\bin";
const environment = { USERPROFILE: "C:\\Users\\fixture", LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" };

function memoryStore(value: string | null, kind: WindowsPathSnapshot["kind"] = "ExpandString") {
  let snapshot: WindowsPathSnapshot = { value, kind: value === null ? null : kind };
  const writes: {scope: WindowsPathScope; expected: WindowsPathSnapshot; value: string}[] = [];
  const store: WindowsPathStore = {
    read: () => snapshot,
    write(scope, expected, next) {
      assert.equal(expected, snapshot, "must use the exact snapshot read from the chosen scope");
      writes.push({scope, expected, value: next});
      snapshot = {value: next, kind: expected.kind ?? "ExpandString"};
    },
  };
  return {store, writes, current: () => snapshot};
}

describe("lossless Windows PATH updates", () => {
  it("preserves a long raw user PATH without copying the process PATH", () => {
    const raw = Array.from({length: 150}, (_, index) => `%LOCALAPPDATA%\\tool-${index}`).join(";");
    const fixture = memoryStore(raw);
    assert.ok(raw.length > 1024);
    assert.equal(updateWindowsPath(shim, {scope:"User", store:fixture.store, environment:{...environment, PATH:"C:\\machine;C:\\session"}}), "updated");
    assert.equal(fixture.current().value, `${shim};${raw}`);
    assert.equal(fixture.current().kind, "ExpandString");
    assert.equal(fixture.writes[0].scope, "User");
    assert.equal(updateWindowsPath(shim, {scope:"User", store:fixture.store, environment}), "already");
    assert.equal(fixture.writes.length, 1, "a second activation must not write or grow PATH");
  });

  it("moves and deduplicates only shim entries while preserving unrelated data and order", () => {
    const raw = `C:\\tools;;"%LOCALAPPDATA%\\other";%USERPROFILE%\\.npm-safe\\bin;C:\\tools;"c:/users/FIXTURE/.npm-safe/bin/";`;
    assert.equal(planWindowsPath(raw, shim, false, environment), `%USERPROFILE%\\.npm-safe\\bin;C:\\tools;;"%LOCALAPPDATA%\\other";C:\\tools;`);
  });

  it("does not rewrite a unique leading shim spelling or variable reference", () => {
    const raw = `%userprofile%\\.npm-safe\\bin;C:\\tools;;`;
    const fixture = memoryStore(raw);
    assert.equal(updateWindowsPath(shim, {scope:"User", store:fixture.store, environment}), "already");
    assert.equal(fixture.current().value, raw);
    assert.deepEqual(fixture.writes, []);
  });

  it("keeps unresolved references, Unicode, shell metacharacters and non-shim duplicates intact", () => {
    const raw = "%UNKNOWN%\\工具 (x)&!;C:\\same;C:\\same;";
    assert.equal(planWindowsPath(raw, shim, false, environment), `${shim};${raw}`);
  });

  it("uses the same lossless plan for the explicitly selected Machine scope", () => {
    const raw = "%SystemRoot%\\System32;;C:\\工具";
    const fixture = memoryStore(raw, "String");
    assert.equal(updateWindowsPath(shim, {scope:"Machine", store:fixture.store}), "updated");
    assert.equal(fixture.writes[0].scope, "Machine");
    assert.equal(fixture.current().kind, "String");
    assert.equal(fixture.current().value, `${shim};${raw}`);
  });

  it("creates an absent user PATH without importing Machine or session entries", () => {
    const fixture = memoryStore(null);
    assert.equal(updateWindowsPath(shim, {scope:"User", store:fixture.store, environment:{PATH:"C:\\machine;C:\\session"}}), "updated");
    assert.equal(fixture.current().value, shim);
  });

  it("removes only shim entries and leaves an absent PATH absent", () => {
    assert.equal(planWindowsPath(`C:\\other;${shim};C:\\other;${shim};;`, shim, true), "C:\\other;C:\\other;;");
    const fixture = memoryStore(null);
    assert.equal(updateWindowsPath(shim, {scope:"User", remove:true, store:fixture.store}), "absent");
    assert.deepEqual(fixture.writes, []);
  });

  it("accepts the full supported value length and rejects only growth past it without writing", () => {
    const raw = "a".repeat(MAX_WINDOWS_PATH_CHARS - shim.length - 1);
    assert.equal(planWindowsPath(raw, shim).length, MAX_WINDOWS_PATH_CHARS);
    const fixture = memoryStore(raw + "a");
    assert.throws(() => updateWindowsPath(shim, {scope:"User", store:fixture.store}), /32767.*maximum 32766.*not changed.*shell wrappers|32767.*maximum 32766.*not changed.*--file/);
    assert.deepEqual(fixture.writes, []);
    assert.equal(fixture.current().value, raw + "a");
  });

  it("does not reject an already activated maximum-length PATH", () => {
    const raw = `${shim};${"a".repeat(MAX_WINDOWS_PATH_CHARS - shim.length - 1)}`;
    const fixture = memoryStore(raw);
    assert.equal(updateWindowsPath(shim, {scope:"User", store:fixture.store}), "already");
    assert.deepEqual(fixture.writes, []);
  });

  it("counts Windows UTF-16 units and refuses unrepresentable directory delimiters", () => {
    assert.equal(planWindowsPath("C:\\工具😀", shim), `${shim};C:\\工具😀`);
    for (const directory of ["", "C:\\a;b", "C:\\a\0b", "C:\\a\nb"]) assert.throws(() => planWindowsPath("unchanged", directory), /PATH entry/);
  });

  it("transports long raw values in stdin JSON rather than interpolating them into PowerShell code", () => {
    const raw = `%LOCALAPPDATA%\\工具&'";${"a".repeat(5000)}`;
    const calls: {script:string; payload:Record<string, unknown>}[] = [];
    const store = windowsPathStore((script, input) => {
      const payload = JSON.parse(input);
      calls.push({script, payload});
      return payload.action === "read" ? JSON.stringify({value:raw, kind:"ExpandString"}) : "ok";
    });
    assert.equal(updateWindowsPath(shim, {scope:"User", store}), "updated");
    assert.deepEqual(calls[0].payload, {action:"read", scope:"User"});
    assert.deepEqual(calls[1].payload, {action:"write", scope:"User", expected:{value:raw,kind:"ExpandString"}, value:`${shim};${raw}`});
    assert.ok(!calls[1].script.includes(raw));
    assert.ok(!calls[1].script.includes("SetEnvironmentVariable"));
    assert.ok(!calls[1].script.includes("setx"));
  });

  it("propagates a failed write instead of reporting successful activation", () => {
    const store: WindowsPathStore = {read:() => ({value:"C:\\old",kind:"String"}), write:() => {throw new Error("PATH changed concurrently");}};
    assert.throws(() => updateWindowsPath(shim, {scope:"User",store}), /changed concurrently/);
  });

  it("parses the actual persistence script with Windows PowerShell without executing it", {skip:process.platform !== "win32"}, () => {
    let script = "";
    windowsPathStore((source) => {script=source;return '{"value":null,"kind":null}';}).read("User");
    const check = `$tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object { $_.Message };exit 1}`;
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
    const result = spawnSync(powershell, ["-NoProfile","-NonInteractive","-Command",check], {input:script,encoding:"utf8",windowsHide:true});
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});

describe("PATH activation CLI option safety", () => {
  const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  for (const args of [["--user","--machine"],["--user","--file","unused.ps1"],["--machine","--remove","--file","unused.ps1"]]) {
    it(`rejects conflicting ${args.join(" ")} before installing shims or editing PATH`, () => {
      const home = mkdtempSync(path.join(os.tmpdir(), "npm-safe-path-options-"));
      try {
        const result = spawnSync(process.execPath, ["--import","tsx","src/cli/cli.ts","gate","shell",...args], {
          cwd:packageRoot,encoding:"utf8",env:{...process.env,HOME:home,USERPROFILE:home},windowsHide:true,
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /--user.*--machine.*--file/);
        assert.equal(existsSync(path.join(home,".npm-safe","bin")), false);
      } finally { rmSync(home,{recursive:true,force:true}); }
    });
  }
});
