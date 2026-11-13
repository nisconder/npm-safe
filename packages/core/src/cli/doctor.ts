import { Command } from "commander";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DatabaseManager } from "../index.js";
import { getDefaultDbPath } from "./shared.js";
import {
  getShimDir,
  detectShellConfig,
  hasShellBlock,
  readGateConfig,
} from "./install-gate.js";

/**
 * Run a diagnostic check, print the result, and count problems.
 */
function runCheck(
  ok: boolean,
  label: string,
  fix?: string,
  problems?: string[],
): void {
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${label}`);
  if (!ok) {
    if (fix) console.log(`      ${fix}`);
    problems?.push(label);
  }
}

/** Detect configuration only; a child process cannot inspect its parent's functions. */
function configuredPowerShellProfiles(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) return [];
  const detected = detectShellConfig();
  const candidates = new Set([
    path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"),
    path.join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    ...(detected?.toLowerCase().endsWith(".ps1") ? [detected] : []),
  ]);
  return [...candidates].filter((file) => {
    if (!hasShellBlock(file)) return false;
    try {
      const content = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      const blocks = content.matchAll(/^# >>> npm-safe gate >>>\n([\s\S]*?)^# <<< npm-safe gate <<</gm);
      return [...blocks].some((block) => ["npm", "pnpm", "yarn"].every((pm) => {
        const body = new RegExp(`^function ${pm} \\{\\n([\\s\\S]*?)\\n\\}`, "m").exec(block[1])?.[1];
        // Recognize the complete generated functions, not just marker comments
        // or an unrelated function with the same name elsewhere in the profile.
        return body !== undefined &&
          /^  \$npmSafePayload = \[Convert\]::ToBase64String\(/m.test(body) &&
          new RegExp(`^  & .+runGateShim\\(.+ '${pm}' \\$npmSafePayload$`, "m").test(body);
      }));
    } catch {
      return false;
    }
  });
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose the npm-safe installation and install-gate setup")
    .action(async () => {
      const opts = program.opts<{ db?: string; proxy?: string }>();
      const problems: string[] = [];
      const normalizePath = (value: string): string => {
        let resolved = path.resolve(value.replace(/^"(.*)"$/, "$1"));
        try {
          // `where` expands Windows short paths, and PATH may contain links.
          resolved = fs.realpathSync.native(resolved);
        } catch {
          // Missing PATH entries can still be reported using their spelling.
        }
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      };
      const pathParts = (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter((p) => p.length > 0)
        .map(normalizePath);

      console.log("npm-safe doctor");
      console.log(`  CLI: npm-safe (Node ${process.version})`);

      // 1. npm global bin directory reachable from PATH.
      const globalBin = getNpmGlobalBin();
      const globalBinInPath =
        globalBin !== null && pathParts.includes(normalizePath(globalBin));
      runCheck(
        globalBinInPath,
        `npm global bin in PATH: ${globalBin ?? "(not detected)"}`,
        globalBin
          ? `Add ${globalBin} to PATH, then reopen the terminal`
          : "Cannot locate the npm global bin directory",
        problems,
      );

      // 2. Install gate switch.
      let dbPath = opts.db;
      try {
        dbPath ??= getDefaultDbPath();
        const config = await readGateConfig(dbPath, opts.proxy);
        runCheck(
          config.enabled,
          `Install gate: ${config.enabled ? "enabled" : "disabled"} (threshold ${config.threshold})`,
          opts.db
            ? "Run: npm-safe gate enable (use the same --db option)"
            : "Run: npm-safe gate enable",
          problems,
        );
      } catch (err) {
        runCheck(
          false,
          `Install gate configuration could not be read: ${dbPath ?? "(default database)"}`,
          err instanceof Error ? err.message : String(err),
          problems,
        );
      }

      // 3. Shell wrappers / PATH shims.
      if (process.platform === "win32") {
        const profiles = configuredPowerShellProfiles();
        const powerShellConfigured = profiles.length > 0;
        if (powerShellConfigured) {
          runCheck(true, `PowerShell profile wrappers configured: ${profiles.join(", ")}`);
          console.log("      Reopen the corresponding PowerShell, then verify: (Get-Command npm).CommandType should be Function.");
          console.log("      Profile configuration does not verify functions in the current terminal; persistent PATH changes are not required for these wrappers.");
        }
        const checkCmd = (ok: boolean, label: string, limitation: string, fix: string): void => {
          if (!ok && powerShellConfigured) {
            console.log(`  i CMD only: ${limitation}`);
            console.log("      For CMD interception, optionally run: npm-safe gate shell --user, then reopen CMD.");
          } else {
            runCheck(ok, label, fix, problems);
          }
        };
        const shimDir = getShimDir();
        const shimsExist = ["npm", "pnpm", "yarn"].every((pm) =>
          fs.existsSync(path.join(shimDir, `${pm}.cmd`)),
        );
        checkCmd(
          shimsExist,
          `Command shims installed: ${shimDir}`,
          `Command shims are not installed: ${shimDir}`,
          "Run: npm-safe gate shell",
        );
        if (shimsExist) {
          const shimIndex = pathParts.indexOf(normalizePath(shimDir));
          checkCmd(
            shimIndex >= 0,
            "Shim directory present in PATH",
            "The shim directory is not in PATH; CMD commands are not intercepted.",
            "Run: npm-safe gate shell for PowerShell wrappers, or npm-safe gate shell --user for CMD PATH interception; then reopen the terminal",
          );
          if (shimIndex >= 0) {
            // Authoritative check: `where npm.cmd` must resolve to the shim
            // first (the directory-index comparison is fragile against
            // duplicate PATH entries and case/short-path variants).
            let first = "";
            try {
              first =
                execFileSync("where", ["npm.cmd"], { encoding: "utf8" })
                  .split(/\r?\n/)
                  .find((l) => l.trim().length > 0)?.trim() ?? "";
            } catch {
              first = "";
            }
            const shimFile = path.join(shimDir, "npm.cmd");
            const intercepted =
              first.length > 0 &&
              normalizePath(first) === normalizePath(shimFile);
            checkCmd(
              intercepted,
              "npm resolves to the gate shim first (gate intercepts)",
              "npm.cmd resolves ahead of the gate shim or could not be resolved; CMD interception is not verified.",
              "Run: npm-safe gate shell for PowerShell wrappers, or npm-safe gate shell --user to place the CMD shims first; then reopen the terminal",
            );
          }
        }
      } else {
        const rc = detectShellConfig();
        const installed = rc !== null && hasShellBlock(rc);
        runCheck(
          installed,
          `Shell wrappers installed: ${rc ?? "(no shell config detected)"}`,
          "Run: npm-safe gate shell",
          problems,
        );
      }

      // 4. Shared database is writable.
      try {
        dbPath ??= getDefaultDbPath();
        const dbm = new DatabaseManager(dbPath);
        try {
          // Opening an existing database does not prove it accepts writes.
          // Roll back the probe so diagnostics never change saved settings.
          const db = dbm.getDb();
          db.exec("SAVEPOINT npm_safe_doctor");
          try {
            db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
              .run("__npm_safe_doctor__", "write-test");
          } finally {
            db.exec("ROLLBACK TO npm_safe_doctor; RELEASE npm_safe_doctor");
          }
        } finally {
          dbm.close();
        }
        runCheck(true, `Database writable: ${dbPath}`, undefined, problems);
      } catch (err) {
        runCheck(
          false,
          `Database not writable: ${dbPath ?? "(default database)"}`,
          `Check permissions: ${err instanceof Error ? err.message : String(err)}`,
          problems,
        );
      }

      if (problems.length > 0) {
        console.log(`\n${problems.length} problem(s) found:`);
        for (const p of problems) console.log(`  - ${p}`);
        process.exitCode = 1;
      } else {
        console.log("\nEverything looks good.");
      }
    });
}

/** Locate the npm global bin directory (e.g. %APPDATA%\npm on Windows). */
function getNpmGlobalBin(): string | null {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, "npm") : null;
  }
  try {
    const out = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();
    return out ? path.join(out, "bin") : null;
  } catch {
    return null;
  }
}
